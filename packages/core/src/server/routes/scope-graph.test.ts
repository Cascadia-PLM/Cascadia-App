// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Scope graph endpoints — Program/Design drill-down graph views
 *
 * Security gate: both endpoints expose cross-item structure, so they must
 * enforce program membership (designs via requireDesignAccess, programs via
 * membership with a global-permission fallback).
 *
 * Complex-algorithm gate: the design graph shows only top-level items — a
 * candidate is hidden when another candidate points at it, and "candidate"
 * is scoped by the item type filter. Invariants:
 *   - an item nested under a shown item stays hidden until its parent is
 *     expanded (via the item graph endpoint)
 *   - narrowing the type filter re-roots the hierarchy: an item nested only
 *     under a filtered-out type surfaces as top-level
 *   - availableItemTypes counts the whole design, not just top-level items
 *
 * Run: npx vitest run src/server/routes/scope-graph.test.ts
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
import designsRoutes from './designs'
import programsRoutes from './programs'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { itemRelationships } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ScopeNode {
  id: string
  type: string
  data: { kind?: string; itemType?: string; itemNumber?: string }
}
interface ScopeEdge {
  id: string
  source: string
  target: string
  data: { relationshipType: string; isScopeRelationship?: boolean }
}
interface ScopeResponse {
  data: {
    nodes: Array<ScopeNode>
    edges: Array<ScopeEdge>
    availableItemTypes: Array<{ itemType: string; count: number }>
  }
}

describe('scope graph endpoints (programs/designs)', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/designs', designsRoutes)
    .route('/api/v1/programs', programsRoutes)

  let member: TestUser
  let outsider: TestUser
  let memberCookie: string
  let outsiderCookie: string
  let programId: string
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)

    const program = await ProgramService.create(
      { name: 'Scope Program', code: `SCOPE-${Date.now()}` },
      member.id,
    )
    programId = program.id

    const design = await DesignService.create(
      {
        programId,
        name: 'Scope Design',
        code: `SCOPED-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )
    designId = design.id

    memberCookie = `session=${(await SessionManager.createSession(member.id)).sessionToken}`
    outsiderCookie = `session=${(await SessionManager.createSession(outsider.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(name: string) {
    const part = await ItemService.create(
      'Part',
      { designId, revision: 'A', name, partType: 'Manufacture' } as any,
      member.id,
    )
    return part as { id: string }
  }

  /**
   * Assembly with a nested child part (BOM) and a document nested under the
   * assembly (References). Only the assembly is top-level with no filter.
   */
  async function buildDesignContent() {
    const assembly = await createPart('Assembly')
    const child = await createPart('Child')
    const doc = (await ItemService.create(
      'Document',
      { designId, revision: 'A', name: 'Spec' } as any,
      member.id,
    )) as { id: string }

    await testDb.db.insert(itemRelationships).values([
      {
        sourceId: assembly.id,
        targetId: child.id,
        relationshipType: 'BOM',
        createdBy: member.id,
      },
      {
        sourceId: assembly.id,
        targetId: doc.id,
        relationshipType: 'References',
        createdBy: member.id,
      },
    ])

    return { assembly, child, doc }
  }

  async function fetchDesignGraph(params = '', cookie = memberCookie) {
    return app.request(`/api/v1/designs/${designId}/graph${params}`, {
      headers: { cookie },
    })
  }

  it('denies the design graph to non-members of the owning program', async () => {
    const response = await fetchDesignGraph('', outsiderCookie)
    expect(response.status).toBe(403)
  })

  it('denies the program graph to non-members without global permission', async () => {
    const response = await app.request(`/api/v1/programs/${programId}/graph`, {
      headers: { cookie: outsiderCookie },
    })
    expect(response.status).toBe(403)
  })

  it('shows the program above the design and only top-level items below it', async () => {
    const { assembly, child, doc } = await buildDesignContent()

    const response = await fetchDesignGraph()
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as ScopeResponse

    const designNode = `design:${designId}`
    const programNode = `program:${programId}`
    const nodeIds = data.nodes.map((n) => n.id)

    // Program → design containment
    expect(nodeIds).toContain(programNode)
    expect(nodeIds).toContain(designNode)
    expect(
      data.edges.some(
        (e) => e.source === programNode && e.target === designNode,
      ),
    ).toBe(true)

    // Only the assembly is top-level; child and referenced doc stay hidden
    // until the assembly is expanded through the item graph endpoint
    expect(nodeIds).toContain(assembly.id)
    expect(nodeIds).not.toContain(child.id)
    expect(nodeIds).not.toContain(doc.id)
    expect(
      data.edges.some(
        (e) => e.source === designNode && e.target === assembly.id,
      ),
    ).toBe(true)

    // Type counts cover the whole design, not just top-level items
    const counts = Object.fromEntries(
      data.availableItemTypes.map((t) => [t.itemType, t.count]),
    )
    expect(counts.Part).toBe(2)
    expect(counts.Document).toBe(1)
  })

  it('re-roots the hierarchy when the type filter excludes the parent type', async () => {
    const { assembly, child, doc } = await buildDesignContent()

    // Documents only: the doc's part parent is filtered out, so the doc
    // surfaces as a top-level item of the design
    const docsOnly = await fetchDesignGraph('?itemTypes=Document')
    expect(docsOnly.status).toBe(200)
    const docsData = ((await docsOnly.json()) as ScopeResponse).data
    const docsNodeIds = docsData.nodes.map((n) => n.id)
    expect(docsNodeIds).toContain(doc.id)
    expect(docsNodeIds).not.toContain(assembly.id)
    expect(docsNodeIds).not.toContain(child.id)

    // Parts only: the child stays nested under the shown assembly
    const partsOnly = await fetchDesignGraph('?itemTypes=Part')
    expect(partsOnly.status).toBe(200)
    const partsData = ((await partsOnly.json()) as ScopeResponse).data
    const partsNodeIds = partsData.nodes.map((n) => n.id)
    expect(partsNodeIds).toContain(assembly.id)
    expect(partsNodeIds).not.toContain(child.id)
    expect(partsNodeIds).not.toContain(doc.id)
  })

  it('returns the program with its designs as nodes', async () => {
    const response = await app.request(`/api/v1/programs/${programId}/graph`, {
      headers: { cookie: memberCookie },
    })
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as ScopeResponse

    const nodeIds = data.nodes.map((n) => n.id)
    expect(nodeIds).toContain(`program:${programId}`)
    expect(nodeIds).toContain(`design:${designId}`)
    expect(
      data.edges.some(
        (e) =>
          e.source === `program:${programId}` &&
          e.target === `design:${designId}` &&
          e.data.isScopeRelationship === true,
      ),
    ).toBe(true)
  })
})
