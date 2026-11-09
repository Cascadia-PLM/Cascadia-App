// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Requirement import — a hierarchy in one sheet, and the round trip.
 *
 * Data-integrity gate: a child created before its parent, or linked to the
 * wrong one, is a hierarchy that silently disagrees with the sheet it came
 * from. Invariants pinned here:
 *
 *   - rows import in any order; every child's `parentRequirementId` names the
 *     row its sheet named, matched by number case-insensitively
 *   - a parent the design already holds is linked; one nobody holds fails the
 *     child alone, by number, and the rest of the sheet still imports
 *   - a loop and a self-parent are refused by row, and the rest still imports
 *   - a design's export imports into another design and exports identically
 *
 * The import runs on the jobs worker (`POST /api/v1/import/requirements`
 * only authorizes and queues it), so these call `ImportService` the way the
 * worker's handler does; the export is still the design route.
 *
 * Run: npx vitest run cascadia-api/src/import/ImportService.requirements.test.ts
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
import { eq, inArray } from 'drizzle-orm'
import {
  applyMappings,
  autoDetectMappings,
  importRequirementsRequestSchema,
  parseFile,
  validateRequirementHierarchy,
  validateRows,
} from '@cascadia/commons/import'
import { ImportService } from './ImportService'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import designRoutes from '@/server/routes/designs'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { DesignService } from '@/services/DesignService'
import { ItemService } from '@/items/services/ItemService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { items, programMembers, programs, requirements } from '@/db/schema'
import { takeFirst } from '@/db/take-first'
import '@/items/registerItemTypes.server'

