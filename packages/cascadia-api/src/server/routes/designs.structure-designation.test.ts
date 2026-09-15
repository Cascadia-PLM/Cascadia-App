// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design structure: which parts are top-level
 *
 * Data-integrity gate: two endpoints answer "what is this design's
 * structure", and both promoted a part to a root the moment nothing pointed
 * at it. The case that surfaced it: a released design, a change order
 * revising one of its assemblies, a child removed from that assembly on the
 * branch. The orphan surfaced as a top-level part of the design — in the
 * design page's structure at the branch, in the change order's
 * design-structure view, and on main once the change order released — with
 * nobody having put it there.
 *
 * A part is a top-level part only because something designated it (creation
 * in the design, a usage copy's root, "Add to Structure"), and nesting it
 * withdraws that. These tests pin the rule at each of those seams, on both
 * endpoints and across a release.
 *
 * Run: npx vitest run src/server/routes/designs.structure-designation.test.ts
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
import { and, eq, isNotNull } from 'drizzle-orm'
import designsRoutes from './designs'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BOMTreeNode, OrphanItem } from '@/lib/types/bom'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { ChangeOrderStructureService } from '@/lib/services/ChangeOrderStructureService'
import { UsageService } from '@/lib/services/UsageService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  branchItems,
  itemRelationships,
  items,
  lifecycleDefinitions,
  lifecycleInstances,
} from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

const DESIGNATION_TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000208'

interface StructureResponse {
  data: { roots: Array<BOMTreeNode>; orphans: Array<OrphanItem> }
}

type CreatedPart = { id: string; masterId: string; itemNumber: string }

