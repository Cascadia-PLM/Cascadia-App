// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Release to Manufacturing: the MBOM a design page can actually show
 *
 * Data-integrity gate, and a seam rather than a service. `MbomService` writes
 * the MBOM and `GET /designs/:id/structure` reads it, and each side was fully
 * tested against its own rows while nothing asserted that the reader could
 * see what the writer wrote. The two then disagreed for three weeks: MBOM
 * usages carry `revision: '-'` permanently (there is no merge to assign them
 * a letter), and the structure endpoint's main-branch baseline excludes
 * `notWorkingRevision()` — `revision LIKE '-%'` — to keep a change order's
 * unreleased drafts from being served as main's contents. Every copied item
 * matched that exclusion, and `MbomService` writes no `branch_items` rows for
 * the endpoint's other source to find either, so it returned an empty
 * structure: the Design Structure tab on a freshly created MBOM was blank
 * while the items were plainly listed on the design's items tab.
 *
 * These tests span the seam in the direction the bug ran: create the MBOM the
 * way the Release to Manufacturing dialog does, then ask the endpoint the
 * design page asks.
 *
 * Run: npx vitest run src/server/routes/designs.mbom-structure.test.ts
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
import { eq } from 'drizzle-orm'
import designsRoutes from './designs'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BOMTreeNode, OrphanItem } from '@/lib/types/bom'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { MbomService } from '@/lib/services/MbomService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { items } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface StructureResponse {
  data: { roots: Array<BOMTreeNode>; orphans: Array<OrphanItem> }
}

type CreatedPart = { id: string; masterId: string; itemNumber: string }

describe('release to manufacturing: the MBOM shows its structure', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/designs', designsRoutes)

  let user: TestUser
  let cookie: string
  let programId: string
  let ebomDesignId: string
  let ebomDesignCode: string
  let unique: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    unique = `MB${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = (await insertTestUserWithRole(testDb.db, 'User')).user
    permissionService.clearCache()

    const program = await ProgramService.create(
      { name: 'MBOM Structure Program', code: `MBP-${unique}` },
      user.id,
    )
    programId = program.id

    ebomDesignCode = `EB-${unique}`
    const design = await DesignService.create(
      {
        programId,
        name: 'Source EBOM',
        code: ebomDesignCode,
        designType: 'Engineering',
      },
      user.id,
    )
    ebomDesignId = design.id

    cookie = `session=${(await SessionManager.createSession(user.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(suffix: string) {
    return (await ItemService.create(
      'Part',
      {
        itemNumber: `${suffix}-${ebomDesignCode}`,
        revision: 'A',
        name: `Part ${suffix}`,
        designId: ebomDesignId,
        state: 'Draft',
      } as any,
      user.id,
    )) as CreatedPart
  }

  /**
   * A BOM line through the service every editor and importer uses — which is
   * what withdraws the child's top-level designation. Inserting the row
   * directly leaves the child designated and hides that half of the rule.
   */
  async function nest(parentId: string, childId: string) {
    return ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      { quantity: '2' },
      { bypassEditGuard: true },
    )
  }

  /** An assembly over two children, the way the BOM editor builds one. */
  async function seedEbom() {
    const assembly = await createPart('ASSY')
    const childA = await createPart('CHILDA')
    const childB = await createPart('CHILDB')
    await nest(assembly.id, childA.id)
    await nest(assembly.id, childB.id)
    return { assembly, childA, childB }
  }

  function createMbom(overrides: Record<string, unknown> = {}) {
    return MbomService.createFromEbom(
      {
        sourceDesignId: ebomDesignId,
        name: 'Derived MBOM',
        code: `MB-${unique}`,
        copyBomStructure: true,
        linkToSource: true,
        renumberItems: true,
        ...overrides,
      },
      user.id,
    )
  }

  async function fetchStructure(designId: string, query = '') {
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
  const rootNumbers = (view: { roots: Array<BOMTreeNode> }) =>
    view.roots.map((r) => r.itemNumber).sort()
  const nestedNumbers = (view: { roots: Array<BOMTreeNode> }) =>
    flatten(view.roots)
      .filter((n) => n.relationshipId !== undefined)
      .map((n) => n.itemNumber)
      .sort()

  it('shows the copied assembly as a top-level part, with its children under it', async () => {
    await seedEbom()
    const result = await createMbom()
    expect(result.itemsCopied).toBe(3)

    const view = await fetchStructure(result.design.id)

    // The renumbered twins: the MBOM code replaces the EBOM code suffix.
    expect(rootNumbers(view)).toEqual([`ASSY-MB-${unique}`])
    expect(nestedNumbers(view)).toEqual([
      `CHILDA-MB-${unique}`,
      `CHILDB-MB-${unique}`,
    ])
  })

  it('shows the structure at the MBOM main branch the design page asks for by id', async () => {
    await seedEbom()
    const result = await createMbom()

    const view = await fetchStructure(
      result.design.id,
      `?branch=${result.mainBranch.id}`,
    )

    expect(rootNumbers(view)).toEqual([`ASSY-MB-${unique}`])
    expect(nestedNumbers(view)).toEqual([
      `CHILDA-MB-${unique}`,
      `CHILDB-MB-${unique}`,
    ])
  })

  it('leaves no copied item stranded: every one is a root, nested, or a listed non-structure item', async () => {
    await seedEbom()
    const result = await createMbom()

    const copied = await testDb.db
      .select({ itemNumber: items.itemNumber })
      .from(items)
      .where(eq(items.designId, result.design.id))
    expect(copied).toHaveLength(3)

    const view = await fetchStructure(result.design.id)
    const accountedFor = new Set([
      ...flatten(view.roots).map((n) => n.itemNumber),
      ...view.orphans.map((o) => o.itemNumber),
    ])
    for (const row of copied) {
      expect(accountedFor).toContain(row.itemNumber)
    }
  })

  it('keeps the copied designation: the assembly is designated, its children are not', async () => {
    await seedEbom()
    const result = await createMbom()

    const copied = await testDb.db
      .select({
        itemNumber: items.itemNumber,
        inDesignStructure: items.inDesignStructure,
      })
      .from(items)
      .where(eq(items.designId, result.design.id))

    const byNumber = new Map(copied.map((r) => [r.itemNumber, r]))
    expect(byNumber.get(`ASSY-MB-${unique}`)?.inDesignStructure).toBe(true)
    expect(byNumber.get(`CHILDA-MB-${unique}`)?.inDesignStructure).toBe(false)
    expect(byNumber.get(`CHILDB-MB-${unique}`)?.inDesignStructure).toBe(false)
  })
})
