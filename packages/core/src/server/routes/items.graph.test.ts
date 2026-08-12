// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Items graph endpoint — derived-edge extension tests
 *
 * Complex-algorithm gate: the graph walk stitches stored relationships
 * with edges derived from columns (physical_parts.partMasterId,
 * work_orders.partId, vault_files.itemId) under direction, depth, and
 * type filters. Fixture for the physical domain is the canonical
 * traceability chain:
 *
 *   component units C-1, C-2 produced by WO-comp
 *     └─ C-1 consumed by WO-asm → produces assembly unit A-1
 *
 * Invariants: from a part the graph reaches its work orders and physical
 * instances through top-down BUILDS/INSTANCE_OF edges; upstream expansion
 * of a work order reaches the part it builds; direction filters gate the
 * derived edges the same way they gate stored ones.
 *
 * The attached-files block covers the opt-in ATTACHED_FILE extension:
 * files ride one level below their owning item (so drill-down expansion
 * reveals them), and visibility mirrors the Files tab (latest version,
 * not deleted, not a generated thumbnail, branch-visible).
 *
 * Run: npx vitest run src/server/routes/items.graph.test.ts
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
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { WorkOrderMaterialService } from '@/lib/services/WorkOrderMaterialService'
import { SessionManager } from '@/lib/auth/session'
import {
  branches,
  itemRelationships,
  programs,
  vaultFiles,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface GraphNode {
  id: string
  type: string
  data: {
    itemType?: string
    itemNumber?: string
    // fileNode payload
    fileName?: string
    fileCategory?: string | null
    isPrimaryModel?: boolean
    fileVersion?: number
    level?: number
  }
}
interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
  data: {
    relationshipType: string
    isPhysicalRelationship?: boolean
    isFileRelationship?: boolean
  }
}