describe('design structure: top-level parts are the designated ones', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/designs', designsRoutes)

  let user: TestUser
  let cookie: string
  let programId: string
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: DESIGNATION_TEST_WORKFLOW_ID,
        name: 'Test ECO Workflow - StructureDesignation',
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

    uniquePrefix = `SD${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = (await insertTestUserWithRole(testDb.db, 'User')).user
    permissionService.clearCache()

    const program = await ProgramService.create(
      { name: 'Designation Program', code: `SD-${uniquePrefix}` },
      user.id,
    )
    programId = program.id
    const design = await DesignService.create(
      {
        programId,
        name: 'Designation Design',
        code: `SDD-${uniquePrefix}`,
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

  async function createPart(suffix: string, inDesignId = designId) {
    return (await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Part ${suffix}`,
        designId: inDesignId,
        state: 'Draft',
      } as any,
      user.id,
    )) as CreatedPart
  }

  /** A BOM line, through the service every editor and importer uses. */
  async function nest(parentId: string, childId: string) {
    return ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      { quantity: '1' },
      { bypassEditGuard: true },
    )
  }

  async function lineBetween(parentId: string, childId: string) {
    const line = await testDb.db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, parentId),
          eq(itemRelationships.targetId, childId),
          eq(itemRelationships.relationshipType, 'BOM'),
        ),
      )
      .then((r) => r.at(0))
    expect(line).toBeDefined()
    return line!
  }

  async function unnest(parentId: string, childId: string) {
    const line = await lineBetween(parentId, childId)
    await ItemRelationshipService.removeRelationship(line.id, user.id, {
      bypassEditGuard: true,
    })
  }

  async function designated(itemId: string) {
    const row = await testDb.db
      .select({ inDesignStructure: items.inDesignStructure })
      .from(items)
      .where(eq(items.id, itemId))
      .then((r) => r.at(0))
    expect(row).toBeDefined()
    return row!.inDesignStructure
  }

  // Both created before either is Released: branch protection blocks creating
  // on main once the design holds released items.
  async function release(...parts: Array<CreatedPart>) {
    for (const part of parts) {
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, part.id))
    }
  }

  async function createChangeOrder() {
    const changeOrder = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Designation ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: DESIGNATION_TEST_WORKFLOW_ID,
      itemId: changeOrder.id,
      currentState: 'Draft',
    })
    return changeOrder as { id: string }
  }

  /** Revise `part` on the change order; returns the branch and the working copy. */
  async function reviseOnChangeOrder(changeOrderId: string, part: CreatedPart) {
    await ChangeOrderService.addAffectedItem(
      changeOrderId,
      { affectedItemId: part.id, changeAction: 'revise' },
      user.id,
    )
    const changeOrderDesign = (
      await ChangeOrderService.getChangeOrderDesigns(changeOrderId)
    ).find((d) => d.designId === designId)
    expect(changeOrderDesign?.branchId).toBeTruthy()
    const branchId = changeOrderDesign!.branchId!

    const tracking = await testDb.db
      .select({ currentItemId: branchItems.currentItemId })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, part.masterId),
        ),
      )
      .then((r) => r.at(0))
    const workingCopyId = tracking?.currentItemId
    expect(workingCopyId).toBeTruthy()
    // The revise really did mint a copy, or the branch edits below would be
    // edits of main.
    expect(workingCopyId).not.toBe(part.id)
    return { branchId, workingCopyId: workingCopyId! }
  }

  async function approveAndMerge(changeOrderId: string) {
    for (const changeOrderDesign of await ChangeOrderService.getChangeOrderDesigns(
      changeOrderId,
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
      .where(eq(items.id, changeOrderId))
    await testDb.db
      .update(lifecycleInstances)
      .set({ currentState: 'Approved' })
      .where(eq(lifecycleInstances.itemId, changeOrderId))
    await ChangeOrderMergeService.merge(changeOrderId, user.id)
  }

  async function fetchStructure(query = '') {
    const response = await app.request(
      `/api/v1/designs/${designId}/structure${query}`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as StructureResponse).data
  }

  function flatten(nodes: Array<BOMTreeNode>): Array<BOMTreeNode> {
    return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])])
  }
  const rootIds = (view: { roots: Array<BOMTreeNode> }) =>
    view.roots.map((r) => r.itemId)
  const rootNumbers = (view: { roots: Array<BOMTreeNode> }) =>
    view.roots.map((r) => r.itemNumber)
  const nestedIds = (view: { roots: Array<BOMTreeNode> }) =>
    flatten(view.roots)
      .filter((n) => n.relationshipId !== undefined)
      .map((n) => n.itemId)
  const orphanIds = (view: { orphans: Array<OrphanItem> }) =>
    view.orphans.map((o) => o.id)

  it('a part created in a design is a top-level part until something nests it', async () => {
    const assembly = await createPart('ASSY')
    const child = await createPart('CHILD')
    expect(await designated(assembly.id)).toBe(true)
    expect(await designated(child.id)).toBe(true)
    expect(rootIds(await fetchStructure()).sort()).toEqual(
      [assembly.id, child.id].sort(),
    )

    await nest(assembly.id, child.id)

    // Nesting withdrew the designation, and the tree shows the child under
    // its parent only.
    expect(await designated(child.id)).toBe(false)
    const view = await fetchStructure()
    expect(rootIds(view)).toEqual([assembly.id])
    expect(nestedIds(view)).toContain(child.id)
    expect(orphanIds(view)).not.toContain(child.id)
  })

  it('a child whose line is removed on main joins the non-structure items, not the roots', async () => {
    const assembly = await createPart('ASSY')
    const child = await createPart('CHILD')
    await nest(assembly.id, child.id)

    await unnest(assembly.id, child.id)

    const view = await fetchStructure()
    expect(rootIds(view)).toEqual([assembly.id])
    expect(orphanIds(view)).toContain(child.id)
  })

  it('"Add to Structure" makes such a part a top-level part on purpose', async () => {
    const assembly = await createPart('ASSY')
    const child = await createPart('CHILD')
    await nest(assembly.id, child.id)
    await unnest(assembly.id, child.id)

    const response = await app.request(`/api/v1/designs/${designId}/items`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: child.id }),
    })
    expect(response.status).toBe(200)

    const view = await fetchStructure()
    expect(rootIds(view).sort()).toEqual([assembly.id, child.id].sort())
    expect(orphanIds(view)).not.toContain(child.id)
  })

  it('a child removed from an assembly on a change order is not a top-level part — on the branch, in the change order, or on main after release', async () => {
    const assembly = await createPart('ASSY')
    const child = await createPart('CHILD')
    await nest(assembly.id, child.id)
    await release(assembly, child)

    const changeOrder = await createChangeOrder()
    const { branchId, workingCopyId } = await reviseOnChangeOrder(
      changeOrder.id,
      assembly,
    )
    // The working copy carries the line, and the edit is made to that copy.
    await unnest(workingCopyId, child.id)

    // The design's structure at the branch: the assembly, without the child,
    // and the child among the non-structure items — not a second root.
    const onBranch = await fetchStructure(`?branch=${branchId}`)
    expect(rootIds(onBranch)).toEqual([workingCopyId])
    expect(nestedIds(onBranch)).not.toContain(child.id)
    expect(orphanIds(onBranch)).toContain(child.id)

    // The change order's own view of the design says the same — and does
    // not resurrect the deleted line through the released row on main.
    const onChangeOrder = await ChangeOrderStructureService.getDesignStructure(
      changeOrder.id,
      designId,
    )
    expect(rootNumbers(onChangeOrder)).toEqual([assembly.itemNumber])
    expect(flatten(onChangeOrder.roots).map((n) => n.itemNumber)).not.toContain(
      child.itemNumber,
    )
    expect(onChangeOrder.orphans.map((o) => o.itemNumber)).toContain(
      child.itemNumber,
    )

    // Main has not changed: the child is still nested there.
    const onMain = await fetchStructure()
    expect(rootIds(onMain)).toEqual([assembly.id])
    expect(nestedIds(onMain)).toContain(child.id)
    expect(orphanIds(onMain)).not.toContain(child.id)

    await approveAndMerge(changeOrder.id)

    // …and once released, main shows the branch's structure: the child is
    // gone from the tree and offered as a non-structure item.
    const released = await fetchStructure()
    expect(rootNumbers(released)).toEqual([assembly.itemNumber])
    expect(flatten(released.roots).map((n) => n.itemId)).not.toContain(child.id)
    expect(orphanIds(released)).toContain(child.id)
  })

  it('nesting a released part on a change order leaves main alone until the release, which withdraws its designation', async () => {
    const assembly = await createPart('ASSY')
    const other = await createPart('OTHER')
    await release(assembly, other)

    const changeOrder = await createChangeOrder()
    const { branchId, workingCopyId } = await reviseOnChangeOrder(
      changeOrder.id,
      assembly,
    )
    await nest(workingCopyId, other.id)

    // Main's row keeps its designation: main has not changed, and clearing
    // it here would drop a top-level part from main's structure because of
    // an unreleased branch.
    expect(await designated(other.id)).toBe(true)
    expect(rootIds(await fetchStructure()).sort()).toEqual(
      [assembly.id, other.id].sort(),
    )
    const onBranch = await fetchStructure(`?branch=${branchId}`)
    expect(rootIds(onBranch)).toEqual([workingCopyId])
    expect(nestedIds(onBranch)).toContain(other.id)

    await approveAndMerge(changeOrder.id)

    expect(await designated(other.id)).toBe(false)
    const released = await fetchStructure()
    expect(rootNumbers(released)).toEqual([assembly.itemNumber])
    expect(nestedIds(released)).toContain(other.id)
  })

  it('adding a part from another design designates the copied root and not its children', async () => {
    const donorDesign = await DesignService.create(
      {
        programId,
        name: 'Donor Design',
        code: `SDX-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    const donorAssembly = await createPart('DASSY', donorDesign.id)
    const donorChild = await createPart('DCHILD', donorDesign.id)
    await nest(donorAssembly.id, donorChild.id)

    const { items: copies } = await UsageService.createUsageSubtree(
      { rootItemId: donorAssembly.id, targetDesignId: designId },
      user.id,
    )
    const copiedRoot = copies.find((c) => c.usageOf === donorAssembly.id)
    const copiedChild = copies.find((c) => c.usageOf === donorChild.id)
    expect(copiedRoot).toBeDefined()
    expect(copiedChild).toBeDefined()
    expect(copiedRoot!.inDesignStructure).toBe(true)
    expect(copiedChild!.inDesignStructure).toBe(false)

    const view = await fetchStructure()
    expect(rootIds(view)).toEqual([copiedRoot!.id])
    expect(nestedIds(view)).toContain(copiedChild!.id)
    expect(orphanIds(view)).not.toContain(copiedChild!.id)
  })
})
