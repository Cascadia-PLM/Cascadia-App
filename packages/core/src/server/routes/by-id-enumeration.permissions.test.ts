// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Every by-id route, enumerated — a non-member is refused, a member is not
 *
 * Security gate, and the ratchet the whole authorization sweep rests on.
 * AUTH-1..7 gated roughly a hundred and forty handlers by hand; hand-written
 * spot checks prove the shapes work, and cannot prove that none was missed.
 * This asks the routers themselves what they registered.
 *
 * Two legs, over the same list. As an **outsider** — a user holding every RBAC
 * verb but belonging to no program — every by-id route must answer 403. As a
 * **member**, the same request must answer anything *but* 403: 200, 400, 404
 * and 409 are all fine, because the point is that the refusal came from the
 * instance-level gate rather than from a malformed path or a missing row.
 *
 * Both users hold one role granting every resource except `programs:manage`,
 * which is the cross-program bypass. So RBAC can never be the reason for a
 * 403, and program membership is the only difference between them.
 *
 * The suite also refuses to let a new item type in unnoticed: the map of
 * fixtures is asserted exhaustive against `ITEM_TYPE_RESOURCES`, which has its
 * own test pinning it against `ITEM_TYPE_DEFINITIONS`. A fourteenth type fails
 * here until someone gives it a fixture.
 *
 * Most mounts are item routers; two are not. `/api/v1/files` is the vault,
 * and `/api/v1/branches` gates on the design behind the branch rather than on
 * an item — `requireBranchAccess`, whose other shape, a branch named in a
 * request body, no enumeration over path ids can reach and which
 * `branches.permissions.test.ts` covers instead.
 *
 * `PUT /branches/:id` is the one to know about on that mount: both its body
 * fields are optional, so `{}` is a valid body that reaches the handler
 * rather than a 400 in the wrapper. It is also the one branches route that
 * does not call `requireBranchAccess` — it asks `ProgramService.getUserRole`
 * for lead or admin, which is narrower. The outsider is refused by that check
 * and the member is not, because the fixture's member created the program and
 * `ProgramService.create` enrols its creator as admin. With both flags absent
 * the handler writes nothing, so the member leg does not consume the branch.
 *
 * One wrinkle worth naming: a route declaring `body:` validates in the
 * wrapper, before the handler's access check. An empty request to such a
 * route is a 400 that never reached the gate — which is not a disclosure,
 * because the rejection is decided by the body alone and a member sending the
 * same request gets the same 400. The outsider leg accepts that pair and
 * nothing else.
 *
 * The allowlist is the ratchet. Each entry names a route whose gate is shaped
 * by something other than the id — a branch named in the body, mostly — and
 * carries the reason. It should only ever shrink. A route that parses its body
 * before authorizing shows up as a 400 in the outsider leg: that is the test
 * working, and the fix belongs in the route, never here.
 *
 * Companion suites, kept because enumeration cannot explain itself:
 * `item-access.permissions.test.ts` (one route per shape),
 * `by-id-access.permissions.test.ts` (the non-design axes, and the deliberate
 * exceptions), `files.permissions.test.ts` (the vault, including the mixed
 * batch).
 *
 * Run: npx vitest run packages/core/src/server/routes/by-id-enumeration.permissions.test.ts
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
import itemsRoutes from './items'
import partsRoutes from './parts'
import documentsRoutes from './documents'
import changeOrdersRoutes from './change-orders'
import requirementsRoutes from './requirements'
import tasksRoutes from './tasks'
import testPlansRoutes from './test-plans'
import testCasesRoutes from './test-cases'
import workInstructionsRoutes from './work-instructions'
import issuesRoutes from './issues'
import toolsRoutes from './tools'
import softwareRoutes from './software'
import workOrdersRoutes from './work-orders'
import physicalPartsRoutes from './physical-parts'
import filesRoutes from './files'
import branchesRoutes from './branches'
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
 * Routes whose refusal is shaped by something other than the id in the path.
 *
 * Each needs a reason, and the list may only shrink. These are not exemptions
 * from being gated — they are routes this *enumeration* cannot drive, because
 * the thing being authorized is named in the body.
 */
