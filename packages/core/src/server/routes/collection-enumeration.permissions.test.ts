// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Every collection route, enumerated — an outsider is served none of a
 * member's data
 *
 * Security gate, and the list-side twin of `by-id-enumeration`. That suite
 * asks whether a by-id route refuses a non-member; this one asks the harder
 * question a list route poses: not "may you reach this id" but "whose rows
 * come back when you name no id at all". A missing scope filter on a
 * collection is worse than a missing gate on an item, because the caller does
 * not even need to guess a UUID first.
 *
 * The list comes from the routers themselves, not from a hand-written table:
 * every GET whose composed path carries no `:` parameter — collection roots
 * plus static sub-paths like `/physical-parts/recall`. A collection route
 * added later is therefore enumerated automatically, and an unscoped one
 * fails this suite the day it lands.
 *
 * Two legs, and the second is what stops the first being vacuous.
 *
 * **Leak leg.** As an *outsider* — a user holding every RBAC verb but
 * belonging to no program — no 2xx response may contain any of the member's
 * fixture UUIDs. Matching against the response *text* keeps it shape-agnostic:
 * the envelopes differ wildly (`{items}`, `{files, count}`, `{physicalParts}`,
 * SysML projects) and none of that matters to "is this id in there". Two
 * deliberate narrowings, both non-disclosure rather than leniency: a non-2xx
 * body is not read, because a refusal or a validation error that echoes the
 * id back tells the caller only what they already typed; and an id the caller
 * itself named in the query string is discounted for that probe.
 *
 * **Anti-vacancy leg.** Without it the leak leg passes trivially — a route
 * that returns nothing to anybody leaks nothing. So each mapped collection
 * root must serve the *member* the fixture it is supposed to serve, and only
 * then is the outsider's empty answer evidence of anything.
 *
 * Reality note on the mapped set: the typed routers (`/parts`, `/documents`,
 * `/tasks`, …) register **no** collection root at all — every typed list is
 * `GET /api/v1/items?itemType=X`. So the per-item-type reachability the
 * anti-vacancy leg needs is proved there, one probe per entry of
 * `ITEM_TYPE_RESOURCES`, asserted exhaustive so a fourteenth item type fails
 * here until someone gives it a fixture.
 *
 * Two shrink-only maps, both keyed on the enumerated route label and both
 * asserted against the live enumeration so neither can outlive its route:
 *
 * - `ALLOWLIST` — routes whose 2xx legitimately names program data to
 *   everyone. Each entry carries the reason it is not a leak.
 * - `KNOWN_UNSCOPED` — confirmed leaks awaiting their scoping fix. These are
 *   asserted to *still* leak, so a stale entry fails the build the moment the
 *   fix lands and the map can only ever shrink.
 *
 * Scope: **core routers only.** Proprietary modules (design-engine,
 * advanced-auditing, odoo-integration) contribute their routes through
 * `registerRoutes` at composition time, and importing them here would break
 * `npm run boundary:check`. Their collection routes are therefore *not*
 * covered by this ratchet — the gap is real, and closing it needs a
 * module-side twin of this suite living in the app composition root.
 *
 * Companion suites, kept because enumeration cannot explain itself:
 * `program-isolation.permissions.test.ts` (the narrative version, on
 * items/change-orders/work-orders), `enterprise-search.permissions.test.ts`,
 * `manufacturer-parts.permissions.test.ts`.
 *
 * Run: npx vitest run packages/core/src/server/routes/collection-enumeration.permissions.test.ts
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
import adminRoutes from './admin'
import aiRoutes from './ai'
import branchItemsRoutes from './branch-items'
import branchesRoutes from './branches'
import changeOrdersRoutes from './change-orders'
import commitsRoutes from './commits'
import dashboardRoutes from './dashboard'
import designsRoutes from './designs'
import documentsRoutes from './documents'
import enterpriseSearchRoutes from './enterprise-search'
import filesRoutes from './files'
import importRoutes from './import'
import issuesRoutes from './issues'
import itemsRoutes from './items'
import jobsRoutes from './jobs'
import lifecyclesRoutes from './lifecycles'
import manufacturerPartsRoutes from './manufacturer-parts'
import mbomRoutes from './mbom'
import packagesRoutes from './packages'
import partsRoutes from './parts'
import physicalPartsRoutes from './physical-parts'
import programsRoutes from './programs'
import relationshipsRoutes from './relationships'
import reportsRoutes from './reports'
import requirementsRoutes from './requirements'
import rolesRoutes from './roles'
import softwareRoutes from './software'
import sysmlRoutes from './sysml'
import tagsRoutes from './tags'
import tasksRoutes from './tasks'
import testCasesRoutes from './test-cases'
import testPlansRoutes from './test-plans'
import threadRoutes from './thread'
import toolsRoutes from './tools'
import usersRoutes from './users'
import workInstructionsRoutes from './work-instructions'
import workOrdersRoutes from './work-orders'
import workflowsRoutes from './workflows'
import workspacesRoutes from './workspaces'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { BaseItem } from '@/lib/items/types/base'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { BranchService } from '@/lib/services/BranchService'
import { PhysicalPartService } from '@/lib/services/PhysicalPartService'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { RESOURCE_TYPES } from '@/lib/auth/permissions'
import { ITEM_TYPE_RESOURCES } from '@/lib/items/item-type-resources'
import { vaultFiles } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

