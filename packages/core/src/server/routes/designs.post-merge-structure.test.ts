// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design structure + graph after the first ECO merge
 *
 * Data-integrity gate: these endpoints answer "what does this design contain
 * on main", and both ways of answering it broke once a merge landed.
 *
 * The design here is the shape the reports came from: every item created
 * directly on main during the pre-release phase, then one ECO revising a
 * single leaf part.
 *
 *   - Items created on main get no `branch_items` row. The structure route
 *     read `branch_items` and fell back to the design's current items only
 *     when that came back *empty*, so the merge inserting the first row
 *     collapsed the view to the one item it released.
 *   - A BOM line names one item *version*, and the merge re-points only the
 *     lines owned by items the ECO touched. An untouched parent therefore
 *     still names the superseded row, so the released revision lost its
 *     parent, its where-used, and its place in the graph.
 *
 * Run: npx vitest run src/server/routes/designs.post-merge-structure.test.ts
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
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { ItemTypeRegistry } from '@/lib/items/registry'
import {
  branchItems,
  itemRelationships,
  items,
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

const STRUCTURE_TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000207'

interface BOMNode {
  itemId: string
  itemNumber: string
  revision: string
  children?: Array<BOMNode>
}
interface StructureResponse {
  data: {
    roots: Array<BOMNode>
    orphans: Array<{ id: string; itemNumber: string }>
  }
}
interface ScopeResponse {
  data: { nodes: Array<{ id: string }> }
}
interface ItemGraphResponse {
  nodes: Array<{ id: string }>
  edges: Array<{ source: string; target: string }>
}

describe('design structure and graph after an ECO merge', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/designs', designsRoutes)
    .route('/api/v1/items', itemsRoutes)

  let user: TestUser
  let cookie: string
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    await testDb.db
      .insert(workflowDefinitions)
      .values({
        id: STRUCTURE_TEST_WORKFLOW_ID,
        name: 'Test ECO Workflow - PostMergeStructure',
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
          definitionType: 'workflow',
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

    uniquePrefix = `PMS${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    // The graph route gates on the center item's type permission, so this
    // fixture's user needs a role that reads parts. It had none.
    user = (await insertTestUserWithRole(testDb.db, 'User')).user
    permissionService.clearCache()

    const program = await ProgramService.create(
      { name: 'Post-merge Program', code: `PMS-${uniquePrefix}` },
      user.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Post-merge Design',
        code: `PMSD-${uniquePrefix}`,
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

  async function createPart(suffix: string) {
    return (await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Part ${suffix}`,
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )) as { id: string; masterId: string; itemNumber: string }
  }

  async function createChangeOrder() {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Structure ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )
    await testDb.db.insert(workflowInstances).values({
      workflowDefinitionId: STRUCTURE_TEST_WORKFLOW_ID,
      itemId: eco.id,
      currentState: 'Draft',
    })
    return eco as { id: string }
  }

  async function approveEco(ecoId: string) {
    const ecoDesigns = await ChangeOrderService.getEcoDesigns(ecoId)
    for (const ecoDesign of ecoDesigns) {
      if (!ecoDesign.branchId) continue
      const branchRows = await testDb.db
        .select()
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoDesign.branchId),
            isNotNull(branchItems.changeType),
          ),
        )
      for (const row of branchRows) {
        await ChangeOrderService.registerBranchChange(
          ecoDesign.branchId,
          row.itemMasterId,
          row.currentItemId,
          user.id,
        )
      }
    }
    await testDb.db
      .update(items)
      .set({ state: 'Approved' })
      .where(eq(items.id, ecoId))
    await testDb.db
      .update(workflowInstances)
      .set({ currentState: 'Approved' })
      .where(eq(workflowInstances.itemId, ecoId))
  }

  /**
   * Assembly → child, both created on main, then one ECO revising the child.
   * Returns the child's released revision, which is a different `items` row
   * from the one the assembly's BOM line still names.
   */
  async function releaseChildThroughEco() {
    const assembly = await createPart('ASSY')
    const child = await createPart('CHILD')

    // Create both before either is Released — branch protection blocks
    // creating on main once the design holds released items — then flip them,
    // so "revise" has something to revise.
    for (const part of [assembly, child]) {
      await testDb.db
        .update(items)
        .set({ state: 'Released' })
        .where(eq(items.id, part.id))
    }

    await testDb.db.insert(itemRelationships).values({
      sourceId: assembly.id,
      targetId: child.id,
      relationshipType: 'BOM',
      quantity: '1',
      findNumber: 10,
      createdBy: user.id,
    })

    const eco = await createChangeOrder()
    await ChangeOrderService.addAffectedItem(
      eco.id,
      { affectedItemId: child.id, changeAction: 'revise' },
      user.id,
    )
    await approveEco(eco.id)
    await ChangeOrderMergeService.merge(eco.id, user.id)

    const releasedChild = await testDb.db
      .select()
      .from(items)
      .where(and(eq(items.masterId, child.masterId), eq(items.isCurrent, true)))
      .then((r) => r.at(0))

    expect(releasedChild).toBeDefined()
    // The merge really did mint a new row, or nothing below is being tested.
    expect(releasedChild!.id).not.toBe(child.id)

    return { assembly, child, releasedChild: releasedChild! }
  }

  async function fetchStructure() {
    const response = await app.request(
      `/api/v1/designs/${designId}/structure`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as StructureResponse).data
  }

  function flatten(nodes: Array<BOMNode>): Array<BOMNode> {
    return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])])
  }

  it('keeps every item on main in the structure, not just the released one', async () => {
    const { assembly, releasedChild } = await releaseChildThroughEco()

    const { roots, orphans } = await fetchStructure()
    const present = new Set([
      ...flatten(roots).map((n) => n.itemId),
      ...orphans.map((o) => o.id),
    ])

    // The whole point of this test: the assembly is created directly on main
    // and so has no branch_items row, while the merge gave the child one.
    // Reading only branch_items left the assembly out of the design entirely.
    expect(present).toContain(assembly.id)
    expect(present).toContain(releasedChild.id)
  })

  it('re-points the untouched parent BOM line onto the released revision', async () => {
    const { assembly, child, releasedChild } = await releaseChildThroughEco()

    const { roots } = await fetchStructure()

    const assemblyNode = flatten(roots).find((n) => n.itemId === assembly.id)
    expect(assemblyNode).toBeDefined()

    const childIds = (assemblyNode!.children ?? []).map((c) => c.itemId)
    expect(childIds).toContain(releasedChild.id)
    // …and not the row it superseded.
    expect(childIds).not.toContain(child.id)
  })

  it('does not surface the released child as a second root', async () => {
    const { assembly, releasedChild } = await releaseChildThroughEco()

    const { roots } = await fetchStructure()
    const rootIds = roots.map((r) => r.itemId)

    expect(rootIds).toContain(assembly.id)
    expect(rootIds).not.toContain(releasedChild.id)
  })

  it('keeps the released child nested in the design scope graph', async () => {
    const { assembly, releasedChild } = await releaseChildThroughEco()

    const response = await app.request(
      `/api/v1/designs/${designId}/graph?direction=down`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as ScopeResponse
    const nodeIds = data.nodes.map((n) => n.id)

    // Top-level means "nothing in the design points at it". The assembly still
    // does — through a line naming the superseded revision.
    expect(nodeIds).toContain(assembly.id)
    expect(nodeIds).not.toContain(releasedChild.id)
  })

  it('reports the released revision as used by its parent', async () => {
    const { assembly, releasedChild } = await releaseChildThroughEco()

    const whereUsed = await ImpactAssessmentService.findWhereUsed(
      releasedChild.id,
    )

    expect(whereUsed.map((n) => n.itemId)).toContain(assembly.id)
  })

  it('still finds the parent assemblies of a released revision', async () => {
    const { assembly, releasedChild } = await releaseChildThroughEco()

    // This is what the "which parents do you want in this ECO?" prompt reads.
    // Reporting nothing here does not fail loudly — it silently leaves the
    // assembly behind, still pointing at the superseded revision.
    const ancestors = await ImpactAssessmentService.findAncestorChain(
      releasedChild.id,
      designId,
    )

    expect(ancestors.map((a) => a.itemId)).toContain(assembly.id)
  })

  it('walks past a released revision to the grandparent', async () => {
    // top → assembly → child, with only the child revised. The chain has to
    // cross the superseded link at depth 1 to reach `top` at depth 2 at all.
    const top = await createPart('TOP')
    const { assembly, releasedChild } = await releaseChildThroughEco()

    await testDb.db.insert(itemRelationships).values({
      sourceId: top.id,
      targetId: assembly.id,
      relationshipType: 'BOM',
      quantity: '1',
      createdBy: user.id,
    })

    const ancestors = await ImpactAssessmentService.findAncestorChain(
      releasedChild.id,
      designId,
    )

    expect(ancestors.find((a) => a.itemId === assembly.id)?.depth).toBe(1)
    expect(ancestors.find((a) => a.itemId === top.id)?.depth).toBe(2)
  })

  it('reaches the parent when expanding a released revision upstream', async () => {
    const { assembly, releasedChild } = await releaseChildThroughEco()

    // The per-node expansion the design scope graph drills into. Matching the
    // rendered row alone, a revision looked unused the moment it was released.
    const response = await app.request(
      `/api/v1/items/${releasedChild.id}/graph?direction=incoming&depth=1`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    const graph = (await response.json()) as ItemGraphResponse

    expect(graph.nodes.map((n) => n.id)).toContain(assembly.id)
    expect(
      graph.edges.some(
        (e) => e.source === assembly.id && e.target === releasedChild.id,
      ),
    ).toBe(true)
  })

  it('does not report the superseded row as a separate upstream node', async () => {
    const { assembly, child, releasedChild } = await releaseChildThroughEco()

    const response = await app.request(
      `/api/v1/items/${releasedChild.id}/graph?direction=incoming&depth=2`,
      { headers: { cookie } },
    )
    const graph = (await response.json()) as ItemGraphResponse
    const nodeIds = graph.nodes.map((n) => n.id)

    // Reading the lineage's other rows must not drag the superseded revision
    // in beside the one being rendered.
    expect(nodeIds).toContain(releasedChild.id)
    expect(nodeIds).not.toContain(child.id)
    expect(nodeIds).toContain(assembly.id)
  })

  it("reads the parent's BOM line back at the released revision", async () => {
    const { assembly, child, releasedChild } = await releaseChildThroughEco()

    const bom = await ItemService.getRelationshipsWithDetails(
      assembly.id,
      'BOM',
    )

    expect(bom).toHaveLength(1)
    // The stored row still names the version the release superseded — that is
    // the honest FK — but what it resolves to is the revision now current.
    expect(bom[0]!.targetId).toBe(child.id)
    expect(bom[0]!.targetItem!.id).toBe(releasedChild.id)
  })
})
