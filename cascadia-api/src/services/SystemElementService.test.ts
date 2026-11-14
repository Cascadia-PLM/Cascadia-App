// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The system architecture under change control.
 *
 * Data-integrity gate: the architecture is two edge types between version
 * rows, and the invariants are the BOM's — a tree that stays a tree, and
 * branch isolation that survives the release. Pinned here:
 *
 * - a `DECOMPOSES` edge that would close a loop is refused, through the
 *   element service and through the generic relationship write alike, and
 *   the tree is unchanged by the attempt;
 * - architecture edges ride an ECO: a child placed and a realization made on
 *   the branch show on the branch and nowhere else, and after the release
 *   the released tree equals the branch tree;
 * - a requirement allocated to an element reads as allocated in the matrix
 *   before any part exists, and once the element is realized the matrix
 *   shows the second hop.
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
import { ValidationError } from '../errors'
import { BranchService } from './BranchService'
import { ChangeOrderMergeService } from './ChangeOrderMergeService'
import { CheckoutService } from './CheckoutService'
import { DesignService } from './DesignService'
import { RequirementService } from './RequirementService'
import { RequirementsMatrixService } from './RequirementsMatrixService'
import { SystemElementService } from './SystemElementService'
import type { ArchitectureNode } from './SystemElementService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  seedRequirementLifecycle,
  seedStandardPartLifecycle,
  seedSystemElementLifecycle,
} from '@/__tests__/fixtures/lifecycles'
import {
  branchItems,
  changeOrderDesigns,
  items,
  lifecycleDefinitions,
  lifecycleInstances,
  programMembers,
  programs,
} from '@/db/schema'
import { itemVersions } from '@/db/schema/versioning'
import { takeFirst } from '@/db/take-first'
import { ItemTypeRegistry } from '@/items/registry'
import '@/items/registerItemTypes.server'

// Unique to this file, so it cannot race another suite's ECO workflow.
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000245'

/** The tree as numbers, kinds and links — what two contexts are compared on. */
function shape(node: ArchitectureNode): unknown {
  return {
    number: node.itemNumber,
    kind: node.elementKind,
    realizedBy: node.realizedBy.map((link) => link.itemNumber).sort(),
    allocated: node.allocatedRequirements.map((link) => link.itemNumber).sort(),
    children: node.children.map(shape),
  }
}

