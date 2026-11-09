// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Part import — what a failed row is allowed to say, and where a stopped run
 * leaves the design
 *
 * The import reports per-row and per-relationship failures in a result that
 * a person reads, and it built those strings from `error.message`. For
 * anything the service layer did not classify that message is the driver's:
 * the whole INSERT, its column list, and every bound parameter. The two
 * commonest mistakes in a spreadsheet — an item number twice, a child listed
 * twice under one parent — both took that path. Invariants:
 *
 *   - no import result carries query text, under any failure
 *   - a repeated item number is named as such, by number
 *   - a repeated BOM line is named by both item numbers, and the line that
 *     was accepted still stands
 *   - a run whose signal aborts stops between rows: the rows it wrote stay
 *     written, and no row after the abort is
 *
 * The import runs on the jobs worker (`POST /api/v1/import/parts` only
 * authorizes and queues it), so these call `ImportService` the way the
 * worker's handler does. The route's own gates are in
 * `server/routes/import.permissions.test.ts`.
 *
 * Run: npx vitest run cascadia-api/src/import/ImportService.bom.test.ts
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
import { eq } from 'drizzle-orm'
import {
  importPartsWithBomRequestSchema,
  validateBomStructure,
} from '@cascadia/commons/import'
import { ImportService } from './ImportService'
import type { BomImportResult } from '@cascadia/commons/import'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { DesignService } from '@/services/DesignService'
import { itemRelationships, items, programMembers, programs } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

// Import to register item types
import '@/items/registerItemTypes.server'

/** Anything that would mean the driver's exception reached the caller. */
function expectNoQueryText(result: BomImportResult) {
  const raw = JSON.stringify(result)
  expect(raw).not.toContain('Failed query')
  expect(raw).not.toContain('insert into')
  expect(raw).not.toContain('params:')
}

describe('part import', () => {
  const testDb = new TestDatabase()

  let userId: string
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    const user = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    userId = user.id
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
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** The request exactly as the route would have parsed it, defaults applied. */
  function importParts(
    body: Record<string, unknown>,
    options?: Parameters<typeof ImportService.importParts>[2],
  ) {
    return ImportService.importParts(
      importPartsWithBomRequestSchema.parse({ designId, ...body }),
      userId,
      options,
    )
  }

  function part(itemNumber: string, name = itemNumber) {
    return { name, itemNumber, partType: 'Manufacture' as const }
  }

  it('names a repeated item number instead of quoting the insert', async () => {
    const result = await importParts({
      rows: [part('ASM-1', 'Assembly'), part('ASM-1', 'Assembly again')],
    })

    expectNoQueryText(result)
    expect(result.successCount).toBe(1)
    expect(result.failedRows).toHaveLength(1)
    expect(result.failedRows[0]?.rowNumber).toBe(3)
    expect(result.failedRows[0]?.errors[0]).toContain('ASM-1')
    expect(result.failedRows[0]?.errors[0]).toContain('already exists')
  })

  it('rejects the second line for a child, keeping the first', async () => {
    const result = await importParts({
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

    expectNoQueryText(result)
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
    const result = await importParts({
      rows: [part('BRK-1', 'Bracket')],
      bomRelationships: [
        { parentItemNumber: 'ASM-1', childItemNumber: 'SCR-1', quantity: 4 },
      ],
    })

    expectNoQueryText(result)
    expect(result.relationshipsFailed).toBe(1)
    const failure = result.failedRelationships[0]
    expect(failure?.error).toContain('ASM-1')
    expect(failure?.error).toContain('SCR-1')
    // The service names it by item id; that must not be what surfaces here.
    expect(failure?.error).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('stops between rows when its signal aborts, keeping what it wrote', async () => {
    // The worker aborts on a timeout or a cancel. Rows are not undone — each
    // is its own transaction and commit — so the invariant is that the run
    // stops promptly and the design holds exactly the rows written before.
    const controller = new AbortController()
    const run = importParts(
      { rows: [part('P-1'), part('P-2'), part('P-3'), part('P-4')] },
      {
        signal: controller.signal,
        onProgress: ({ done }) => {
          if (done === 2) controller.abort(new Error('Job was cancelled'))
          return Promise.resolve()
        },
      },
    )

    await expect(run).rejects.toThrow('Job was cancelled')

    const written = await testDb.db
      .select({ itemNumber: items.itemNumber })
      .from(items)
      .where(eq(items.designId, designId))
    expect(written.map((row) => row.itemNumber).sort()).toEqual(['P-1', 'P-2'])
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
