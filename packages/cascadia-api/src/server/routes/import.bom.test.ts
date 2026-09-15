// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Part import — what a failed row is allowed to say
 *
 * This handler reports per-row and per-relationship failures inside a 207 that
 * a person reads, and it built those strings from `error.message`. For
 * anything the service layer did not classify that message is the driver's:
 * the whole INSERT, its column list, and every bound parameter. The two
 * commonest mistakes in a spreadsheet — an item number twice, a child listed
 * twice under one parent — both took that path. Invariants:
 *
 *   - no import response carries query text, under any failure
 *   - a repeated item number is named as such, by number
 *   - a repeated BOM line is named by both item numbers, and the line that
 *     was accepted still stands
 *
 * Run: npx vitest run src/server/routes/import.bom.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import importRoutes from './import'
import { validateBomStructure } from '@/lib/import'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { DesignService } from '@/lib/services/DesignService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { itemRelationships, programMembers, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ImportBody {
  data: {
    result: {
      successCount: number
      errorCount: number
      createdItems: Array<{ itemId: string; itemNumber: string }>
      failedRows: Array<{ rowNumber: number; errors: Array<string> }>
      relationshipsCreated: number
      relationshipsFailed: number
      failedRelationships: Array<{
        parentItemNumber: string
        childItemNumber: string
        error: string
      }>
    }
  }
}

/** Anything that would mean the driver's exception reached the caller. */
function expectNoQueryText(raw: string) {
  expect(raw).not.toContain('Failed query')
  expect(raw).not.toContain('insert into')
  expect(raw).not.toContain('params:')
}

describe('part import', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/import', importRoutes)

  let cookie: string
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // The permission cache is process-global; users are new each test.
    permissionService.clearCache()

    const user = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Import Program',
          code: `IMP-${Date.now()}`,
          createdBy: user.id,
        })
        .returning(),
    )
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: user.id,
      role: 'engineer',
    })

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Import Design',
        code: `IMPD-${Date.now()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
    cookie = `session=${(await SessionManager.createSession(user.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function importParts(body: Record<string, unknown>) {
    return app.request('/api/v1/import/parts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ designId, ...body }),
    })
  }

  function part(itemNumber: string, name = itemNumber) {
    return { name, itemNumber, partType: 'Manufacture' as const }
  }

  it('names a repeated item number instead of quoting the insert', async () => {
    const response = await importParts({
      rows: [part('ASM-1', 'Assembly'), part('ASM-1', 'Assembly again')],
    })

    const raw = await response.text()
    expectNoQueryText(raw)

    const { data } = JSON.parse(raw) as ImportBody
    expect(data.result.successCount).toBe(1)
    expect(data.result.failedRows).toHaveLength(1)
    expect(data.result.failedRows[0]?.rowNumber).toBe(3)
    expect(data.result.failedRows[0]?.errors[0]).toContain('ASM-1')
    expect(data.result.failedRows[0]?.errors[0]).toContain('already exists')
  })

  it('rejects the second line for a child, keeping the first', async () => {
    const response = await importParts({
      rows: [part('ASM-1', 'Assembly'), part('SCR-1', 'Screw')],
      bomRelationships: [
        {
          parentItemNumber: 'ASM-1',
          childItemNumber: 'SCR-1',
          quantity: 4,
          findNumber: 10,
        },
        {
          parentItemNumber: 'ASM-1',
          childItemNumber: 'SCR-1',
          quantity: 12,
          findNumber: 20,
        },
      ],
    })

    const raw = await response.text()
    expectNoQueryText(raw)

    const { result } = (JSON.parse(raw) as ImportBody).data
    expect(result.relationshipsCreated).toBe(1)
    expect(result.relationshipsFailed).toBe(1)

    // Named by the numbers the caller uploaded, not by item ids they never saw.
    const failure = result.failedRelationships[0]
    expect(failure?.parentItemNumber).toBe('ASM-1')
    expect(failure?.childItemNumber).toBe('SCR-1')
    expect(failure?.error).toContain('ASM-1')
    expect(failure?.error).toContain('SCR-1')

    // The accepted line stands, with its own quantity.
    const assembly = result.createdItems.find((i) => i.itemNumber === 'ASM-1')!
    const stored = await testDb.db
      .select({
        targetId: itemRelationships.targetId,
        quantity: itemRelationships.quantity,
      })
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, assembly.itemId))
    expect(stored).toHaveLength(1)
    // Decimal(10,3) round-trips as '4.000'; what matters is that it is the
    // quantity from the line that was accepted, not the one that was not.
    expect(Number(stored[0]?.quantity)).toBe(4)
  })

  it('names an edge that a previous import already created', async () => {
    await importParts({
      rows: [part('ASM-1', 'Assembly'), part('SCR-1', 'Screw')],
      bomRelationships: [
        { parentItemNumber: 'ASM-1', childItemNumber: 'SCR-1', quantity: 4 },
      ],
    })

    // A later import adds a part and re-states a link that already exists.
    const response = await importParts({
      rows: [part('BRK-1', 'Bracket')],
      bomRelationships: [
        { parentItemNumber: 'ASM-1', childItemNumber: 'SCR-1', quantity: 4 },
      ],
    })

    const raw = await response.text()
    expectNoQueryText(raw)

    const { result } = (JSON.parse(raw) as ImportBody).data
    expect(result.relationshipsFailed).toBe(1)
    const failure = result.failedRelationships[0]
    expect(failure?.error).toContain('ASM-1')
    expect(failure?.error).toContain('SCR-1')
    // The service names it by item id; that must not be what surfaces here.
    expect(failure?.error).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('flags the repeated child in the preview, before anything is uploaded', () => {
    const { errors } = validateBomStructure([
      {
        parentItemNumber: 'ASM-1',
        childItemNumber: 'SCR-1',
        quantity: 4,
        parentRowIndex: 0,
        childRowIndex: 1,
      },
      {
        parentItemNumber: 'ASM-1',
        childItemNumber: 'SCR-1',
        quantity: 12,
        parentRowIndex: 0,
        childRowIndex: 1,
      },
    ])

    const duplicate = errors.find((e) => e.type === 'duplicate_relationship')
    expect(duplicate).toBeDefined()
    expect(duplicate?.message).toContain('ASM-1')
    expect(duplicate?.message).toContain('SCR-1')
  })
})
