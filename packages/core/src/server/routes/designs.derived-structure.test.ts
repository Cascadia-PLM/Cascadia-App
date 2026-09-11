// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * A derived design shows its structure, whichever way its writer recorded it
 *
 * Data-integrity gate, and a seam rather than a service. Three writers derive
 * a whole design from existing items — `MbomService` (Release to
 * Manufacturing), the design-clone job, and `UsageService.createUsageSubtree`
 * ("use this assembly in my design") — and all three create their items at the
 * unreleased revision marker `-`, because no merge ever assigns such an item a
 * letter. That marker is what `GET /designs/:id/structure` excludes from its
 * `isCurrent` baseline, to keep a change order's drafts from being served as
 * main's contents. So none of the three is visible to that baseline, and each
 * depends on a further source — and they do not agree on which:
 *
 *   - the design clone writes `branch_items` rows on the new design's main
 *     branch *and* a commit through `CommitService.create`, so it is reachable
 *     two ways;
 *   - `UsageService.createUsageSubtree` writes `branch_items` only;
 *   - `MbomService` writes neither, recording its contents as `item_versions`
 *     on an initial commit of its own — which the endpoint did not read, and
 *     which is why an MBOM's Design Structure tab was blank for three weeks
 *     while clone and usage copy worked.
 *
 * Correctness therefore rested on which recording convention a writer happened
 * to pick, and no test pinned it: each writer was tested against its own rows,
 * and the reader against fixtures it built itself at revision `A`. These tests
 * close the other two sides of that seam — the MBOM side is
 * `designs.mbom-structure.test.ts` — so the accident is no longer
 * load-bearing. Both are checked by mutation: deleting the endpoint's
 * `branch_items` overlay fails the usage-copy case, and deleting its
 * commit resolution fails the MBOM ones.
 *
 * Run: npx vitest run src/server/routes/designs.derived-structure.test.ts
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
} from 'vitest'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import designsRoutes from './designs'
import type { JobContext } from '@/lib/jobs/types'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BOMTreeNode, OrphanItem } from '@/lib/types/bom'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { UsageService } from '@/lib/services/UsageService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { cloneDesignHandler } from '@/lib/jobs/node-handlers/design-clone'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { items } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

/** A context that records nothing — progress and log calls are not under test. */
function jobContext(): JobContext {
  return {
    jobId: randomUUID(),
    attempt: 1,
    updateProgress: () => Promise.resolve(),
    log: {
      debug: () => Promise.resolve(),
      info: () => Promise.resolve(),
      warn: () => Promise.resolve(),
      error: () => Promise.resolve(),
    },
    signal: new AbortController().signal,
  }
}

interface StructureResponse {
  data: { roots: Array<BOMTreeNode>; orphans: Array<OrphanItem> }
}

type CreatedPart = { id: string; masterId: string; itemNumber: string }

