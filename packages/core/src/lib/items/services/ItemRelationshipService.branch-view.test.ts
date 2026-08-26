// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Branch-context relationship reads.
 *
 * What an ECO branch SHOWS for an item's structure must be what releasing
 * that branch would PRODUCE (ChangeOrderMergeService step 5b): the working
 * copy's own edges, nothing else. The union this read used to return
 * resurrected every line deleted on the branch — as a row owned by the
 * released main version, which branch protection then (correctly) refused to
 * modify when the user tried to delete it a second time.
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
import { and, eq, inArray } from 'drizzle-orm'
import { ItemService } from './ItemService'
import { ItemRelationshipService } from './ItemRelationshipService'
import { ChangeOrderService } from './ChangeOrderService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  itemRelationships,
  items,
  programs,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('ItemRelationshipService.getRelationshipsWithDetailsForBranch', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `T${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Test Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(suffix: string) {
    return ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Test Part ${suffix}`,
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
  }

  async function createEco() {
    return ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Test ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )
  }

  /**
   * A released assembly with two BOM lines, revised on a fresh ECO branch.
   * The working copy is created carrying both lines; main keeps its own rows
   * and its branch tracking, as a real release leaves them.
   */
  async function reviseReleasedAssembly() {
    const parent = await createPart('ASM')
    const childA = await createPart('CHA')
    const childB = await createPart('CHB')
    await ItemService.addRelationship(parent.id, childA.id, 'BOM', user.id, {
      quantity: '2',
    })
    await ItemService.addRelationship(parent.id, childB.id, 'BOM', user.id, {
      quantity: '4',
    })

    await testDb.db
      .update(items)
      .set({ state: 'Released' })
      .where(inArray(items.id, [parent.id, childA.id, childB.id]))

    // The main-branch tracking rows a release leaves behind — the read
    // resolves the main version of the item through them.
    const mainBranch = await BranchService.getMainBranch(designId)
    await testDb.db.insert(branchItems).values(
      [parent, childA, childB].map((item) => ({
        branchId: mainBranch!.id,
        itemMasterId: item.masterId,
        currentItemId: item.id,
      })),
    )

    const eco = await createEco()
    const { branchItem, branch } = await ChangeOrderService.checkoutItemToEco(
      eco.id,
      parent.id,
      user.id,
    )

    return {
      parent,
      childA,
      childB,
      eco,
      branch,
      workingCopyId: branchItem.currentItemId!,
    }
  }

  it('reads the working copy structure, with its quantities, on the branch', async () => {
    const { childA, childB, branch, workingCopyId } =
      await reviseReleasedAssembly()

    const rows =
      await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
        workingCopyId,
        branch.id,
        'BOM',
      )

    expect(rows).toHaveLength(2)
    const byNumber = new Map(rows.map((r) => [r.targetItem?.itemNumber, r]))
    expect(parseFloat(byNumber.get(childA.itemNumber)?.quantity ?? '')).toBe(2)
    expect(parseFloat(byNumber.get(childB.itemNumber)?.quantity ?? '')).toBe(4)
    // Every row is owned by the working copy, so the branch may edit it.
    for (const row of rows) {
      expect(row.sourceId).toBe(workingCopyId)
    }
  })

  it('does not resurrect a line deleted on the branch', async () => {
    const { parent, childA, childB, branch, workingCopyId } =
      await reviseReleasedAssembly()

    const edge = takeFirst(
      await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, workingCopyId),
            eq(itemRelationships.targetId, childA.id),
          ),
        ),
    )
    await ItemService.removeRelationship(edge.id, user.id)

    const rows =
      await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
        workingCopyId,
        branch.id,
        'BOM',
      )

    // The deleted line is gone, not refilled from the released structure...
    expect(rows.map((r) => r.targetItem?.itemNumber)).toEqual([
      childB.itemNumber,
    ])
    // ...and no returned row is owned by the released main version. The
    // resurrected row was, and deleting it tripped BRANCH_PROTECTED.
    for (const row of rows) {
      expect(row.sourceId).toBe(workingCopyId)
    }

    // Main's released structure is untouched by the branch edit.
    const mainRows = await ItemService.getRelationshipsWithDetails(
      parent.id,
      'BOM',
    )
    expect(mainRows).toHaveLength(2)
  })

  it('shows an emptied structure as empty, not refilled from main', async () => {
    const { parent, branch, workingCopyId } = await reviseReleasedAssembly()

    // Delete every line on the branch — an intentionally emptied structure,
    // removed through the audited path a user's deletes take.
    const edges = await testDb.db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, workingCopyId))
    for (const edge of edges) {
      await ItemService.removeRelationship(edge.id, user.id)
    }

    const rows =
      await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
        workingCopyId,
        branch.id,
        'BOM',
      )

    expect(rows).toHaveLength(0)

    // Main's released structure is untouched by the branch edit.
    const mainRows = await ItemService.getRelationshipsWithDetails(
      parent.id,
      'BOM',
    )
    expect(mainRows).toHaveLength(2)
  })

  it('resolves targets to their ECO versions when the child is also on the branch', async () => {
    const { childA, eco, branch, workingCopyId } =
      await reviseReleasedAssembly()

    const { branchItem: childBranchItem } =
      await ChangeOrderService.checkoutItemToEco(eco.id, childA.id, user.id)
    const childWorkingCopyId = childBranchItem.currentItemId!
    expect(childWorkingCopyId).not.toBe(childA.id)

    const rows =
      await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
        workingCopyId,
        branch.id,
        'BOM',
      )

    const childRow = rows.find(
      (r) => r.targetItem?.itemNumber === childA.itemNumber,
    )
    expect(childRow?.targetId).toBe(childWorkingCopyId)
    expect(childRow?.targetItem?.id).toBe(childWorkingCopyId)
  })
})
