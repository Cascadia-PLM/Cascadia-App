// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ChangeOrderStructureService Tests
 *
 * The BOM tree a change order shows for one design is graph traversal over
 * version-resolved items — the third gate. It had no tests while it lived
 * inside a route handler, because there was no seam to call.
 *
 * Run: npm run test -- src/lib/services/ChangeOrderStructureService.test.ts
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
import { and, eq, isNotNull } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import { BranchService } from './BranchService'
import { ChangeOrderMergeService } from './ChangeOrderMergeService'
import { CheckoutService } from './CheckoutService'
import { DesignService } from './DesignService'
import { ChangeOrderStructureService as ChangeOrderStructureService } from './ChangeOrderStructureService'
import type { BOMTreeNode } from './ChangeOrderStructureService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  items,
  lifecycleDefinitions,
  lifecycleInstances,
  programs,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
import { NotFoundError } from '@/lib/errors'

import '@/lib/items/registerItemTypes.server'

const CHANGE_ORDER_WORKFLOW_ID = '00000000-0000-4000-8000-000000000209'

describe('ChangeOrderStructureService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    // Releasing a change order is the only way to mint a second revision of a
    // part, which is the history the tree has to read back correctly.
    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: CHANGE_ORDER_WORKFLOW_ID,
        name: 'Test ECO Workflow - ChangeOrderStructure',
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            {
              id: 'Approved',
              name: 'Approved',
              isInitial: false,
              isFinal: false,
            },
            {
              id: 'Released',
              name: 'Released',
              isInitial: false,
              isFinal: true,
              finalKind: 'release',
            },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Approve',
              fromStateId: 'Draft',
              toStateId: 'Approved',
            },
            {
              id: 't2',
              name: 'Release',
              fromStateId: 'Approved',
              toStateId: 'Released',
            },
          ],
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
        lifecycleType: 'Driving',
      })
      .onConflictDoNothing()

    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    uniquePrefix = `S${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Structure Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id

    const design = await DesignService.create(
      {
        programId,
        name: 'Structure Test Design',
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

  async function createPart(suffix: string, itemType: string = 'Part') {
    return ItemService.create(
      itemType,
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

  async function addBom(
    parentId: string,
    childId: string,
    data?: { quantity?: string; findNumber?: number },
  ) {
    return ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      data,
      { bypassEditGuard: true },
    )
  }

  async function createChangeOrder() {
    return ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Structure Test ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )
  }

  /** A change order that can be carried all the way to a merge. */
  async function createReleasableChangeOrder() {
    const changeOrder = await createChangeOrder()
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: CHANGE_ORDER_WORKFLOW_ID,
      itemId: changeOrder.id,
      currentState: 'Draft',
    })
    return changeOrder
  }

  async function approveChangeOrder(changeOrderId: string) {
    const orderDesigns =
      await ChangeOrderService.getChangeOrderDesigns(changeOrderId)
    for (const orderDesign of orderDesigns) {
      if (!orderDesign.branchId) continue
      const branchRows = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, orderDesign.branchId),
            isNotNull(branchItems.changeType),
          ),
        )
      for (const row of branchRows) {
        await ChangeOrderService.registerBranchChange(
          orderDesign.branchId,
          row.itemMasterId,
          row.currentItemId,
          user.id,
        )
      }
    }
    await testDb.db
      .update(items)
      .set({ state: 'Approved' })
      .where(eq(items.id, changeOrderId))
    await testDb.db
      .update(lifecycleInstances)
      .set({ currentState: 'Approved' })
      .where(eq(lifecycleInstances.itemId, changeOrderId))
  }

  /** Every itemNumber in the tree, depth-first. */
  function flatten(nodes: Array<BOMTreeNode>): Array<string> {
    return nodes.flatMap((n) => [n.itemNumber, ...flatten(n.children ?? [])])
  }

  function findNode(
    nodes: Array<BOMTreeNode>,
    itemNumber: string,
  ): BOMTreeNode | undefined {
    for (const n of nodes) {
      if (n.itemNumber === itemNumber) return n
      const hit = findNode(n.children ?? [], itemNumber)
      if (hit) return hit
    }
    return undefined
  }

  it('throws NotFoundError for a design that does not exist', async () => {
    const changeOrder = await createChangeOrder()

    await expect(
      ChangeOrderStructureService.getDesignStructure(
        changeOrder.id,
        '00000000-0000-4000-8000-0000000000ff',
      ),
    ).rejects.toThrow(NotFoundError)
  })

  it('nests children under their parent and carries quantity and find number', async () => {
    const changeOrder = await createChangeOrder()
    const parent = await createPart('ASM')
    const childA = await createPart('CHILD-A')
    const childB = await createPart('CHILD-B')

    await addBom(parent.id, childA.id, { quantity: '3', findNumber: 10 })
    await addBom(parent.id, childB.id, { quantity: '1', findNumber: 20 })

    const result = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      designId,
    )

    // Only the assembly is a root — the children have a parent
    expect(result.roots.map((r) => r.itemNumber)).toEqual([parent.itemNumber])

    const root = result.roots[0]!
    expect(root.children?.map((c) => c.itemNumber).sort()).toEqual(
      [childA.itemNumber, childB.itemNumber].sort(),
    )

    const a = findNode(result.roots, childA.itemNumber)
    expect(a?.quantity).toBe(3)
    expect(a?.findNumber).toBe(10)
  })

  it('terminates on a cyclic BOM instead of recursing forever', async () => {
    const changeOrder = await createChangeOrder()
    const root = await createPart('CYC-ROOT')
    const a = await createPart('CYC-A')
    const b = await createPart('CYC-B')

    // root -> a -> b -> a: a reachable root feeding a genuine loop, so the
    // traversal has to walk into the cycle rather than never entering it.
    await addBom(root.id, a.id)
    await addBom(a.id, b.id)
    await addBom(b.id, a.id)

    const result = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      designId,
    )

    expect(result.roots.map((r) => r.itemNumber)).toEqual([root.itemNumber])

    // Terminating is the point, but a vacuous tree would also terminate:
    // pin that the cycle was actually entered and then cut.
    const walked = flatten(result.roots)
    expect(walked).toContain(a.itemNumber)
    expect(walked).toContain(b.itemNumber)
    expect(walked.length).toBe(new Set(walked).size)
  })

  it('reports non-structural items as orphans rather than tree roots', async () => {
    const changeOrder = await createChangeOrder()
    const structural = await createPart('IN-BOM')
    const excluded = await createPart('OUT-OF-BOM')

    await testDb.db
      .update(items)
      .set({ inDesignStructure: false })
      .where(eq(items.id, excluded.id))

    const result = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      designId,
    )

    expect(result.roots.map((r) => r.itemNumber)).toEqual([
      structural.itemNumber,
    ])
    expect(result.orphans.map((o) => o.itemNumber)).toEqual([
      excluded.itemNumber,
    ])
  })

  it('marks items the change order affects, matching on masterId alone', async () => {
    const changeOrder = await createChangeOrder()
    const affected = await createPart('AFFECTED')
    const untouched = await createPart('UNTOUCHED')

    // Recorded by masterId only. A revised item's branch version has a
    // different id than whatever was recorded when it was added, so masterId
    // is the match that has to hold on its own.
    await ChangeOrderService.addAffectedItem(
      changeOrder.id,
      {
        affectedItemMasterId: affected.masterId,
        changeAction: 'release',
      },
      user.id,
    )

    const result = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      designId,
    )

    const affectedNode = findNode(result.roots, affected.itemNumber)
    expect(affectedNode?.isInEco).toBe(true)
    expect(affectedNode?.changeAction).toBe('release')

    const untouchedNode = findNode(result.roots, untouched.itemNumber)
    expect(untouchedNode?.isInEco).toBe(false)
    expect(untouchedNode?.changeAction).toBeNull()
  })

  it('shows only touched subtrees for a Library design', async () => {
    const library = await DesignService.create(
      {
        programId,
        name: 'Shared Library',
        code: `LIB-${uniquePrefix}`,
        designType: 'Library',
      },
      user.id,
    )
    const libraryId = library.id

    const makeLibraryPart = async (suffix: string) =>
      ItemService.create(
        'Part',
        {
          itemNumber: `LP-${uniquePrefix}-${suffix}`,
          revision: 'A',
          name: `Library Part ${suffix}`,
          designId: libraryId,
          state: 'Draft',
        } as any,
        user.id,
      )

    const touchedRoot = await makeLibraryPart('TOUCHED-ROOT')
    const touchedChild = await makeLibraryPart('TOUCHED-CHILD')
    const untouchedRoot = await makeLibraryPart('UNTOUCHED-ROOT')

    await addBom(touchedRoot.id, touchedChild.id)

    const changeOrder = await createChangeOrder()
    // The affected item is the *child*, so this also pins that a root
    // survives on account of a descendant, not only itself.
    await ChangeOrderService.addAffectedItem(
      changeOrder.id,
      {
        affectedItemId: touchedChild.id,
        affectedItemMasterId: touchedChild.masterId,
        changeAction: 'release',
      },
      user.id,
    )

    const result = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      libraryId,
    )

    expect(result.roots.map((r) => r.itemNumber)).toEqual([
      touchedRoot.itemNumber,
    ])
    expect(result.roots.map((r) => r.itemNumber)).not.toContain(
      untouchedRoot.itemNumber,
    )
  })

  it('resolves against the ECO branch once one exists, and counts its own affected items', async () => {
    const changeOrder = await createChangeOrder()
    const part = await createPart('BRANCHED')

    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      changeOrder.id,
      user.id,
    )

    await ChangeOrderService.addAffectedItem(
      changeOrder.id,
      {
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
      },
      user.id,
    )

    const result = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      designId,
    )

    expect(result.versionContext.type).toBe('branch')
    expect(result.versionContext.isHistorical).toBe(false)
    expect(result.ecoBranch?.id).toBe(branch.id)
    // Derived from the affected-item rows for this design, not a stored counter
    expect(result.ecoBranch?.itemsAffected).toBe(1)
  })

  it('lists a revised child once, not once per revision of its parent', async () => {
    // BOM lines are queried across every revision sharing the parent's
    // masterId, because a checkout leaves a working copy owning none. Once a
    // release has revised parent and child together, two revisions of the
    // parent name two revisions of the child; both resolve to the child in
    // view, and it rendered twice — selectable twice, and counted twice when
    // added to a change order.
    const assembly = await createPart('DUP-ASM')
    const child = await createPart('DUP-CHILD')
    for (const part of [assembly, child]) {
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, part.id))
    }
    await addBom(assembly.id, child.id, { quantity: '2', findNumber: 10 })

    const releasing = await createReleasableChangeOrder()
    for (const part of [assembly, child]) {
      await ChangeOrderService.addAffectedItem(
        releasing.id,
        {
          affectedItemId: part.id,
          affectedItemMasterId: part.masterId,
          changeAction: 'revise',
        },
        user.id,
      )
    }
    await approveChangeOrder(releasing.id)
    await ChangeOrderMergeService.merge(releasing.id, user.id)

    // The merge really did mint new rows, or nothing below is being tested.
    const revisions = await testDb.db
      .select()
      .from(items)
      .where(eq(items.masterId, child.masterId))
    expect(revisions.length).toBeGreaterThan(1)

    const result = await ChangeOrderStructureService.getDesignStructure(
      (await createChangeOrder()).id,
      designId,
    )

    const node = findNode(result.roots, assembly.itemNumber)
    expect(node?.children?.map((c) => c.itemNumber)).toEqual([child.itemNumber])
  })

  it('keeps the BOM of an item checked out onto the change order branch', async () => {
    // The other half of the same rule: checkout copies no lines, so a working
    // copy owning none has to fall back to its master's other revisions.
    const changeOrder = await createChangeOrder()
    const assembly = await createPart('CO-ASM')
    const child = await createPart('CO-CHILD')
    await addBom(assembly.id, child.id, { quantity: '1', findNumber: 10 })

    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      changeOrder.id,
      user.id,
    )
    await CheckoutService.checkout(
      { branchId: branch.id, itemMasterId: assembly.masterId },
      user.id,
    )

    const result = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      designId,
    )

    const node = findNode(result.roots, assembly.itemNumber)
    expect(node?.children?.map((c) => c.itemNumber)).toEqual([child.itemNumber])
  })

  it('falls back to the released view when the change order has no branch here', async () => {
    const changeOrder = await createChangeOrder()
    await createPart('NO-BRANCH')

    const result = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      designId,
    )

    expect(result.versionContext.type).toBe('released')
    expect(result.versionContext.isHistorical).toBe(false)
    expect(result.ecoBranch).toBeNull()
  })
})
