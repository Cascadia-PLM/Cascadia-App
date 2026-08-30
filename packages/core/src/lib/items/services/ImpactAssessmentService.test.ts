// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ImpactAssessmentService Tests
 *
 * Covers the where-used traversal's branch context: impact analysis has to
 * answer about the structure a change order is proposing, not the one it
 * started from.
 *
 * Run: npm run test -- src/lib/items/services/ImpactAssessmentService.test.ts
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
import { ImpactAssessmentService } from './ImpactAssessmentService'
import { ItemService } from './ItemService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import {
  branchItems,
  itemRelationships,
  items,
  programs,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

import '@/lib/items/registerItemTypes.server'

describe('ImpactAssessmentService where-used branch context', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  // The user/program/design fixtures are created INSIDE the gate transaction so
  // they roll back with it. Anything written from beforeAll autocommits on the
  // pool and leaks permanently — nothing truncates the test database.
  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `IMP${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          code: `PGM-${uniquePrefix}`,
          name: 'Impact Program',
          createdBy: user.id,
        })
        .returning(),
    )

    const design = await DesignService.create(
      {
        code: `DSN-${uniquePrefix}`,
        name: 'Impact Design',
        programId: program.id,
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
        name: `Part ${suffix}`,
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
  }

  async function createEcoBranch() {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Impact ECO',
        changeType: 'ECO',
        priority: 'medium',
      } as any,
      user.id,
    )
    const { branch } = await BranchService.getOrCreateEcoBranch(
      designId,
      eco.id,
      user.id,
    )
    return branch
  }

  it('sees a BOM line the branch added', async () => {
    const child = await createPart('child')
    const parent = await createPart('parent')
    const branch = await createEcoBranch()

    // On main the parent has no children at all
    const beforeBranch = await ImpactAssessmentService.findWhereUsed(child.id)
    expect(beforeBranch).toHaveLength(0)

    // The branch's working copy of the parent uses the child
    const workingParent = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: parent.masterId!,
          designId,
          itemNumber: parent.itemNumber!,
          revision: `-${branch.id.substring(0, 8)}`,
          itemType: 'Part',
          name: parent.name,
          state: 'Draft',
          isCurrent: false,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    await testDb.db.insert(itemRelationships).values({
      sourceId: workingParent.id,
      targetId: child.id!,
      relationshipType: 'BOM',
      quantity: '1',
      createdBy: user.id,
    })
    await testDb.db.insert(branchItems).values({
      branchId: branch.id,
      itemMasterId: parent.masterId!,
      currentItemId: workingParent.id,
      baseItemId: parent.id,
      changeType: 'modified',
    })

    // Without the branch context the traversal still reads main and reports
    // nothing — which is what impact analysis used to do for every change order
    const stillMain = await ImpactAssessmentService.findWhereUsed(child.id)
    expect(stillMain).toHaveLength(0)

    const onBranch = await ImpactAssessmentService.findWhereUsed(child.id, {
      branchIds: [branch.id],
    })
    expect(onBranch).toHaveLength(1)
    expect(onBranch[0]?.itemId).toBe(workingParent.id)
  })

  it('does not report a BOM line the branch deleted', async () => {
    const child = await createPart('del-child')
    const parent = await createPart('del-parent')
    await testDb.db.insert(itemRelationships).values({
      sourceId: parent.id!,
      targetId: child.id!,
      relationshipType: 'BOM',
      quantity: '1',
      createdBy: user.id,
    })

    const branch = await createEcoBranch()

    // Main still uses it
    expect(await ImpactAssessmentService.findWhereUsed(child.id)).toHaveLength(
      1,
    )

    // The branch deletes the parent outright
    await testDb.db.insert(branchItems).values({
      branchId: branch.id,
      itemMasterId: parent.masterId!,
      currentItemId: parent.id,
      baseItemId: parent.id,
      changeType: 'deleted',
    })

    const onBranch = await ImpactAssessmentService.findWhereUsed(child.id, {
      branchIds: [branch.id],
    })
    expect(onBranch).toHaveLength(0)
  })

  it('falls back to main for masters the branch does not touch', async () => {
    const child = await createPart('keep-child')
    const parent = await createPart('keep-parent')
    await testDb.db.insert(itemRelationships).values({
      sourceId: parent.id!,
      targetId: child.id!,
      relationshipType: 'BOM',
      quantity: '1',
      createdBy: user.id,
    })

    const branch = await createEcoBranch()
    const unrelated = await createPart('unrelated')
    await testDb.db.insert(branchItems).values({
      branchId: branch.id,
      itemMasterId: unrelated.masterId!,
      currentItemId: unrelated.id,
      baseItemId: unrelated.id,
      changeType: 'modified',
    })

    // The overlay must not hide everything it does not override
    const onBranch = await ImpactAssessmentService.findWhereUsed(child.id, {
      branchIds: [branch.id],
    })
    expect(onBranch).toHaveLength(1)
    expect(onBranch[0]?.itemId).toBe(parent.id)
  })

  it('walks multiple levels through the branch overlay', async () => {
    const leaf = await createPart('leaf')
    const mid = await createPart('mid')
    const top = await createPart('top')
    await testDb.db.insert(itemRelationships).values([
      {
        sourceId: mid.id!,
        targetId: leaf.id!,
        relationshipType: 'BOM',
        quantity: '1',
        createdBy: user.id,
      },
      {
        sourceId: top.id!,
        targetId: mid.id!,
        relationshipType: 'BOM',
        quantity: '1',
        createdBy: user.id,
      },
    ])

    const branch = await createEcoBranch()
    const onBranch = await ImpactAssessmentService.findWhereUsed(leaf.id, {
      branchIds: [branch.id],
    })

    expect(onBranch.map((n) => n.depth).sort()).toEqual([1, 2])
  })
})
