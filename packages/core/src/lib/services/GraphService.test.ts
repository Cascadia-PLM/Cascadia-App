// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * GraphService — complex-algorithm gate.
 *
 * The walk's route-level behavior (derived physical edges, files, depth
 * bounds, program isolation) is pinned by items.graph.test.ts. This suite
 * pins the three properties the level-batched restructure (GRAPH-2) could
 * silently break:
 *
 *  - canonical-node dedup across revisions: two rows of one lineage render
 *    as one node, and edges pinned to the superseded row remap onto it
 *  - the pinned-incoming lineage walk: a released revision still shows the
 *    assemblies that use it, even though their BOM lines name the row it
 *    superseded
 *  - the query count is O(depth), not O(nodes): a tenfold-wider graph at
 *    the same depth issues exactly the same number of queries
 *
 * Run: npx vitest run packages/core/src/lib/services/GraphService.test.ts
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
  vi,
} from 'vitest'
import { GraphService } from './GraphService'
import type * as DbModule from '@/lib/db'

import type { ItemGraphOptions } from './GraphService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { itemRelationships, items } from '@/lib/db/schema'
import { designs } from '@/lib/db/schema/designs'
import { programs } from '@/lib/db/schema/programs'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// The exported `db` is a resolution Proxy (it re-targets to the test
// transaction), so vi.spyOn cannot see `select` — wrap the module with a
// counting proxy instead (vi.mock is hoisted above the imports by vitest).
// Everything else re-exports unchanged.
const queryCounter = vi.hoisted(() => ({ selects: 0 }))
vi.mock('@/lib/db', async (importOriginal) => {
  const mod = await importOriginal<typeof DbModule>()
  const counting = new Proxy(mod.db, {
    get(target, prop) {
      if (prop === 'select') queryCounter.selects++
      return Reflect.get(target, prop)
    },
  })
  return { ...mod, db: counting }
})

const walkDefaults: ItemGraphOptions = {
  depth: 2,
  direction: 'all',
  relationshipTypes: [],
  includeUsages: true,
  includeFiles: false,
  designScope: null,
  centerDesignId: null,
}