describe('a derived design shows its structure', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/designs', designsRoutes)

  let user: TestUser
  let cookie: string
  let programId: string
  let sourceDesignId: string
  let sourceDesignCode: string
  let unique: string

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

    unique = `DS${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = (await insertTestUserWithRole(testDb.db, 'User')).user
    permissionService.clearCache()

    const program = await ProgramService.create(
      { name: 'Derived Structure Program', code: `DSP-${unique}` },
      user.id,
    )
    programId = program.id

    sourceDesignCode = `SRC-${unique}`
    const design = await DesignService.create(
      {
        programId,
        name: 'Derived Structure Source',
        code: sourceDesignCode,
        designType: 'Engineering',
      },
      user.id,
    )
    sourceDesignId = design.id

    cookie = `session=${(await SessionManager.createSession(user.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(suffix: string) {
    return (await ItemService.create(
      'Part',
      {
        itemNumber: `${suffix}-${sourceDesignCode}`,
        revision: 'A',
        name: `Part ${suffix}`,
        designId: sourceDesignId,
        state: 'Draft',
      } as never,
      user.id,
    )) as CreatedPart
  }

  /**
   * A BOM line through the service every editor and importer uses — which is
   * what withdraws the child's top-level designation. Inserting the row
   * directly leaves the child designated and hides half of the rule.
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

  /** An assembly over one child, the way the BOM editor builds one. */
  async function seedSourceBom() {
    const assembly = await createPart('ASSY')
    const child = await createPart('CHILD')
    await nest(assembly.id, child.id)
    return { assembly, child }
  }

  async function fetchStructure(designId: string) {
    const response = await app.request(
      `/api/v1/designs/${designId}/structure`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as StructureResponse).data
  }

  function flatten(nodes: Array<BOMTreeNode>): Array<BOMTreeNode> {
    return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])])
  }
  const rootNames = (view: { roots: Array<BOMTreeNode> }) =>
    view.roots.map((r) => r.name).sort()
  const nestedNames = (view: { roots: Array<BOMTreeNode> }) =>
    flatten(view.roots)
      .filter((n) => n.relationshipId !== undefined)
      .map((n) => n.name)
      .sort()

  async function partsIn(designId: string) {
    return testDb.db
      .select({
        itemNumber: items.itemNumber,
        name: items.name,
        revision: items.revision,
        inDesignStructure: items.inDesignStructure,
      })
      .from(items)
      .where(eq(items.designId, designId))
  }

  /**
   * The hazard both writers share with the MBOM one: their items carry the
   * unreleased marker permanently, so the structure endpoint's `isCurrent`
   * baseline cannot see them and they are visible only through a second
   * source. If this stops being true the risk changes, and the tests below
   * are no longer testing what they were written for.
   */
  function expectUnreleasedMarker(
    rows: Array<{ revision: string; name: string | null }>,
  ) {
    for (const row of rows) {
      expect(row.revision.startsWith('-')).toBe(true)
    }
  }

  // ==========================================================================
  // Design clone
  // ==========================================================================

  describe('design clone', () => {
    it('shows the cloned assembly as a top-level part, with its child under it', async () => {
      await seedSourceBom()

      const result = await cloneDesignHandler.execute(
        {
          sourceDesignId,
          targetCode: `TGT-${unique}`,
          targetName: 'Cloned Design',
          userId: user.id,
        },
        jobContext(),
      )

      const cloned = await partsIn(result.designId)
      expect(cloned).toHaveLength(2)
      expectUnreleasedMarker(cloned)

      const view = await fetchStructure(result.designId)

      expect(rootNames(view)).toEqual(['Part ASSY'])
      expect(nestedNames(view)).toEqual(['Part CHILD'])
    })

    it('leaves no cloned item stranded: each is a root, nested, or a listed non-structure item', async () => {
      await seedSourceBom()
      // A part in no BOM at all, which the clone carries across too.
      await createPart('LOOSE')

      const result = await cloneDesignHandler.execute(
        {
          sourceDesignId,
          targetCode: `TGT-${unique}`,
          targetName: 'Cloned Design',
          userId: user.id,
        },
        jobContext(),
      )

      const cloned = await partsIn(result.designId)
      expect(cloned).toHaveLength(3)

      const view = await fetchStructure(result.designId)
      const accountedFor = new Set([
        ...flatten(view.roots).map((n) => n.itemNumber),
        ...view.orphans.map((o) => o.itemNumber),
      ])
      for (const row of cloned) {
        expect(accountedFor).toContain(row.itemNumber)
      }
    })

    it('carries the designation across: the assembly is top-level, its child is not', async () => {
      await seedSourceBom()

      const result = await cloneDesignHandler.execute(
        {
          sourceDesignId,
          targetCode: `TGT-${unique}`,
          targetName: 'Cloned Design',
          userId: user.id,
        },
        jobContext(),
      )

      const byName = new Map(
        (await partsIn(result.designId)).map((row) => [row.name, row]),
      )
      expect(byName.get('Part ASSY')?.inDesignStructure).toBe(true)
      expect(byName.get('Part CHILD')?.inDesignStructure).toBe(false)
    })
  })

  // ==========================================================================
  // Usage subtree copy — "use this assembly in my design"
  // ==========================================================================

  describe('usage subtree copy', () => {
    async function targetDesign() {
      return DesignService.create(
        {
          programId,
          name: 'Usage Target',
          code: `UTG-${unique}`,
          designType: 'Engineering',
        },
        user.id,
      )
    }

    it('shows the copied root as a top-level part of the target, with its child under it', async () => {
      const { assembly } = await seedSourceBom()
      const target = await targetDesign()

      await UsageService.createUsageSubtree(
        { rootItemId: assembly.id, targetDesignId: target.id },
        user.id,
      )

      const copied = await partsIn(target.id)
      expect(copied).toHaveLength(2)
      expectUnreleasedMarker(copied)

      const view = await fetchStructure(target.id)

      expect(rootNames(view)).toEqual(['Part ASSY'])
      expect(nestedNames(view)).toEqual(['Part CHILD'])
      expect(view.orphans).toHaveLength(0)
    })

    it('designates the subtree root only — everything below it arrives as a child', async () => {
      const { assembly } = await seedSourceBom()
      const target = await targetDesign()

      await UsageService.createUsageSubtree(
        { rootItemId: assembly.id, targetDesignId: target.id },
        user.id,
      )

      const byName = new Map(
        (await partsIn(target.id)).map((row) => [row.name, row]),
      )
      expect(byName.get('Part ASSY')?.inDesignStructure).toBe(true)
      expect(byName.get('Part CHILD')?.inDesignStructure).toBe(false)
    })

    it('leaves the source design’s own structure alone', async () => {
      const { assembly } = await seedSourceBom()
      const target = await targetDesign()

      await UsageService.createUsageSubtree(
        { rootItemId: assembly.id, targetDesignId: target.id },
        user.id,
      )

      // Copying an assembly into another design does not un-designate it, or
      // otherwise disturb the design it was copied from.
      const view = await fetchStructure(sourceDesignId)
      expect(rootNames(view)).toEqual(['Part ASSY'])
      expect(nestedNames(view)).toEqual(['Part CHILD'])
    })
  })
})
