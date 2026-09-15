// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Items identity constraint — NULLS NOT DISTINCT
 *
 * Data-integrity gate. The (itemNumber, revision, designId, itemType) unique
 * constraint is the identity of an item version — and under SQL's default
 * rule two NULLs compare distinct, so for every design-less item type
 * (WorkOrder, Tool, PhysicalPart, Task, Issue, ChangeOrder) the constraint
 * never fired at all. Two rows could carry the same WO-000123 identity and
 * every lookup by number silently picked one.
 *
 * These tests pin the tightened constraint from both sides: NULL design
 * collisions are now real, and the legitimate multiplicities (same number in
 * different designs; new revisions of one master) still insert.
 *
 * Run: npx vitest run packages/core/src/lib/db/items-identity.test.ts
 */

import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { designs, items, programs } from '@/lib/db/schema'
import {
  UNIQUE_VIOLATION,
  asPostgresError,
  constraintOf,
} from '@/lib/errors/pg'
import { takeFirst } from '@/lib/db/take-first'

const IDENTITY_CONSTRAINT =
  'items_item_number_revision_design_id_item_type_unique'

describe('items identity constraint (NULLS NOT DISTINCT)', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let unique: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function itemRow(overrides: Partial<typeof items.$inferInsert> = {}) {
    return {
      itemNumber: `WO-${unique}`,
      itemType: 'WorkOrder',
      revision: '-',
      name: 'Identity fixture',
      state: 'Draft',
      masterId: randomUUID(),
      designId: null,
      isCurrent: true,
      createdBy: user.id,
      modifiedBy: user.id,
      ...overrides,
    }
  }

  it('rejects a second design-less row with the same identity', async () => {
    await testDb.db.insert(items).values(itemRow())

    let caught: unknown
    try {
      await testDb.db.insert(items).values(itemRow())
    } catch (error) {
      caught = error
    }

    // The violation, from the identity constraint specifically — before
    // NULLS NOT DISTINCT this insert quietly succeeded and the system held
    // two items answering to one number.
    expect(caught).toBeDefined()
    const pgError = asPostgresError(caught)
    expect(pgError?.code).toBe(UNIQUE_VIOLATION)
    expect(constraintOf(pgError!)).toBe(IDENTITY_CONSTRAINT)
  })

  it('still allows the same identity in two different designs', async () => {
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({ name: 'P', code: `PRG-${unique}`, createdBy: user.id })
        .returning(),
    )
    const [designA, designB] = await testDb.db
      .insert(designs)
      .values([
        {
          programId: program.id,
          name: 'A',
          code: `DA-${unique}`,
          createdBy: user.id,
        },
        {
          programId: program.id,
          name: 'B',
          code: `DB-${unique}`,
          createdBy: user.id,
        },
      ])
      .returning()

    await testDb.db
      .insert(items)
      .values(itemRow({ itemType: 'Part', designId: designA!.id }))
    // Same number, same revision, same type — different design. The usage
    // pattern the constraint deliberately allows.
    await testDb.db
      .insert(items)
      .values(itemRow({ itemType: 'Part', designId: designB!.id }))

    const rows = await testDb.db.select().from(items)
    expect(rows.filter((r) => r.itemNumber === `WO-${unique}`).length).toBe(2)
  })

  it('still allows a new revision of the same design-less master', async () => {
    const masterId = randomUUID()
    await testDb.db.insert(items).values(itemRow({ masterId, revision: 'A' }))
    await testDb.db
      .insert(items)
      .values(itemRow({ masterId, revision: 'B', isCurrent: true }))

    const rows = await testDb.db.select().from(items)
    expect(rows.filter((r) => r.itemNumber === `WO-${unique}`).length).toBe(2)
  })
})