describe('GraphService.buildItemGraph', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Graph Test Program',
          code: `PROG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const design = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId: program.id,
          name: 'Graph Test Design',
          code: `DES-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          designType: 'Engineering',
          createdBy: user.id,
        })
        .returning(),
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** Direct items insert — one row of a lineage. */
  async function insertItemRow(input: {
    itemNumber: string
    name: string
    masterId?: string
    revision?: string
    isCurrent?: boolean
  }): Promise<{ id: string; masterId: string }> {
    const row = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          itemNumber: input.itemNumber,
          itemType: 'Part',
          revision: input.revision ?? 'A',
          name: input.name,
          state: 'Draft',
          masterId: input.masterId ?? randomUUID(),
          designId,
          isCurrent: input.isCurrent ?? true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    return { id: row.id, masterId: row.masterId }
  }

  async function insertBomEdge(sourceId: string, targetId: string) {
    await testDb.db.insert(itemRelationships).values({
      sourceId,
      targetId,
      relationshipType: 'BOM',
      createdBy: user.id,
    })
  }

  it('renders one node per lineage and remaps edges pinned to a superseded row', async () => {
    const prefix = `GS-${Date.now()}`
    // One lineage, two revision rows: A (superseded) and B (current).
    const revA = await insertItemRow({
      itemNumber: `${prefix}-PART`,
      name: 'Part rev A',
      revision: 'A',
      isCurrent: false,
    })
    const revB = await insertItemRow({
      itemNumber: `${prefix}-PART`,
      name: 'Part rev B',
      masterId: revA.masterId,
      revision: 'B',
      isCurrent: true,
    })
    // The assembly's BOM line still names the superseded row — a merge
    // re-points only lines owned by items the change order touched.
    const assembly = await insertItemRow({
      itemNumber: `${prefix}-ASM`,
      name: 'Assembly',
    })
    await insertBomEdge(assembly.id, revA.id)

    const graph = await GraphService.buildItemGraph(revB.id, walkDefaults)

    // Exactly one node stands for the part lineage, and it is the walked
    // row — never a second node for the rev-A row.
    const partNodes = graph.nodes.filter(
      (n) =>
        n.type === 'itemNode' &&
        (n.id === revA.id ||
          n.id === revB.id ||
          n.data.itemId === revA.id ||
          n.data.itemId === revB.id),
    )
    expect(partNodes).toHaveLength(1)
    expect(partNodes[0]!.id).toBe(revB.id)

    // The pinned BOM line renders against the walked row.
    const bomEdge = graph.edges.find(
      (e) => e.data.relationshipType === 'BOM' && e.target === revB.id,
    )
    expect(bomEdge).toBeDefined()
    expect(bomEdge!.source).toBe(assembly.id)

    // No self-loops and no edge referencing the superseded row survive the
    // remap pass.
    for (const edge of graph.edges) {
      expect(edge.source).not.toBe(edge.target)
      expect(edge.source).not.toBe(revA.id)
      expect(edge.target).not.toBe(revA.id)
    }
  })

  it('shows the assemblies using a released revision whose BOM lines name the superseded row', async () => {
    const prefix = `GS-${Date.now()}`
    const revA = await insertItemRow({
      itemNumber: `${prefix}-P2`,
      name: 'P2 rev A',
      revision: 'A',
      isCurrent: false,
    })
    const revB = await insertItemRow({
      itemNumber: `${prefix}-P2`,
      name: 'P2 rev B',
      masterId: revA.masterId,
      revision: 'B',
      isCurrent: true,
    })
    const asm1 = await insertItemRow({
      itemNumber: `${prefix}-ASM1`,
      name: 'Assembly 1',
    })
    const asm2 = await insertItemRow({
      itemNumber: `${prefix}-ASM2`,
      name: 'Assembly 2',
    })
    await insertBomEdge(asm1.id, revA.id)
    await insertBomEdge(asm2.id, revA.id)

    // Upstream expansion of the current revision: without the lineage walk
    // the revision looked unused the moment it was released.
    const graph = await GraphService.buildItemGraph(revB.id, {
      ...walkDefaults,
      direction: 'incoming',
    })

    const upstreamIds = graph.edges
      .filter((e) => e.target === revB.id)
      .map((e) => e.source)
      .sort()
    expect(upstreamIds).toEqual([asm1.id, asm2.id].sort())
  })

  describe('query complexity', () => {
    /** root → `width` children → `width * 4` grandchildren. */
    async function seedTree(prefix: string, width: number) {
      const root = await insertItemRow({
        itemNumber: `${prefix}-ROOT`,
        name: 'Root',
      })
      let grandchildCount = 0
      for (let i = 0; i < width; i++) {
        const child = await insertItemRow({
          itemNumber: `${prefix}-C${i}`,
          name: `Child ${i}`,
        })
        await insertBomEdge(root.id, child.id)
        for (let j = 0; j < 4; j++) {
          const grandchild = await insertItemRow({
            itemNumber: `${prefix}-C${i}-G${j}`,
            name: `Grandchild ${i}.${j}`,
          })
          await insertBomEdge(child.id, grandchild.id)
          grandchildCount++
        }
      }
      return { root, total: 1 + width + grandchildCount }
    }

    async function countQueries(rootId: string): Promise<number> {
      queryCounter.selects = 0
      await GraphService.buildItemGraph(rootId, {
        ...walkDefaults,
        // Usage lookups off so the count below is the walk's floor; the
        // O(depth) equality assertion is what actually guards the batch
        // structure, with usages on or off.
        includeUsages: false,
      })
      return queryCounter.selects
    }

    it('issues O(depth) queries — a tenfold-wider graph costs the same', async () => {
      const prefix = `GS-${Date.now()}`
      const small = await seedTree(`${prefix}-S`, 1) // 6 nodes
      const wide = await seedTree(`${prefix}-W`, 10) // 51 nodes
      expect(wide.total).toBeGreaterThanOrEqual(50)

      const smallCount = await countQueries(small.root.id)
      const wideCount = await countQueries(wide.root.id)

      // The invariant: query count depends on depth, never on node count.
      expect(wideCount).toBe(smallCount)
      // And the depth-2 walk stays within the batched budget.
      expect(wideCount).toBeLessThanOrEqual(15)
    })

    it('returns identical output across repeated walks of the same graph', async () => {
      const prefix = `GS-${Date.now()}`
      const { root } = await seedTree(`${prefix}-D`, 3)

      const first = await GraphService.buildItemGraph(root.id, walkDefaults)
      const second = await GraphService.buildItemGraph(root.id, walkDefaults)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    })
  })
})