describe('requirement import', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/designs', designRoutes)
  let cookie: string
  let userId: string
  let programId: string
  let designId: string
  let unique: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()
    unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const user = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    userId = user.id
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Import Program',
          code: `IMPR-${unique}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: user.id,
      role: 'engineer',
    })
    designId = await createDesign('A')
    cookie = `session=${(await SessionManager.createSession(user.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createDesign(suffix: string): Promise<string> {
    const design = await DesignService.create(
      {
        programId,
        name: `Import Design ${suffix}`,
        code: `IMPRD-${unique}-${suffix}`,
        designType: 'Engineering',
      },
      userId,
    )
    return design.id
  }

  /** The request exactly as the route would have parsed it, defaults applied. */
  function importRequirements(body: Record<string, unknown>) {
    return ImportService.importRequirements(
      importRequirementsRequestSchema.parse({ designId, ...body }),
      userId,
    )
  }

  const req = (
    itemNumber: string,
    name: string,
    parentItemNumber?: string,
    extra: Record<string, unknown> = {},
  ) => ({ itemNumber, name, parentItemNumber, ...extra })

  async function parentsOf(
    createdItems: Array<{ itemId: string; itemNumber: string }>,
  ): Promise<Map<string, string | null>> {
    const rows = await testDb.db
      .select({
        itemId: requirements.itemId,
        parentRequirementId: requirements.parentRequirementId,
      })
      .from(requirements)
      .where(
        inArray(
          requirements.itemId,
          createdItems.map((item) => item.itemId),
        ),
      )
    const numberById = new Map<string, string>()
    for (const item of createdItems)
      numberById.set(item.itemId, item.itemNumber)
    const parentById = new Map<string, string | null>()
    for (const row of rows) parentById.set(row.itemId, row.parentRequirementId)
    const parents = new Map<string, string | null>()
    for (const item of createdItems) {
      const parentId = parentById.get(item.itemId) ?? null
      parents.set(
        item.itemNumber,
        parentId ? (numberById.get(parentId) ?? parentId) : null,
      )
    }
    return parents
  }

  it('imports a hierarchy in any row order, parents by item number', async () => {
    const result = await importRequirements({
      rows: [
        req('REQ-1-D1', 'Child', 'REQ-1'),
        req('REQ-1', 'Parent'),
        req('REQ-1-D1-D1', 'Grandchild', 'req-1-d1 '),
        req('REQ-2', 'Another root'),
      ],
    })
    expect(result.successCount).toBe(4)
    expect(result.errorCount).toBe(0)
    expect(result.parentsLinked).toBe(2)

    const parents = await parentsOf(result.createdItems)
    expect(parents.get('REQ-1')).toBeNull()
    expect(parents.get('REQ-1-D1')).toBe('REQ-1')
    expect(parents.get('REQ-1-D1-D1')).toBe('REQ-1-D1')
    expect(parents.get('REQ-2')).toBeNull()
  })

  it('links a child to a parent the design already holds, and names one nobody holds', async () => {
    const existing = await ItemService.create<PersistedItem>(
      'Requirement',
      {
        itemNumber: `REQ-EXISTING-${unique}`,
        revision: '-',
        name: 'Already here',
        designId,
      } as PersistedItem,
      userId,
    )

    const result = await importRequirements({
      rows: [
        req('REQ-E-D1', 'Child of the existing one', existing.itemNumber),
        req('REQ-N-D1', 'Orphan', 'REQ-NOBODY'),
        req('REQ-3', 'Root'),
      ],
    })
    expect(result.successCount).toBe(2)
    expect(result.parentsLinked).toBe(1)
    expect(result.failedRows).toEqual([
      { rowNumber: 3, errors: ['Parent requirement not found: REQ-NOBODY'] },
    ])

    const [child] = await testDb.db
      .select({ parentRequirementId: requirements.parentRequirementId })
      .from(requirements)
      .innerJoin(items, eq(items.id, requirements.itemId))
      .where(eq(items.itemNumber, 'REQ-E-D1'))
    expect(child?.parentRequirementId).toBe(existing.id)
  })

  it('refuses a loop and a self-parent by row, and imports the rest', async () => {
    const result = await importRequirements({
      rows: [
        req('REQ-A', 'a', 'REQ-B'),
        req('REQ-B', 'b', 'REQ-A'),
        req('REQ-C', 'c', 'REQ-C'),
        req('REQ-C-D1', 'under c', 'REQ-C'),
        req('REQ-D', 'd'),
      ],
    })
    expect(result.successCount).toBe(1)
    expect(result.createdItems[0]?.itemNumber).toBe('REQ-D')
    expect(result.failedRows.map((row) => row.rowNumber)).toEqual([2, 3, 4, 5])
    expect(result.failedRows[0]?.errors[0]).toContain('loops back')
    expect(result.failedRows[2]?.errors[0]).toBe(
      'A requirement cannot be its own parent',
    )
    expect(result.failedRows[3]?.errors[0]).toBe(
      'Parent requirement on row 4 cannot be imported',
    )
  })

  it("round-trips a design's requirements through the exported sheet", async () => {
    const seeded = await importRequirements({
      rows: [
        req('REQ-10', 'Rated payload, 250 kg', undefined, {
          description: 'The cart shall carry 250 kg, "rated"',
          type: 'Performance',
          priority: 'MustHave',
          category: 'Performance',
          source: 'Product brief',
          acceptanceCriteria: 'Carries 250 kg with <= 5 mm deflection',
          verificationMethod: 'Test',
        }),
        req('REQ-10-D1', 'Deck deflection', 'REQ-10', {
          type: 'Performance',
          priority: 'ShouldHave',
          verificationMethod: 'Analysis',
        }),
        req('REQ-11', 'E-stop', undefined, { priority: 'MustHave' }),
      ],
    })
    expect(seeded.errorCount).toBe(0)

    const exported = await app.request(
      `/api/v1/designs/${designId}/requirements-export`,
      { headers: { Cookie: cookie } },
    )
    expect(exported.status).toBe(200)
    expect(exported.headers.get('Content-Type')).toContain('text/csv')
    const csv = await exported.text()
    expect(csv.split('\n')[0]).toBe(
      'Requirement Number,Title,Description,Type,Priority,Category,Source,Acceptance Criteria,Verification Method,Parent Requirement',
    )

    // The sheet back in, the way the wizard reads it: parsed, auto-mapped,
    // validated, the hierarchy checked — nothing to fix by hand.
    const parsed = await parseFile(
      new File([csv], 'requirements.csv', { type: 'text/csv' }),
    )
    const mappings = autoDetectMappings(parsed.headers, 'Requirement')
    expect(
      mappings.map((m) => m.targetField).filter((f) => f !== null),
    ).toHaveLength(10)
    const validated = validateRequirementHierarchy(
      validateRows(
        applyMappings(parsed.rows, mappings, {
          collectUnmappedAsAttributes: true,
        }),
        parsed.rows,
        'Requirement',
      ),
    )
    expect(validated.every((row) => row.isValid)).toBe(true)

    const targetDesignId = await createDesign('B')
    const imported = await ImportService.importRequirements(
      importRequirementsRequestSchema.parse({
        designId: targetDesignId,
        rows: validated.map((row) => ({
          ...row.mappedData,
          revision: '-',
        })),
      }),
      userId,
    )
    expect(imported.errorCount).toBe(0)
    expect(imported.successCount).toBe(3)
    expect(imported.parentsLinked).toBe(1)

    const exportedAgain = await app.request(
      `/api/v1/designs/${targetDesignId}/requirements-export`,
      { headers: { Cookie: cookie } },
    )
    expect(await exportedAgain.text()).toBe(csv)
  })
})
