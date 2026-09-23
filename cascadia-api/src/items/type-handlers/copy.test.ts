// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * copyTypeSpecificData Tests
 *
 * Carrying an item's type-specific content from one version to the next is
 * gate 1: if a field silently fails to copy, the new revision ships with
 * engineering data missing and nothing reports it. The two hand-written copies
 * this replaced had each already drifted from the schema, in opposite
 * directions, which is exactly the failure these tests exist to catch.
 *
 * Run: npm run test -- src/lib/items/type-handlers/copy.test.ts
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
import { eq } from 'drizzle-orm'
import { copyTypeSpecificData } from './copy'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  items,
  parts,
  software,
  softwareManifests,
  workInstructionOperations,
  workInstructionSteps,
  workInstructions,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

import '@/lib/items/registerItemTypes.server'

describe('copyTypeSpecificData', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `C${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** A bare item row — enough to hang an extension row off. */
  async function createItemRow(itemType: string, suffix: string) {
    return takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: randomUUID(),
          itemNumber: `${itemType}-${uniquePrefix}-${suffix}`,
          revision: 'A',
          itemType,
          name: `${itemType} ${suffix}`,
          state: 'Draft',
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
  }

  it('copies every column of the extension row, not a remembered subset', async () => {
    const source = await createItemRow('Part', 'SRC')
    const target = await createItemRow('Part', 'TGT')

    // Deliberately spans columns a hand-written copy once forgot
    // (trackingMode), plus every remaining nullable column.
    const sourceValues = {
      itemId: source.id,
      description: 'Bracket, machined',
      partType: 'Manufacture',
      trackingMode: 'serial',
      material: '6061-T6',
      weight: '1.250',
      weightUnit: 'kg',
      cost: '42.50',
      costCurrency: 'USD',
      leadTimeDays: 14,
    }
    await testDb.db.insert(parts).values(sourceValues)

    await copyTypeSpecificData('Part', source.id, target.id)

    const sourceRow = takeFirst(
      await testDb.db.select().from(parts).where(eq(parts.itemId, source.id)),
    )
    const copied = takeFirst(
      await testDb.db.select().from(parts).where(eq(parts.itemId, target.id)),
    )

    // Whole-row equality, not a named-field list. Any column that fails to
    // copy fails here, including columns added to the table after this was
    // written — which is the drift the old hand-written switches suffered.
    expect({ ...copied, itemId: source.id }).toEqual(sourceRow)
    expect(copied.itemId).toBe(target.id)
  })

  it('never carries a software draft manifest to the new version', async () => {
    const source = await createItemRow('Software', 'SRC')
    const target = await createItemRow('Software', 'TGT')

    const committed = takeFirst(
      await testDb.db
        .insert(softwareManifests)
        .values({ entries: [], fileCount: 0, totalSize: 0, createdBy: user.id })
        .returning(),
    )
    const draft = takeFirst(
      await testDb.db
        .insert(softwareManifests)
        .values({ entries: [], fileCount: 0, totalSize: 0, createdBy: user.id })
        .returning(),
    )

    await testDb.db.insert(software).values({
      itemId: source.id,
      description: 'Flight controller firmware',
      softwareType: 'Firmware',
      version: '2.1.0',
      manifestId: committed.id,
      draftManifestId: draft.id,
    })

    await copyTypeSpecificData('Software', source.id, target.id)

    const copied = takeFirst(
      await testDb.db
        .select()
        .from(software)
        .where(eq(software.itemId, target.id)),
    )

    // The committed tree carries over; the in-progress edits do not.
    expect(copied.manifestId).toBe(committed.id)
    expect(copied.draftManifestId).toBeNull()
    expect(copied.version).toBe('2.1.0')
  })

  it('copies work instruction children and remaps steps onto the new operations', async () => {
    const source = await createItemRow('WorkInstruction', 'SRC')
    const target = await createItemRow('WorkInstruction', 'TGT')

    await testDb.db
      .insert(workInstructions)
      .values({ itemId: source.id, description: 'Assemble the gearbox' })

    const opOne = takeFirst(
      await testDb.db
        .insert(workInstructionOperations)
        .values({
          workInstructionId: source.id,
          orderIndex: 1,
          title: 'Press the bearings',
        })
        .returning(),
    )
    const opTwo = takeFirst(
      await testDb.db
        .insert(workInstructionOperations)
        .values({
          workInstructionId: source.id,
          orderIndex: 2,
          title: 'Torque the housing',
        })
        .returning(),
    )

    await testDb.db.insert(workInstructionSteps).values([
      {
        workInstructionId: source.id,
        operationId: opOne.id,
        orderIndex: 1,
        title: 'Chill the bearing',
      },
      {
        workInstructionId: source.id,
        operationId: opTwo.id,
        orderIndex: 2,
        title: 'Torque to 40 Nm',
      },
    ])

    await copyTypeSpecificData('WorkInstruction', source.id, target.id)

    const copiedOps = await testDb.db
      .select()
      .from(workInstructionOperations)
      .where(eq(workInstructionOperations.workInstructionId, target.id))
    const copiedSteps = await testDb.db
      .select()
      .from(workInstructionSteps)
      .where(eq(workInstructionSteps.workInstructionId, target.id))

    expect(copiedOps.map((o) => o.title).sort()).toEqual(
      ['Press the bearings', 'Torque the housing'].sort(),
    )
    expect(copiedSteps).toHaveLength(2)

    // The point of the remap: a copied step must point at the *copy* of its
    // operation. Pointing back at the source version's operation would tie the
    // new revision's content to the old one.
    const sourceOpIds = new Set([opOne.id, opTwo.id])
    const newOpIds = new Set(copiedOps.map((o) => o.id))
    for (const step of copiedSteps) {
      expect(step.operationId).not.toBeNull()
      expect(sourceOpIds.has(step.operationId!)).toBe(false)
      expect(newOpIds.has(step.operationId!)).toBe(true)
    }

    const chill = copiedSteps.find((s) => s.title === 'Chill the bearing')
    const press = copiedOps.find((o) => o.title === 'Press the bearings')
    expect(chill?.operationId).toBe(press?.id)
  })

  it('is a no-op for an unregistered item type', async () => {
    const source = await createItemRow('Part', 'SRC')
    const target = await createItemRow('Part', 'TGT')

    await expect(
      copyTypeSpecificData('NotARealType', source.id, target.id),
    ).resolves.toBeUndefined()
  })
})