/**
 * Hono publishes its registered routes. Not a contractual API, so the access
 * is pinned here: a Hono upgrade that changes the shape breaks one function.
 * The same helper as `by-id-enumeration.permissions.test.ts`, deliberately
 * duplicated rather than shared — a helper module both suites imported would
 * be one more thing to keep honest, and this is twenty lines.
 */
function registeredRoutes(
  router: Hono,
  mount: string,
): Array<{ method: string; path: string }> {
  const registered = (
    router as unknown as { routes: Array<{ method: string; path: string }> }
  ).routes

  const seen = new Set<string>()
  const out: Array<{ method: string; path: string }> = []
  for (const route of registered) {
    // Middleware registers itself as ALL; only real handlers are endpoints.
    if (route.method === 'ALL') continue
    const path = `${mount}${route.path === '/' ? '' : route.path}`
    const key = `${route.method} ${path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ method: route.method, path })
  }
  return out
}

/**
 * Collections that legitimately name a member's data to everyone.
 *
 * Not exemptions from scoping — statements that the rows are not program data
 * in the first place. Each entry needs its reason, and the list may only
 * shrink.
 */
const ALLOWLIST = new Map<string, string>([
  // Empty, and that is the point. The global catalogues this enumeration
  // reaches — workflows, roles, users, packages, admin config, the import
  // templates — hold no item, design or program rows at all, so they pass the
  // leak leg on their own and need no entry to do it.
])

/**
 * Confirmed leaks, each awaiting its scoping fix.
 *
 * Asserted to *still* leak, so the map can only shrink: the day a route here
 * is scoped, its entry goes stale and this suite goes red until the entry is
 * removed. That is what lets this ratchet land ahead of the fixes rather than
 * behind them.
 */
const KNOWN_UNSCOPED = new Map<string, string>([
  // Empty, and this is the state to keep it in. It shipped holding two
  // entries — `GET /api/v1/change-orders/editable` and
  // `GET /api/v1/designs/families`, both of which took no user at all — and
  // ISO-17 scoped them in the change that removed them from here. The pawl
  // did its job: the fix made both entries stale, which turned this suite red
  // until they went.
])

describe('collection routes, enumerated — outsider enumeration', () => {
  const testDb = new TestDatabase()

  /**
   * Every core router mounted by `server/index.ts`, less four: `auth` and
   * `setup` are unauthenticated by design, `health` serves no data, and `mcp`
   * is a JSON-RPC transport rather than a REST surface.
   */
  const MOUNTS: Array<{ mount: string; router: Hono }> = [
    { mount: '/api/v1/admin', router: adminRoutes },
    { mount: '/api/v1/ai', router: aiRoutes },
    { mount: '/api/v1/branch-items', router: branchItemsRoutes },
    { mount: '/api/v1/branches', router: branchesRoutes },
    { mount: '/api/v1/change-orders', router: changeOrdersRoutes },
    { mount: '/api/v1/commits', router: commitsRoutes },
    { mount: '/api/v1/dashboard', router: dashboardRoutes },
    { mount: '/api/v1/designs', router: designsRoutes },
    { mount: '/api/v1/documents', router: documentsRoutes },
    { mount: '/api/v1/enterprise-search', router: enterpriseSearchRoutes },
    { mount: '/api/v1/files', router: filesRoutes },
    { mount: '/api/v1/import', router: importRoutes },
    { mount: '/api/v1/issues', router: issuesRoutes },
    { mount: '/api/v1/items', router: itemsRoutes },
    { mount: '/api/v1/jobs', router: jobsRoutes },
    { mount: '/api/v1/lifecycles', router: lifecyclesRoutes },
    { mount: '/api/v1/manufacturer-parts', router: manufacturerPartsRoutes },
    { mount: '/api/v1/mbom', router: mbomRoutes },
    { mount: '/api/v1/packages', router: packagesRoutes },
    { mount: '/api/v1/parts', router: partsRoutes },
    { mount: '/api/v1/physical-parts', router: physicalPartsRoutes },
    { mount: '/api/v1/programs', router: programsRoutes },
    { mount: '/api/v1/relationships', router: relationshipsRoutes },
    { mount: '/api/v1/reports', router: reportsRoutes },
    { mount: '/api/v1/requirements', router: requirementsRoutes },
    { mount: '/api/v1/roles', router: rolesRoutes },
    { mount: '/api/v1/software', router: softwareRoutes },
    { mount: '/api/v1/sysml', router: sysmlRoutes },
    { mount: '/api/v1/tags', router: tagsRoutes },
    { mount: '/api/v1/tasks', router: tasksRoutes },
    { mount: '/api/v1/test-cases', router: testCasesRoutes },
    { mount: '/api/v1/test-plans', router: testPlansRoutes },
    { mount: '/api/v1/thread', router: threadRoutes },
    { mount: '/api/v1/tools', router: toolsRoutes },
    { mount: '/api/v1/users', router: usersRoutes },
    { mount: '/api/v1/work-instructions', router: workInstructionsRoutes },
    { mount: '/api/v1/work-orders', router: workOrdersRoutes },
    { mount: '/api/v1/workflows', router: workflowsRoutes },
    { mount: '/api/v1/workspaces', router: workspacesRoutes },
  ]

  const app = MOUNTS.reduce(
    (acc, { mount, router }) => acc.route(mount, router),
    new Hono(),
  )

  /** A probe of one enumerated collection route. */
  type Probe = {
    /** The enumerated route it drives — the key both maps are written in. */
    label: string
    /** Full request URL, query string included. */
    url: string
    /** Fixture id the member's answer must contain, on a mapped root. */
    serves?: string
  }

  let member: TestUser
  let outsider: TestUser
  const cookies = new Map<string, string>()

  /** Every fixture UUID an outsider must never be shown. */
  let leakIds: Array<string>
  /** Mapped collection roots, with the fixture each must serve the member. */
  let mappedProbes: Array<Probe>

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // Every verb on every resource except programs:manage — the cross-program
    // bypass. RBAC can therefore never be the reason an outsider sees less.
    const permissions: Record<string, Array<string>> = {}
    for (const resource of RESOURCE_TYPES) {
      permissions[resource] =
        resource === 'programs'
          ? ['read']
          : ['create', 'read', 'update', 'delete', 'manage']
    }
    const role = await insertTestRole(
      testDb.db,
      createCustomTestRole(
        `Everything But Programs ${randomUUID().slice(0, 8)}`,
        permissions,
      ),
    )

    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    for (const u of [member, outsider]) {
      await assignRoleToUser(testDb.db, u.id, role.id)
    }
    permissionService.clearCache()

    // A token unique to this run, planted in every fixture name so the
    // free-text search probes match this run's rows and nothing else's.
    const nonce = `ENUMTOK${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`

    // ProgramService.create enrols its creator; a direct insert does not.
    const program = await ProgramService.create(
      {
        name: `Collection Program ${nonce}`,
        code: `COLL-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: `Collection Design ${nonce}`,
        code: `COLLD-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )
    // A second design, of type Family: `GET /designs/families` filters on the
    // type, so an Engineering design alone would leave that route untested.
    const familyDesign = await DesignService.create(
      {
        programId: program.id,
        name: `Collection Family ${nonce}`,
        code: `COLLF-${Date.now()}`,
        designType: 'Family',
      },
      member.id,
    )

    const make = async <T extends BaseItem>(
      itemType: string,
      extra: Record<string, unknown> = {},
    ): Promise<string> => {
      const item = await ItemService.create<T>(
        itemType,
        {
          itemType,
          designId: design.id,
          revision: 'A',
          name: `Enumerated ${itemType} ${nonce}`,
          ...extra,
        } as unknown as T,
        member.id,
      )
      return item.id!
    }

    const partId = await make<Part>('Part', {
      partType: 'Manufacture',
      trackingMode: 'serial',
    })
    // Re-read for its masterId, which the physical-part fixture is keyed on.
    const part = await ItemService.findById(partId)
    if (!part?.masterId) throw new Error('part fixture has no masterId')

    // A BOM child, so `GET /relationships?designId=` has an edge to disclose.
    // Without one it answers `{ relationships: [] }` to everybody and the
    // probe would prove nothing about scoping.
    const childPartId = await make<Part>('Part', {
      partType: 'Purchase',
      name: `Enumerated BOM child ${nonce}`,
    })
    await ItemService.addRelationship(partId, childPartId, 'BOM', member.id, {
      quantity: '2',
    })

    // Keyed by item type so the exhaustiveness assertion below is meaningful:
    // a type registered in ITEM_TYPE_RESOURCES with no fixture here fails.
    const byType: Record<string, string> = {
      Part: partId,
      Document: await make('Document'),
      Requirement: await make('Requirement'),
      Task: await make('Task'),
      TestPlan: await make('TestPlan'),
      TestCase: await make('TestCase'),
      Issue: await make('Issue'),
      Tool: await make('Tool', {
        toolType: 'manufacturing',
        toolSubtype: 'fixture',
      }),
      Software: await make('Software'),
      WorkInstruction: await make('WorkInstruction', { outputPartId: partId }),
      // The three whose creation is not a plain ItemService.create: an ECO
      // needs its design links, and the two physical-lane types carry no
      // designId at all.
      ChangeOrder: (
        await ChangeOrderService.create(
          {
            revision: 'A',
            changeType: 'ECO',
            name: `Enumerated ECO ${nonce}`,
          },
          [design.id],
          member.id,
        )
      ).id!,
      WorkOrder: (
        await WorkOrderService.create(
          {
            partId,
            quantity: 1,
            programId: program.id,
            assignedTo: [],
          } as never,
          member.id,
        )
      ).id,
      PhysicalPart: (
        await PhysicalPartService.register(
          {
            partMasterId: part.masterId,
            serialNumber: `SN-${nonce}`,
          },
          member.id,
        )
      ).physicalPart.id,
    }

    expect(Object.keys(byType).sort()).toEqual(
      Object.keys(ITEM_TYPE_RESOURCES).sort(),
    )

    const branch = await BranchService.createWorkspaceBranch(
      design.id,
      member.id,
      `collection-${nonce}`,
    )

    const fileId = takeFirst(
      await testDb.db
        .insert(vaultFiles)
        .values({
          itemId: partId,
          fileName: `enumerated-${nonce}.pdf`,
          originalFileName: `enumerated-${nonce}.pdf`,
          fileSize: 1024,
          mimeType: 'application/pdf',
          fileHash: randomUUID().replace(/-/g, ''),
          storagePath: `vault/${randomUUID()}/enumerated.pdf`,
          fileCategory: 'drawing',
          uploadedBy: member.id,
        })
        .returning(),
    ).id

    // Every id that belongs to the member's program and to nobody else.
    // Master ids are in as well as version ids: several list surfaces key on
    // the lineage rather than the row, and a leak of either is a leak.
    const masterIds = (
      await Promise.all(
        Object.values(byType).map(
          async (id) => (await ItemService.findById(id))?.masterId,
        ),
      )
    ).filter((id): id is string => Boolean(id))

    leakIds = [
      program.id,
      design.id,
      familyDesign.id,
      branch.id,
      fileId,
      childPartId,
      ...Object.values(byType),
      ...masterIds,
    ]

    mappedProbes = [
      // The typed routers register no collection root — every typed list is
      // this one route under a query parameter — so item-type reachability is
      // proved here, exhaustively against ITEM_TYPE_RESOURCES.
      ...Object.keys(ITEM_TYPE_RESOURCES).map((type) => ({
        label: 'GET /api/v1/items',
        url: `/api/v1/items?limit=500&itemType=${type}`,
        serves: byType[type]!,
      })),
      {
        label: 'GET /api/v1/items/search',
        url: '/api/v1/items/search?limit=500&itemType=Part',
        serves: partId,
      },
      {
        label: 'GET /api/v1/items/search',
        url: `/api/v1/items/search?limit=500&q=${nonce}`,
        serves: partId,
      },
      {
        label: 'GET /api/v1/change-orders',
        url: '/api/v1/change-orders?limit=500',
        serves: byType.ChangeOrder,
      },
      {
        label: 'GET /api/v1/change-orders',
        url: `/api/v1/change-orders?limit=500&designId=${design.id}`,
        serves: byType.ChangeOrder,
      },
      {
        label: 'GET /api/v1/change-orders/editable',
        url: '/api/v1/change-orders/editable',
        serves: byType.ChangeOrder,
      },
      {
        label: 'GET /api/v1/designs',
        url: '/api/v1/designs?limit=500',
        serves: design.id,
      },
      {
        label: 'GET /api/v1/designs/families',
        url: `/api/v1/designs/families?programId=${program.id}`,
        serves: familyDesign.id,
      },
      { label: 'GET /api/v1/files', url: '/api/v1/files', serves: fileId },
      {
        label: 'GET /api/v1/programs',
        url: '/api/v1/programs?limit=500',
        serves: program.id,
      },
      {
        label: 'GET /api/v1/work-orders',
        url: '/api/v1/work-orders?limit=500',
        serves: byType.WorkOrder,
      },
      {
        label: 'GET /api/v1/physical-parts',
        url: '/api/v1/physical-parts?limit=500',
        serves: byType.PhysicalPart,
      },
      {
        label: 'GET /api/v1/physical-parts/recall',
        url: `/api/v1/physical-parts/recall?serialNumber=SN-${nonce}`,
        serves: byType.PhysicalPart,
      },
      {
        label: 'GET /api/v1/relationships',
        url: `/api/v1/relationships?designId=${design.id}`,
        serves: childPartId,
      },
      {
        label: 'GET /api/v1/workspaces',
        url: '/api/v1/workspaces',
        serves: branch.id,
      },
      {
        label: 'GET /api/v1/sysml/projects',
        url: '/api/v1/sysml/projects',
        serves: design.id,
      },
      {
        label: 'GET /api/v1/enterprise-search',
        url: `/api/v1/enterprise-search?q=${nonce}`,
        serves: partId,
      },
      {
        // This one takes `globalSearch`, not `q`, and caps `limit` at 100.
        label: 'GET /api/v1/enterprise-search/results',
        url: `/api/v1/enterprise-search/results?limit=100&globalSearch=${nonce}`,
        serves: partId,
      },
    ]

    cookies.clear()
    for (const u of [member, outsider]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * Every GET whose composed path carries no `:` parameter: the collection
   * roots and their static sub-paths.
   */
  function collectionRoutes(): Array<string> {
    const out: Array<string> = []
    for (const { mount, router } of MOUNTS) {
      for (const { method, path } of registeredRoutes(router, mount)) {
        if (method !== 'GET') continue
        if (path.includes(':')) continue
        out.push(`GET ${path}`)
      }
    }
    return out
  }

  /**
   * What the outsider is driven with: every enumerated route bare, plus every
   * mapped probe with the member's own ids in the query string. The second
   * half is the sharper probe — a route that scopes only when told to would
   * pass the bare form and fail this one.
   */
  function outsiderProbes(): Array<Probe> {
    const bare = collectionRoutes().map((label) => ({
      label,
      url: label.slice('GET '.length),
    }))
    return [...bare, ...mappedProbes].filter(
      ({ label }) => !ALLOWLIST.has(label),
    )
  }

  function send(user: TestUser, url: string) {
    return app.request(url, {
      method: 'GET',
      headers: {
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
      },
    })
  }

  /** Route labels whose 2xx answer to the outsider named a member fixture. */
  async function leakingRoutes(): Promise<Array<string>> {
    const leaked = new Set<string>()

    for (const { label, url } of outsiderProbes()) {
      const response = await send(outsider, url)
      // A refusal, or a 400 for a missing required parameter, discloses
      // nothing — including when its message echoes the id back, which is
      // only what the caller typed. Bodies are read on 2xx alone.
      if (!response.ok) continue

      const body = await response.text()
      const disclosed = leakIds.filter(
        (id) => !url.includes(id) && body.includes(id),
      )
      if (disclosed.length > 0) leaked.add(label)
    }

    return [...leaked].sort()
  }

  it('enumerates a meaningful number of collection routes', () => {
    // A guard on the guard: if the Hono property ever stops yielding routes,
    // both legs below would pass vacuously against an empty list.
    const found = collectionRoutes().length
    expect(found, `enumerated ${found} collection routes`).toBeGreaterThan(25)
  })

  it('keeps every map pinned to a route that exists', () => {
    const enumerated = new Set(collectionRoutes())

    // A renamed or deleted route must take its allowlist and known-leak
    // entries with it, or the maps quietly stop meaning anything.
    const orphaned = [...ALLOWLIST.keys(), ...KNOWN_UNSCOPED.keys()].filter(
      (label) => !enumerated.has(label),
    )
    expect(orphaned).toEqual([])

    // Same for the mapped set: a renamed route must not silently drop its
    // anti-vacancy cover.
    const unmapped = [...new Set(mappedProbes.map((p) => p.label))].filter(
      (label) => !enumerated.has(label),
    )
    expect(unmapped).toEqual([])
  })

  it('serves the member their own fixture on every mapped collection root', async () => {
    const missing: Array<string> = []

    for (const { label, url, serves } of mappedProbes) {
      if (!serves) continue
      const response = await send(member, url)
      const body = response.ok ? await response.text() : ''
      if (!body.includes(serves)) {
        missing.push(`${label} (${url}) -> ${response.status}`)
      }
    }

    // Named in full rather than counted: a failure here means the leak leg
    // below is testing a route that serves nobody, which is worse than a
    // failure — it is a silent hole.
    expect(missing).toEqual([])
  }, 180_000)

  it('serves an outsider none of the member fixtures', async () => {
    const unexpected = (await leakingRoutes()).filter(
      (label) => !KNOWN_UNSCOPED.has(label),
    )
    expect(unexpected).toEqual([])
  }, 180_000)

  it('holds no KNOWN_UNSCOPED entry that has since been scoped', async () => {
    const leaking = new Set(await leakingRoutes())
    const stale = [...KNOWN_UNSCOPED.keys()].filter(
      (label) => !leaking.has(label),
    )
    // The ratchet's pawl. An entry here that no longer leaks means the fix
    // landed and the entry must go — never that the entry should stay "just
    // in case".
    expect(stale).toEqual([])
  }, 180_000)
})