describe('GET /api/items/:id/graph — derived domains', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)
  let user: TestUser
  let designId: string
  let cookie: string

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
          name: 'Test Program',
          code: `PROG-${Date.now()}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Test Design',
        code: `DESIGN-${Date.now()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id

    const { sessionToken } = await SessionManager.createSession(user.id)
    cookie = `session=${sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(name: string, trackingMode: 'none' | 'serial') {
    const part = await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name,
        partType: 'Manufacture',
        trackingMode,
      } as any,
      user.id,
    )
    return part as { id?: string; masterId?: string }
  }

  /** Component units built by WO-comp; C-1 consumed into assembly A-1. */
  async function buildChain() {
    const component = await createPart('Component', 'serial')
    const assembly = await createPart('Assembly', 'serial')

    const woComp = await WorkOrderService.create(
      { partId: component.id, quantity: 2, assignedTo: [] } as any,
      user.id,
    )
    const producedComponents = await WorkOrderMaterialService.produce(
      woComp.id,
      ['C-1', 'C-2'],
      user.id,
    )

    const woAsm = await WorkOrderService.create(
      { partId: assembly.id, quantity: 1, assignedTo: [] } as any,
      user.id,
    )
    await WorkOrderMaterialService.consume(
      woAsm.id,
      { partMasterId: component.masterId!, serialNumber: 'C-1' },
      user.id,
    )
    const producedAssemblies = await WorkOrderMaterialService.produce(
      woAsm.id,
      ['A-1'],
      user.id,
    )

    return {
      component,
      assembly,
      woComp,
      woAsm,
      c1: producedComponents.find((u) => u.serialNumber === 'C-1')!,
      assemblyUnit: producedAssemblies[0]!,
    }
  }

  async function fetchGraph(itemId: string, params = 'depth=3') {
    const response = await app.request(
      `/api/v1/items/${itemId}/graph?${params}`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    return (await response.json()) as {
      nodes: Array<GraphNode>
      edges: Array<GraphEdge>
    }
  }

  const findEdge = (
    edges: Array<GraphEdge>,
    source: string,
    target: string,
    type: string,
  ) =>
    edges.find(
      (e) =>
        e.source === source &&
        e.target === target &&
        e.data.relationshipType === type,
    )

  it('reaches work orders and physical instances from a part via top-down derived edges', async () => {
    const chain = await buildChain()

    const graph = await fetchGraph(chain.assembly.id!)
    const nodeIds = graph.nodes.map((n) => n.id)

    // Physical web is present: the building WO, the produced unit, and —
    // one hop further through C-1 — the component chain.
    expect(nodeIds).toContain(chain.woAsm.id)
    expect(nodeIds).toContain(chain.assemblyUnit.unitItemId)
    expect(nodeIds).toContain(chain.c1.unitItemId)

    // Derived edges point top-down (part above) and are flagged.
    const builds = findEdge(
      graph.edges,
      chain.assembly.id!,
      chain.woAsm.id,
      'BUILDS',
    )
    expect(builds).toBeDefined()
    expect(builds!.label).toBe('built by')
    expect(builds!.data.isPhysicalRelationship).toBe(true)

    const instance = findEdge(
      graph.edges,
      chain.assembly.id!,
      chain.assemblyUnit.unitItemId,
      'INSTANCE_OF',
    )
    expect(instance).toBeDefined()
    expect(instance!.label).toBe('instance')

    // Stored physical edges keep their WO-as-source direction.
    expect(
      findEdge(
        graph.edges,
        chain.woAsm.id,
        chain.assemblyUnit.unitItemId,
        'Produces',
      ),
    ).toBeDefined()
    expect(
      findEdge(graph.edges, chain.woAsm.id, chain.c1.unitItemId, 'Consumes'),
    ).toBeDefined()
  })

  it('links a physical unit back to its part lineage when walked from the physical side', async () => {
    const chain = await buildChain()

    const graph = await fetchGraph(chain.c1.unitItemId, 'depth=2')
    const nodeIds = graph.nodes.map((n) => n.id)

    expect(nodeIds).toContain(chain.component.id)
    expect(
      findEdge(
        graph.edges,
        chain.component.id!,
        chain.c1.unitItemId,
        'INSTANCE_OF',
      ),
    ).toBeDefined()
  })

  it('gates derived edges by direction like stored ones', async () => {
    const chain = await buildChain()

    // Downstream (outgoing) from the part reveals its physical web.
    const outgoing = await fetchGraph(
      chain.assembly.id!,
      'depth=1&direction=outgoing',
    )
    expect(outgoing.nodes.map((n) => n.id)).toContain(chain.woAsm.id)
    expect(outgoing.nodes.map((n) => n.id)).toContain(
      chain.assemblyUnit.unitItemId,
    )

    // Upstream (incoming) from the part must not.
    const incoming = await fetchGraph(
      chain.assembly.id!,
      'depth=1&direction=incoming',
    )
    expect(
      incoming.edges.some(
        (e) =>
          e.data.relationshipType === 'BUILDS' ||
          e.data.relationshipType === 'INSTANCE_OF',
      ),
    ).toBe(false)

    // Upstream from the work order reaches the part it builds, without
    // dragging in its consumed/produced material (outgoing edges).
    const woUpstream = await fetchGraph(
      chain.woAsm.id,
      'depth=1&direction=incoming',
    )
    expect(woUpstream.nodes.map((n) => n.id)).toContain(chain.assembly.id)
    expect(
      findEdge(woUpstream.edges, chain.assembly.id!, chain.woAsm.id, 'BUILDS'),
    ).toBeDefined()
    expect(
      woUpstream.edges.some((e) => e.data.relationshipType === 'Produces'),
    ).toBe(false)
  })

  it('honors the relationship type filter for derived edges', async () => {
    const chain = await buildChain()

    const graph = await fetchGraph(
      chain.assembly.id!,
      'depth=1&types=INSTANCE_OF',
    )
    expect(
      graph.edges.every((e) => e.data.relationshipType === 'INSTANCE_OF'),
    ).toBe(true)
    expect(graph.nodes.map((n) => n.id)).toContain(
      chain.assemblyUnit.unitItemId,
    )
    expect(graph.nodes.map((n) => n.id)).not.toContain(chain.woAsm.id)
  })

  describe('attached files', () => {
    async function insertFile(
      itemId: string,
      overrides: Partial<typeof vaultFiles.$inferInsert> = {},
    ) {
      return takeFirst(
        await testDb.db
          .insert(vaultFiles)
          .values({
            itemId,
            fileName: 'bracket.step',
            originalFileName: 'bracket.step',
            fileSize: 2048,
            mimeType: 'application/step',
            fileHash: 'a'.repeat(64),
            storagePath: `test/${crypto.randomUUID()}/bracket.step`,
            uploadedBy: user.id,
            ...overrides,
          })
          .returning(),
      )
    }

    async function insertBranch(name: string) {
      return takeFirst(
        await testDb.db
          .insert(branches)
          .values({
            designId,
            name,
            branchType: 'eco',
            createdBy: user.id,
          })
          .returning(),
      )
    }

    /** Assembly —BOM→ component, each carrying one attached file. */
    async function buildPartsWithFiles() {
      const assembly = await createPart('Assembly', 'none')
      const component = await createPart('Component', 'none')
      await testDb.db.insert(itemRelationships).values({
        sourceId: assembly.id!,
        targetId: component.id!,
        relationshipType: 'BOM',
        createdBy: user.id,
      })
      const assemblyFile = await insertFile(assembly.id!, {
        originalFileName: 'assembly.step',
        fileCategory: 'cad_model',
        isPrimaryModel: true,
      })
      const componentFile = await insertFile(component.id!, {
        originalFileName: 'component.step',
      })
      return { assembly, component, assemblyFile, componentFile }
    }

    it('emits file nodes and item→file edges only when opted in', async () => {
      const { assembly, assemblyFile } = await buildPartsWithFiles()

      const without = await fetchGraph(assembly.id!, 'depth=1')
      expect(without.nodes.some((n) => n.type === 'fileNode')).toBe(false)
      expect(
        without.edges.some((e) => e.data.relationshipType === 'ATTACHED_FILE'),
      ).toBe(false)

      const graph = await fetchGraph(assembly.id!, 'depth=1&includeFiles=true')
      const fileNode = graph.nodes.find((n) => n.id === assemblyFile.id)
      expect(fileNode).toBeDefined()
      expect(fileNode!.type).toBe('fileNode')
      expect(fileNode!.data.fileName).toBe('assembly.step')
      expect(fileNode!.data.fileCategory).toBe('cad_model')
      expect(fileNode!.data.isPrimaryModel).toBe(true)
      expect(fileNode!.data.level).toBe(1)

      const edge = findEdge(
        graph.edges,
        assembly.id!,
        assemblyFile.id,
        'ATTACHED_FILE',
      )
      expect(edge).toBeDefined()
      expect(edge!.label).toBe('file')
      expect(edge!.data.isFileRelationship).toBe(true)
    })

    it('keeps files one level below their owner so drill-down reveals them', async () => {
      const { assembly, component, componentFile } = await buildPartsWithFiles()

      // Frontier items (level === depth) contribute no files...
      const fromAssembly = await fetchGraph(
        assembly.id!,
        'depth=1&includeFiles=true',
      )
      expect(fromAssembly.nodes.map((n) => n.id)).toContain(component.id)
      expect(fromAssembly.nodes.map((n) => n.id)).not.toContain(
        componentFile.id,
      )

      // ...a deeper walk reaches them...
      const deeper = await fetchGraph(assembly.id!, 'depth=2&includeFiles=true')
      expect(deeper.nodes.map((n) => n.id)).toContain(componentFile.id)

      // ...and so does the drill-down expansion the panel issues for a node.
      const drillDown = await fetchGraph(
        component.id!,
        'depth=1&direction=outgoing&includeFiles=true',
      )
      expect(drillDown.nodes.map((n) => n.id)).toContain(componentFile.id)
      expect(
        findEdge(
          drillDown.edges,
          component.id!,
          componentFile.id,
          'ATTACHED_FILE',
        ),
      ).toBeDefined()
    })

    it('hides superseded, deleted, and thumbnail files', async () => {
      const part = await createPart('Housing', 'none')
      const superseded = await insertFile(part.id!, {
        isLatestVersion: false,
      })
      const deleted = await insertFile(part.id!, {
        deletedAt: new Date(),
        deletedBy: user.id,
      })
      const thumbnail = await insertFile(part.id!, {
        fileCategory: 'thumbnail',
      })
      const visible = await insertFile(part.id!, { fileVersion: 2 })

      const graph = await fetchGraph(part.id!, 'depth=1&includeFiles=true')
      const nodeIds = graph.nodes.map((n) => n.id)
      expect(nodeIds).toContain(visible.id)
      expect(nodeIds).not.toContain(superseded.id)
      expect(nodeIds).not.toContain(deleted.id)
      expect(nodeIds).not.toContain(thumbnail.id)
    })

    it('scopes branch-pinned files to the viewed branch', async () => {
      const part = await createPart('Bracket', 'none')
      const ecoBranch = await insertBranch(`eco/ECO-A-${Date.now()}`)
      const otherBranch = await insertBranch(`eco/ECO-B-${Date.now()}`)
      const globalFile = await insertFile(part.id!)
      const branchFile = await insertFile(part.id!, {
        branchId: ecoBranch.id,
      })

      // Viewed on the pinning branch: both visible.
      const onBranch = await fetchGraph(
        part.id!,
        `depth=1&includeFiles=true&branch=${ecoBranch.id}`,
      )
      expect(onBranch.nodes.map((n) => n.id)).toContain(globalFile.id)
      expect(onBranch.nodes.map((n) => n.id)).toContain(branchFile.id)

      // Viewed on a different branch: pinned file hidden.
      const elsewhere = await fetchGraph(
        part.id!,
        `depth=1&includeFiles=true&branch=${otherBranch.id}`,
      )
      expect(elsewhere.nodes.map((n) => n.id)).toContain(globalFile.id)
      expect(elsewhere.nodes.map((n) => n.id)).not.toContain(branchFile.id)

      // No branch context falls back to listing all files (Files tab parity).
      const noContext = await fetchGraph(part.id!, 'depth=1&includeFiles=true')
      expect(noContext.nodes.map((n) => n.id)).toContain(globalFile.id)
      expect(noContext.nodes.map((n) => n.id)).toContain(branchFile.id)
    })

    it('gates files by direction and relationship type filter', async () => {
      const { assembly, assemblyFile } = await buildPartsWithFiles()

      // Where-used walks (incoming) never show attachments.
      const incoming = await fetchGraph(
        assembly.id!,
        'depth=1&direction=incoming&includeFiles=true',
      )
      expect(incoming.nodes.some((n) => n.type === 'fileNode')).toBe(false)

      // Type filter excludes ATTACHED_FILE like any other type...
      const bomOnly = await fetchGraph(
        assembly.id!,
        'depth=1&includeFiles=true&types=BOM',
      )
      expect(bomOnly.nodes.some((n) => n.type === 'fileNode')).toBe(false)

      // ...and can select it exclusively.
      const filesOnly = await fetchGraph(
        assembly.id!,
        'depth=1&includeFiles=true&types=ATTACHED_FILE',
      )
      expect(
        filesOnly.edges.every(
          (e) => e.data.relationshipType === 'ATTACHED_FILE',
        ),
      ).toBe(true)
      expect(filesOnly.nodes.map((n) => n.id)).toContain(assemblyFile.id)
    })
  })
})