const ALLOWLIST = new Map<string, string>([
  // Empty, and that is the point. The four checkout-family routes were the
  // candidates — their gate reads a branch named in the body or the query, so
  // an empty request 400s before any id-shaped check — but the item in the
  // path is reachable or it is not whatever branch is named, so they took
  // `requireItemAccess` first instead of an exemption here.
])

/**
 * Secondary path params.
 *
 * Most are sub-resource ids whose row need not exist: the access gate runs on
 * the item in the path, so a synthetic id proves the gate fired *before* the
 * lookup. `:designId` is the exception — it names a design with a gate of its
 * own, so a random one is legitimately refused, and the fixture's real design
 * has to be substituted or the member leg reads its own gate as a bug.
 */
function fillSecondaryParams(path: string, designId: string): string {
  return path
    .replace(':designId', designId)
    .replace(':hash', 'a'.repeat(64))
    .replace(':version', '1')
    .replace(/:[A-Za-z]+/g, randomUUID())
}

describe('by-id routes, enumerated — program isolation', () => {
  const testDb = new TestDatabase()

  const MOUNTS: Array<{ mount: string; router: Hono }> = [
    { mount: '/api/v1/items', router: itemsRoutes },
    { mount: '/api/v1/parts', router: partsRoutes },
    { mount: '/api/v1/documents', router: documentsRoutes },
    { mount: '/api/v1/change-orders', router: changeOrdersRoutes },
    { mount: '/api/v1/requirements', router: requirementsRoutes },
    { mount: '/api/v1/tasks', router: tasksRoutes },
    { mount: '/api/v1/test-plans', router: testPlansRoutes },
    { mount: '/api/v1/test-cases', router: testCasesRoutes },
    { mount: '/api/v1/work-instructions', router: workInstructionsRoutes },
    { mount: '/api/v1/issues', router: issuesRoutes },
    { mount: '/api/v1/tools', router: toolsRoutes },
    { mount: '/api/v1/software', router: softwareRoutes },
    { mount: '/api/v1/work-orders', router: workOrdersRoutes },
    { mount: '/api/v1/physical-parts', router: physicalPartsRoutes },
    { mount: '/api/v1/files', router: filesRoutes },
    // Not an item type: a branch is gated on the design behind it. All five
    // of its routes name the branch in the path, so enumeration drives them
    // exactly as it drives the item routes — see the header for `PUT /:id`,
    // which is gated, but not by `requireBranchAccess`.
    { mount: '/api/v1/branches', router: branchesRoutes },
  ]

  const app = MOUNTS.reduce(
    (acc, { mount, router }) => acc.route(mount, router),
    new Hono(),
  )

  let member: TestUser
  let outsider: TestUser
  const cookies = new Map<string, string>()

  /** The id each mount's `:id` should resolve to. */
  let idForMount: Record<string, string>
  let fileId: string
  let designId: string

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
    // bypass. RBAC can therefore never be the source of a 403 here.
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

    // ProgramService.create enrols its creator; a direct insert does not.
    const program = await ProgramService.create(
      {
        name: 'Enumeration Program',
        code: `ENUM-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Enumeration Design',
        code: `ENUMD-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )

    // A branch for the branches mount. A workspace branch rather than the
    // design's `main`, because `main` is special-cased in branch protection
    // and status and this wants the ordinary case.
    const branch = await BranchService.createWorkspaceBranch(
      design.id,
      member.id,
      `enumeration-${randomUUID().slice(0, 8)}`,
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
          name: `Enumerated ${itemType}`,
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
      // needs its design links (which is what requireEcoAccess reads), and the
      // two physical-lane types carry no designId at all.
      ChangeOrder: (
        await ChangeOrderService.create(
          { revision: 'A', changeType: 'ECO', name: 'Enumerated ECO' },
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
            serialNumber: `SN-${Date.now()}`,
          },
          member.id,
        )
      ).physicalPart.id,
    }

    expect(Object.keys(byType).sort()).toEqual(
      Object.keys(ITEM_TYPE_RESOURCES).sort(),
    )

    designId = design.id
    idForMount = {
      '/api/v1/items': partId,
      '/api/v1/parts': byType.Part!,
      '/api/v1/documents': byType.Document!,
      '/api/v1/change-orders': byType.ChangeOrder!,
      '/api/v1/requirements': byType.Requirement!,
      '/api/v1/tasks': byType.Task!,
      '/api/v1/test-plans': byType.TestPlan!,
      '/api/v1/test-cases': byType.TestCase!,
      '/api/v1/work-instructions': byType.WorkInstruction!,
      '/api/v1/issues': byType.Issue!,
      '/api/v1/tools': byType.Tool!,
      '/api/v1/software': byType.Software!,
      '/api/v1/work-orders': byType.WorkOrder!,
      '/api/v1/physical-parts': byType.PhysicalPart!,
      '/api/v1/branches': branch.id,
    }

    fileId = takeFirst(
      await testDb.db
        .insert(vaultFiles)
        .values({
          itemId: partId,
          fileName: 'enumerated.pdf',
          originalFileName: 'enumerated.pdf',
          fileSize: 1024,
          mimeType: 'application/pdf',
          fileHash: randomUUID().replace(/-/g, ''),
          storagePath: `vault/${randomUUID()}/enumerated.pdf`,
          fileCategory: 'drawing',
          uploadedBy: member.id,
        })
        .returning(),
    ).id

    cookies.clear()
    for (const u of [member, outsider]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** Every by-id route across the mounted routers, with real ids substituted. */
  function targets(): Array<{ label: string; method: string; url: string }> {
    const out: Array<{ label: string; method: string; url: string }> = []
    for (const { mount, router } of MOUNTS) {
      for (const { method, path } of registeredRoutes(router, mount)) {
        if (!/:(id|itemId|fileId)\b/.test(path)) continue
        const label = `${method} ${path}`
        if (ALLOWLIST.has(label)) continue

        const primary =
          mount === '/api/v1/files' ? fileId : (idForMount[mount] ?? '')
        const url = fillSecondaryParams(
          path
            .replace(':fileId', primary)
            .replace(':itemId', primary)
            .replace(':id', primary),
          designId,
        )
        out.push({ label, method, url })
      }
    }
    return out
  }

  function send(user: TestUser, method: string, url: string) {
    const sendsBody = !['GET', 'HEAD', 'DELETE'].includes(method)
    return app.request(url, {
      method,
      headers: {
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
        ...(sendsBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(sendsBody ? { body: '{}' } : {}),
    })
  }

  it('enumerates a meaningful number of by-id routes', () => {
    // A guard on the guard: if the Hono property ever stops yielding routes,
    // both legs below would pass vacuously against an empty list.
    const found = targets().length
    expect(found, `enumerated ${found} by-id routes`).toBeGreaterThan(105)
  })

  it('refuses every by-id route to a non-member', async () => {
    const served: Array<string> = []

    for (const { label, method, url } of targets()) {
      const response = await send(outsider, method, url)
      if (response.status === 403) continue

      // A route that declares `body:` validates in the wrapper, before the
      // handler's access check runs — so an empty request body is a 400 that
      // never reached the gate. That is not a leak: the rejection is decided
      // by the body alone, and a member sending the same request gets the
      // same 400, so it says nothing about the item or who may reach it.
      // Anything else — a 200, a 404, a 409 — means the request did reach the
      // resource, and should have been refused.
      const asMember = await send(member, method, url)
      if (response.status === 400 && asMember.status === 400) continue

      served.push(`${label} -> ${response.status}`)
    }

    // Named in full rather than counted: a failure here should say which route
    // is open, not how many are.
    expect(served).toEqual([])
  }, 180_000)

  it('refuses none of them to a member', async () => {
    const refused: Array<string> = []

    // The member's requests land, so this leg consumes its own fixtures:
    // `DELETE /change-orders/:id` removes the ECO, and every later ECO route
    // then answers 403 rather than 404, because an ECO with no design links is
    // indistinguishable from one you cannot reach. Deletes go last, deepest
    // path first, so a root delete cannot strand its own sub-resources.
    const ordered = [
      ...targets().filter((t) => t.method !== 'DELETE'),
      ...targets()
        .filter((t) => t.method === 'DELETE')
        .sort((a, b) => b.url.split('/').length - a.url.split('/').length),
    ]

    for (const { label, method, url } of ordered) {
      const response = await send(member, method, url)
      // Anything but 403. A member may well get 400 for an empty body or 404
      // for a synthetic sub-id — what matters is that the instance gate let
      // them through, which is what makes the outsider's 403 meaningful.
      if (response.status === 403) refused.push(label)
    }

    expect(refused).toEqual([])
  }, 120_000)
})