describe('SystemElementService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string
  let initialCommitId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await seedRequirementLifecycle(testDb.db)
    await seedSystemElementLifecycle(testDb.db)
    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: WORKFLOW_ID,
        name: 'Test ECO Workflow - SystemElement',
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
    uniquePrefix = `A${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Architecture Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id
    await testDb.db.insert(programMembers).values({
      programId,
      userId: user.id,
      role: 'admin',
      invitedBy: user.id,
    })
    const design = await DesignService.create(
      {
        programId,
        name: 'Architecture Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
    initialCommitId = design.initialCommit!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // ---- Fixtures (the shape the requirements-matrix suite uses) ----

  async function createElement(
    suffix: string,
    elementKind: string,
  ): Promise<PersistedItem> {
    return ItemService.create<PersistedItem>(
      'SystemElement',
      {
        itemNumber: `SE-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Element ${suffix}`,
        designId,
        elementKind,
      } as unknown as PersistedItem,
      user.id,
    )
  }

  async function createPart(suffix: string): Promise<PersistedItem> {
    return ItemService.create<PersistedItem>(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Part ${suffix}`,
        designId,
      } as PersistedItem,
      user.id,
    )
  }

  async function createRequirement(suffix: string): Promise<PersistedItem> {
    return ItemService.create<PersistedItem>(
      'Requirement',
      {
        itemNumber: `REQ-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Requirement ${suffix}`,
        designId,
        priority: 'MustHave',
      } as unknown as PersistedItem,
      user.id,
    )
  }

  /** The row becomes the released baseline and the initial commit names it. */
  async function releaseOnMain(item: PersistedItem): Promise<void> {
    await testDb.db
      .update(items)
      .set({ state: 'Released', isCurrent: true })
      .where(eq(items.id, item.id))
    await testDb.db.insert(itemVersions).values({
      commitId: initialCommitId,
      itemId: item.id,
      changeType: 'added',
    })
    const mainBranch = await BranchService.getMainBranch(designId)
    await testDb.db
      .insert(branchItems)
      .values({
        branchId: mainBranch!.id,
        itemMasterId: item.masterId,
        currentItemId: item.id,
        baseItemId: item.id,
        changeType: null,
      })
      .onConflictDoNothing()
  }

  async function createChangeOrder(): Promise<{
    changeOrder: PersistedItem
    branchId: string
  }> {
    const changeOrder = await ItemService.create<PersistedItem>(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Architecture ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Reshape the architecture',
      } as unknown as PersistedItem,
      user.id,
    )
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: WORKFLOW_ID,
      itemId: changeOrder.id,
      currentState: 'Draft',
    })
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      changeOrder.id,
      user.id,
    )
    await testDb.db.insert(changeOrderDesigns).values({
      changeOrderId: changeOrder.id,
      designId,
      branchId: branch.id,
      mergeStatus: 'pending',
    })
    return { changeOrder, branchId: branch.id }
  }

  /**
   * Check `item` out to the branch the way the checkout routes do: mint the
   * revision working copy, then take the lock. The working copy the branch
   * now holds is returned.
   */
  async function checkout(
    item: PersistedItem,
    branchId: string,
  ): Promise<string> {
    const source = takeFirst(
      await testDb.db.select().from(items).where(eq(items.id, item.id)),
      'item row',
    )
    await CheckoutService.ensureRevisionWorkingCopy(source, branchId, user.id)
    await CheckoutService.checkout(
      { itemMasterId: item.masterId, branchId },
      user.id,
    )
    const row = takeFirst(
      await testDb.db
        .select({ currentItemId: branchItems.currentItemId })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, branchId),
            eq(branchItems.itemMasterId, item.masterId),
          ),
        )
        .limit(1),
      'branch row',
    )
    return row.currentItemId!
  }

  /** Approve (skipping the workflow, as the merge suite does) and merge. */
  async function release(changeOrder: PersistedItem): Promise<void> {
    for (const changeOrderDesign of await ChangeOrderService.getChangeOrderDesigns(
      changeOrder.id,
    )) {
      if (!changeOrderDesign.branchId) continue
      const branchRows = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, changeOrderDesign.branchId),
            isNotNull(branchItems.changeType),
          ),
        )
      for (const row of branchRows) {
        await ChangeOrderService.registerBranchChange(
          changeOrderDesign.branchId,
          row.itemMasterId,
          row.currentItemId,
          user.id,
        )
      }
    }
    await testDb.db
      .update(items)
      .set({ state: 'Approved' })
      .where(eq(items.id, changeOrder.id))
    await testDb.db
      .update(lifecycleInstances)
      .set({ currentState: 'Approved' })
      .where(eq(lifecycleInstances.itemId, changeOrder.id))
    await ChangeOrderMergeService.merge(changeOrder.id, user.id)
  }

  const released = () => ({ type: 'released' as const, designId })
  const onBranch = (branchId: string) => ({
    type: 'branch' as const,
    branchId,
  })

  // ---- Cases ----

  it('refuses a DECOMPOSES edge that would close a loop, and leaves the tree as it was', async () => {
    const system = await createElement('SYS', 'system')
    const subsystem = await createElement('SUB', 'subsystem')
    const module = await createElement('MOD', 'module')
    await SystemElementService.addChildren(system.id, [subsystem.id], user.id)
    await SystemElementService.addChildren(subsystem.id, [module.id], user.id)

    // The module cannot take its own ancestor as a child...
    await expect(
      SystemElementService.addChildren(module.id, [system.id], user.id),
    ).rejects.toBeInstanceOf(ValidationError)
    // ...nor itself...
    await expect(
      SystemElementService.addChildren(module.id, [module.id], user.id),
    ).rejects.toBeInstanceOf(ValidationError)
    // ...and the generic relationship write is the same gate.
    await expect(
      ItemRelationshipService.addRelationship(
        module.id,
        system.id,
        'DECOMPOSES',
        user.id,
      ),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      ItemRelationshipService.addRelationshipBatch([
        {
          sourceId: module.id,
          targetId: subsystem.id,
          relationshipType: 'DECOMPOSES',
          userId: user.id,
        },
      ]),
    ).rejects.toBeInstanceOf(ValidationError)

    const architecture = await SystemElementService.forDesign(
      designId,
      released(),
    )
    expect(architecture.roots.map(shape)).toEqual([
      {
        number: system.itemNumber,
        kind: 'system',
        realizedBy: [],
        allocated: [],
        children: [
          {
            number: subsystem.itemNumber,
            kind: 'subsystem',
            realizedBy: [],
            allocated: [],
            children: [
              {
                number: module.itemNumber,
                kind: 'module',
                realizedBy: [],
                allocated: [],
                children: [],
              },
            ],
          },
        ],
      },
    ])
    expect(architecture.totals).toEqual({
      elements: 3,
      realized: 0,
      allocated: 0,
      suspect: 0,
    })
    expect((await SystemElementService.getParent(module.id))?.itemNumber).toBe(
      subsystem.itemNumber,
    )
  })

  it('architecture edges ride an ECO: isolated on the branch, and the released tree equals the branch tree after the merge', async () => {
    // Released on main: a system with one subsystem, realized by one part.
    const system = await createElement('SYS', 'system')
    const subsystem = await createElement('SUB1', 'subsystem')
    const part = await createPart('P1')
    await SystemElementService.addChildren(system.id, [subsystem.id], user.id)
    await SystemElementService.realize(subsystem.id, [part.id], user.id)
    for (const item of [system, subsystem, part]) await releaseOnMain(item)

    const before = await SystemElementService.forDesign(designId, released())
    expect(before.roots.map(shape)).toEqual([
      {
        number: system.itemNumber,
        kind: 'system',
        realizedBy: [],
        allocated: [],
        children: [
          {
            number: subsystem.itemNumber,
            kind: 'subsystem',
            realizedBy: [part.itemNumber],
            allocated: [],
            children: [],
          },
        ],
      },
    ])

    // The ECO adds a second subsystem under the system and realizes the
    // first one with a second part, all on the branch.
    const { changeOrder, branchId } = await createChangeOrder()
    await checkout(system, branchId)
    await checkout(subsystem, branchId)
    const { item: added } = await ItemService.createOnBranch(
      'SystemElement',
      {
        itemType: 'SystemElement',
        itemNumber: `SE-${uniquePrefix}-SUB2`,
        revision: '-',
        name: 'Element SUB2',
        designId,
        elementKind: 'subsystem',
      } as unknown as PersistedItem,
      branchId,
      'add a subsystem',
      user.id,
    )
    const { item: newPart } = await ItemService.createOnBranch(
      'Part',
      {
        itemType: 'Part',
        itemNumber: `PN-${uniquePrefix}-P2`,
        revision: '-',
        name: 'Part P2',
        designId,
      },
      branchId,
      'add a part',
      user.id,
    )
    // A row created on the branch is branch content already; editing its
    // own structure still takes the lock, as the page does before an edit.
    await CheckoutService.checkout(
      { itemMasterId: added.masterId!, branchId },
      user.id,
    )
    await SystemElementService.addChildren(system.id, [added.id!], user.id, {
      branchId,
    })
    await SystemElementService.realize(subsystem.id, [newPart.id!], user.id, {
      branchId,
    })
    await SystemElementService.realize(added.id!, [newPart.id!], user.id, {
      branchId,
    })

    const expected = [
      {
        number: system.itemNumber,
        kind: 'system',
        realizedBy: [],
        allocated: [],
        children: [
          {
            number: subsystem.itemNumber,
            kind: 'subsystem',
            realizedBy: [part.itemNumber, newPart.itemNumber].sort(),
            allocated: [],
            children: [],
          },
          {
            number: added.itemNumber,
            kind: 'subsystem',
            realizedBy: [newPart.itemNumber],
            allocated: [],
            children: [],
          },
        ],
      },
    ]
    const branchView = await SystemElementService.forDesign(
      designId,
      onBranch(branchId),
    )
    expect(branchView.roots.map(shape)).toEqual(expected)
    // Nothing of it shows on the released view until the merge.
    const stillReleased = await SystemElementService.forDesign(
      designId,
      released(),
    )
    expect(stillReleased.roots.map(shape)).toEqual(before.roots.map(shape))

    await release(changeOrder)

    const after = await SystemElementService.forDesign(designId, released())
    expect(after.roots.map(shape)).toEqual(expected)
    // The revised rows answer, not the ones the release superseded.
    const root = after.roots[0]!
    expect(root.itemId).not.toBe(system.id)
    expect(root.revision).toBe('B')
    const revisedSubsystem = root.children.find(
      (child) => child.itemNumber === subsystem.itemNumber,
    )!
    expect(revisedSubsystem.revision).toBe('B')
    expect(revisedSubsystem.state).toBe('Released')
    expect(
      root.children.find((child) => child.itemNumber === added.itemNumber)!
        .state,
    ).toBe('Released')
    // A realization is a trace claim. The one made before the revision was
    // affirmed against the row the release superseded, so it reads suspect
    // on the new revision until someone affirms it; the claims made on the
    // branch were affirmed on the rows that released, and read clean.
    const byNumber = <T extends { itemNumber: string }>(
      links: Array<T>,
      number: string,
    ): T => links.find((link) => link.itemNumber === number)!
    const carried = byNumber(revisedSubsystem.realizedBy, part.itemNumber)
    expect(carried.suspect).toBe(true)
    expect(carried.suspectReasons).toEqual(['source_revised'])
    expect(
      byNumber(revisedSubsystem.realizedBy, newPart.itemNumber!).suspect,
    ).toBe(false)
    expect(after.totals).toEqual({
      elements: 3,
      realized: 2,
      allocated: 0,
      suspect: 1,
    })
  })

  it('a requirement allocated to an element reads as allocated before any part exists, and the matrix shows the realizing part as the second hop', async () => {
    const subsystem = await createElement('SUB', 'subsystem')
    const requirement = await createRequirement('R1')
    await RequirementService.allocateToDesign(
      requirement.id,
      subsystem.id,
      user.id,
    )

    const unrealized = await RequirementsMatrixService.forDesign(
      designId,
      released(),
    )
    expect(unrealized.rows).toHaveLength(1)
    const row = unrealized.rows[0]!
    expect(row.allocatedTo.map((link) => link.itemNumber)).toEqual([
      subsystem.itemNumber,
    ])
    expect(row.allocatedTo[0]!.itemType).toBe('SystemElement')
    expect(row.allocatedTo[0]!.realizedBy).toEqual([])
    expect(row.gaps).not.toContain('not_allocated')
    expect(unrealized.totals.allocated).toBe(1)

    // The element's own page lists the allocation.
    expect(
      (await SystemElementService.getAllocatedRequirements(subsystem.id)).map(
        (link) => link.itemNumber,
      ),
    ).toEqual([requirement.itemNumber])

    // Realize the element: the matrix row now reads requirement → element →
    // part, and the architecture agrees from its side.
    const part = await createPart('P1')
    await SystemElementService.realize(subsystem.id, [part.id], user.id)

    const realized = await RequirementsMatrixService.forDesign(
      designId,
      released(),
    )
    const link = realized.rows[0]!.allocatedTo[0]!
    expect(link.realizedBy?.map((hop) => hop.itemNumber)).toEqual([
      part.itemNumber,
    ])
    expect(link.realizedBy?.[0]?.suspect).toBe(false)

    const architecture = await SystemElementService.forDesign(
      designId,
      released(),
    )
    expect(architecture.roots.map(shape)).toEqual([
      {
        number: subsystem.itemNumber,
        kind: 'subsystem',
        realizedBy: [part.itemNumber],
        allocated: [requirement.itemNumber],
        children: [],
      },
    ])
    expect(architecture.totals).toEqual({
      elements: 1,
      realized: 1,
      allocated: 1,
      suspect: 0,
    })

    // A realization is a trace claim: it names only parts and software.
    await expect(
      SystemElementService.realize(subsystem.id, [requirement.id], user.id),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('connections ride an ECO: refused on released main, isolated on the branch, and on main after the merge', async () => {
    const power = await createElement('PWR', 'subsystem')
    const avionics = await createElement('AVI', 'subsystem')
    for (const item of [power, avionics]) await releaseOnMain(item)

    /** The connections at a context, as item numbers with name and kind. */
    const connectionsAt = async (
      context: Parameters<typeof SystemElementService.forDesign>[1],
    ) => {
      const architecture = await SystemElementService.forDesign(
        designId,
        context,
      )
      const numberOf = new Map(
        architecture.roots.map((node) => [node.itemId, node.itemNumber]),
      )
      return architecture.connections.map((connection) => ({
        from: numberOf.get(connection.sourceItemId),
        to: numberOf.get(connection.targetItemId),
        name: connection.name,
        kind: connection.kind,
      }))
    }

    // An element cannot be connected to itself, and released main is closed
    // to a connection exactly as it is to a child.
    await expect(
      SystemElementService.connect(power.id, power.id, {}, user.id),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      SystemElementService.connect(power.id, avionics.id, {}, user.id),
    ).rejects.toThrow()
    expect(await connectionsAt(released())).toEqual([])

    // Inside the ECO, with the source checked out, the line can be drawn —
    // named by main's ids, landing on the branch's rows.
    const { changeOrder, branchId } = await createChangeOrder()
    await checkout(power, branchId)
    const { relationshipId } = await SystemElementService.connect(
      power.id,
      avionics.id,
      { name: '28 V bus', kind: 'power' },
      user.id,
      { branchId },
    )
    // Drawing the same line again edits it rather than adding a second.
    await SystemElementService.connect(
      power.id,
      avionics.id,
      { name: '28 V main bus' },
      user.id,
      { branchId },
    )
    const drawn = {
      from: power.itemNumber,
      to: avionics.itemNumber,
      name: '28 V main bus',
      kind: 'power',
    }
    expect(await connectionsAt(onBranch(branchId))).toEqual([drawn])
    expect(await connectionsAt(released())).toEqual([])

    // A rename leaves the kind alone; clearing the kind leaves the name.
    await SystemElementService.updateConnection(
      relationshipId,
      { kind: null },
      user.id,
    )
    expect(await connectionsAt(onBranch(branchId))).toEqual([
      { ...drawn, kind: null },
    ])
    await SystemElementService.updateConnection(
      relationshipId,
      { kind: 'power' },
      user.id,
    )

    await release(changeOrder)
    expect(await connectionsAt(released())).toEqual([drawn])
  })

  it('the diagram layout is per design and merges by element', async () => {
    const a = await createElement('A', 'system')
    const b = await createElement('B', 'system')

    await SystemElementService.saveLayout(
      designId,
      { [a.masterId]: { x: 10, y: 20 }, [b.masterId]: { x: 300, y: 20 } },
      user.id,
    )
    // Saving one block leaves the other where it was.
    await SystemElementService.saveLayout(
      designId,
      { [a.masterId]: { x: 50, y: 60 } },
      user.id,
    )
    const architecture = await SystemElementService.forDesign(
      designId,
      released(),
    )
    expect(architecture.layout).toEqual({
      [a.masterId]: { x: 50, y: 60 },
      [b.masterId]: { x: 300, y: 20 },
    })

    await SystemElementService.resetLayout(designId)
    expect(
      (await SystemElementService.forDesign(designId, released())).layout,
    ).toEqual({})
  })
})
