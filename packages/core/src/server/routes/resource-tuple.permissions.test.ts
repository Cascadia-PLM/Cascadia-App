// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Every typed router's by-id RBAC resource is its own — the ratchet
 *
 * Security gate. `by-id-enumeration.permissions.test.ts` grants both of its
 * users every resource, deliberately, so that program membership is the only
 * variable it measures. That makes it structurally blind to *which* resource a
 * route names: a Task route declaring `['parts', 'read']` passes both of its
 * legs. It did, for as long as the tuple was wrong.
 *
 * This suite measures the other axis. For each of the 13 item types it builds
 * two program members who differ only in RBAC:
 *
 *   ONLY-OWN     — every verb on that type's own resource, and nothing else.
 *   ALL-BUT-OWN  — every verb on every *other* resource, and none on its own.
 *
 * Over the type's core by-id verbs, ONLY-OWN must never see 403 and
 * ALL-BUT-OWN must always see 403. That catches both directions of privilege
 * confusion in one pass: a route naming a foreign resource wrongly *denies*
 * the holder of the right one (ONLY-OWN leg goes red), and wrongly *allows*
 * anyone holding the foreign one — or anyone at all, if the route declares no
 * `permission` — (ALL-BUT-OWN leg goes red).
 *
 * Both users hold `programs:read` and neither holds `programs:manage`, the
 * cross-program bypass. Since that grant is identical on both sides it can
 * never be the reason the two answers differ; it is there so the instance-level
 * gates behave the same for each.
 *
 * The permission check runs before `access` and before the body is parsed
 * (`lib/api/handler.ts`), so an empty request body cannot mask a deny: a
 * refused caller gets 403, not the 400 the body would have earned. The
 * ONLY-OWN leg accordingly asserts *anything but* 403 — 200, 400, 404 and 409
 * all mean the tuple let the caller through, which is the whole claim.
 *
 * Scope is deliberately the **core by-id verbs only** — the handlers that read,
 * update and delete the item the path names. Sub-resource routes legitimately
 * declare a foreign resource (the traveler-execution routes under
 * `/work-orders/:id` charge `work_instructions:read`, by design and with a
 * comment saying so), and folding them in would need an allowlist that this
 * ratchet is better off without.
 *
 * Two mounts do not register core by-id verbs at all: `/test-plans` and
 * `/test-cases` expose only sub-resources. Their types are driven through
 * `/api/v1/items/:id`, which resolves the resource with `itemTypeToResource`
 * and is the surface those types actually have. The verb list per mount is
 * read from what the router registered rather than assumed, so
 * `/physical-parts` (GET and PATCH, no DELETE) is covered for what it has.
 *
 * The type map is asserted exhaustive against `ITEM_TYPE_RESOURCES`, so a
 * fourteenth item type fails here until it is covered.
 *
 * Run: npx vitest run packages/core/src/server/routes/resource-tuple.permissions.test.ts
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
import type { Part } from '@/lib/items/types/part'
import type { BaseItem } from '@/lib/items/types/base'
import type { ResourceType } from '@/lib/auth/permissions'
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
import { PhysicalPartService } from '@/lib/services/PhysicalPartService'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { RESOURCE_TYPES } from '@/lib/auth/permissions'
import { ITEM_TYPE_RESOURCES } from '@/lib/items/item-type-resources'
import { programMembers } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

const ALL_VERBS = ['create', 'read', 'update', 'delete']

/**
 * Hono publishes its registered routes. Not a contractual API, so the access
 * is pinned here: a Hono upgrade that changes the shape breaks one function.
 */
function coreByIdVerbs(router: Hono): Array<string> {
  const registered = (
    router as unknown as { routes: Array<{ method: string; path: string }> }
  ).routes

  const verbs = new Set<string>()
  for (const route of registered) {
    // Middleware registers itself as ALL; only real handlers are endpoints.
    if (route.method === 'ALL') continue
    if (route.path !== '/:id') continue
    verbs.add(route.method)
  }
  return [...verbs]
}

describe('typed by-id routes declare their own RBAC resource', () => {
  const testDb = new TestDatabase()

  /** One mount per item type, keyed so the exhaustiveness check is meaningful. */
  const MOUNTS_BY_TYPE: Record<string, { mount: string; router: Hono }> = {
    Part: { mount: '/api/v1/parts', router: partsRoutes },
    Document: { mount: '/api/v1/documents', router: documentsRoutes },
    ChangeOrder: { mount: '/api/v1/change-orders', router: changeOrdersRoutes },
    Requirement: { mount: '/api/v1/requirements', router: requirementsRoutes },
    Task: { mount: '/api/v1/tasks', router: tasksRoutes },
    TestPlan: { mount: '/api/v1/test-plans', router: testPlansRoutes },
    TestCase: { mount: '/api/v1/test-cases', router: testCasesRoutes },
    WorkInstruction: {
      mount: '/api/v1/work-instructions',
      router: workInstructionsRoutes,
    },
    Issue: { mount: '/api/v1/issues', router: issuesRoutes },
    Tool: { mount: '/api/v1/tools', router: toolsRoutes },
    Software: { mount: '/api/v1/software', router: softwareRoutes },
    WorkOrder: { mount: '/api/v1/work-orders', router: workOrdersRoutes },
    PhysicalPart: {
      mount: '/api/v1/physical-parts',
      router: physicalPartsRoutes,
    },
  }

  const ITEMS_MOUNT = '/api/v1/items'

  const app = Object.values(MOUNTS_BY_TYPE).reduce(
    (acc, { mount, router }) => acc.route(mount, router),
    new Hono().route(ITEMS_MOUNT, itemsRoutes),
  )

  /** The by-id surface each type actually has, resolved from the routers. */
  const SURFACES: Record<string, { mount: string; verbs: Array<string> }> =
    Object.fromEntries(
      Object.entries(MOUNTS_BY_TYPE).map(([itemType, { mount, router }]) => {
        const verbs = coreByIdVerbs(router)
        // `/test-plans` and `/test-cases` register only sub-resources; the
        // generic item route is the by-id surface those types have, and it
        // dispatches on `itemTypeToResource`.
        return verbs.length > 0
          ? [itemType, { mount, verbs }]
          : [
              itemType,
              { mount: ITEMS_MOUNT, verbs: coreByIdVerbs(itemsRoutes) },
            ]
      }),
    )

  /** itemType -> the fixture id its by-id routes should resolve to. */
  let idForType: Record<string, string>
  /** itemType -> { onlyOwn, allButOwn } session cookies. */
  let cookieForType: Record<string, { onlyOwn: string; allButOwn: string }>

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // The fixture author. Holds everything so item creation is never the thing
    // under test; the probe users below hold far less.
    const ownerPermissions: Record<string, Array<string>> = {}
    for (const resource of RESOURCE_TYPES) {
      ownerPermissions[resource] = [...ALL_VERBS, 'manage']
    }
    const ownerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(
        `Tuple Owner ${randomUUID().slice(0, 8)}`,
        ownerPermissions,
      ),
    )
    const owner = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, owner.id, ownerRole.id)
    permissionService.clearCache()

    // ProgramService.create enrols its creator; a direct insert does not.
    const program = await ProgramService.create(
      {
        name: 'Resource Tuple Program',
        code: `RTUP-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      owner.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Resource Tuple Design',
        code: `RTUPD-${Date.now()}`,
        designType: 'Engineering',
      },
      owner.id,
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
          name: `Tuple ${itemType}`,
          ...extra,
        } as unknown as T,
        owner.id,
      )
      return item.id!
    }

    const partId = await make<Part>('Part', {
      partType: 'Manufacture',
      trackingMode: 'serial',
    })
    const part = await ItemService.findById(partId)
    if (!part?.masterId) throw new Error('part fixture has no masterId')

    idForType = {
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
      ChangeOrder: (
        await ChangeOrderService.create(
          { revision: 'A', changeType: 'ECO', name: 'Tuple ECO' },
          [design.id],
          owner.id,
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
          owner.id,
        )
      ).id,
      PhysicalPart: (
        await PhysicalPartService.register(
          {
            partMasterId: part.masterId,
            serialNumber: `SN-${Date.now()}`,
          },
          owner.id,
        )
      ).physicalPart.id,
    }

    // A fourteenth item type has to be given a fixture and a mount here before
    // it can ship ungated.
    expect(Object.keys(idForType).sort()).toEqual(
      Object.keys(ITEM_TYPE_RESOURCES).sort(),
    )
    expect(Object.keys(MOUNTS_BY_TYPE).sort()).toEqual(
      Object.keys(ITEM_TYPE_RESOURCES).sort(),
    )

    cookieForType = {}
    for (const [itemType, resource] of Object.entries(ITEM_TYPE_RESOURCES)) {
      const onlyOwn: Record<string, Array<string>> = {
        [resource]: [...ALL_VERBS],
        // Held by both legs, so it can never be why their answers differ.
        programs: ['read'],
      }
      const allButOwn: Record<string, Array<string>> = { programs: ['read'] }
      for (const other of RESOURCE_TYPES) {
        if (other === resource || other === 'programs') continue
        allButOwn[other] = [...ALL_VERBS, 'manage']
      }

      const pair: Record<string, string> = {}
      for (const [leg, permissions] of [
        ['onlyOwn', onlyOwn],
        ['allButOwn', allButOwn],
      ] as const) {
        const role = await insertTestRole(
          testDb.db,
          createCustomTestRole(
            `${leg} ${resource} ${randomUUID().slice(0, 8)}`,
            permissions,
          ),
        )
        const user = await insertTestUser(testDb.db)
        await assignRoleToUser(testDb.db, user.id, role.id)
        await testDb.db.insert(programMembers).values({
          programId: program.id,
          userId: user.id,
          role: 'engineer',
        })
        const { sessionToken } = await SessionManager.createSession(user.id)
        pair[leg] = `session=${sessionToken}`
      }
      cookieForType[itemType] = {
        onlyOwn: pair.onlyOwn!,
        allButOwn: pair.allButOwn!,
      }
    }
    permissionService.clearCache()
  }, 120_000)

  afterEach(async () => {
    await testDb.rollback()
  })

  /** Every core by-id probe, with real ids substituted. */
  function probes(): Array<{
    itemType: string
    resource: ResourceType
    label: string
    method: string
    url: string
  }> {
    const out: Array<{
      itemType: string
      resource: ResourceType
      label: string
      method: string
      url: string
    }> = []
    for (const [itemType, resource] of Object.entries(ITEM_TYPE_RESOURCES)) {
      const surface = SURFACES[itemType]!
      for (const method of surface.verbs) {
        out.push({
          itemType,
          resource,
          label: `${method} ${surface.mount}/:id (${itemType} -> ${resource})`,
          method,
          url: `${surface.mount}/${idForType[itemType]!}`,
        })
      }
    }
    return out
  }

  function send(cookie: string, method: string, url: string) {
    const sendsBody = !['GET', 'HEAD', 'DELETE'].includes(method)
    return app.request(url, {
      method,
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost',
        ...(sendsBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(sendsBody ? { body: '{}' } : {}),
    })
  }

  it('finds a core by-id surface for every item type', () => {
    // A guard on the guard: were the Hono property to stop yielding routes,
    // both legs below would pass vacuously against an empty probe list.
    const found = probes()
    expect(
      found.length,
      `enumerated ${found.length} core by-id routes`,
    ).toBeGreaterThan(30)
    for (const itemType of Object.keys(ITEM_TYPE_RESOURCES)) {
      expect(
        found.filter((p) => p.itemType === itemType).length,
        `no core by-id route found for ${itemType}`,
      ).toBeGreaterThan(0)
    }
  })

  it('refuses a caller holding every resource except the type’s own', async () => {
    const served: Array<string> = []

    for (const { itemType, label, method, url } of probes()) {
      const response = await send(
        cookieForType[itemType]!.allButOwn,
        method,
        url,
      )
      // Nothing this caller sends may get past the tuple. The permission check
      // runs before `access` and before the body is parsed, so a 400 here would
      // mean the route never charged for the resource it operates on.
      if (response.status !== 403) served.push(`${label} -> ${response.status}`)
    }

    // Named in full rather than counted: a failure should say which route is
    // gated on the wrong resource, not how many are.
    expect(served).toEqual([])
  }, 180_000)

  it('refuses none of them to a caller holding only the type’s own resource', async () => {
    const refused: Array<string> = []

    // Deletes land, so they go last and Part goes last of those: the physical
    // lane and the work instruction are keyed on it.
    const all = probes()
    const ordered = [
      ...all.filter((p) => p.method !== 'DELETE'),
      ...all
        .filter((p) => p.method === 'DELETE')
        .sort(
          (a, b) =>
            Number(a.itemType === 'Part') - Number(b.itemType === 'Part'),
        ),
    ]

    for (const { itemType, label, method, url } of ordered) {
      const response = await send(cookieForType[itemType]!.onlyOwn, method, url)
      // Anything but 403. A 400 for the empty body or a 409 for a protected
      // branch is fine — what matters is that the tuple named the resource
      // this caller actually holds.
      if (response.status === 403) refused.push(label)
    }

    expect(refused).toEqual([])
  }, 180_000)

  it('charges requirements:create for deriving a child requirement', async () => {
    const url = `/api/v1/requirements/${idForType.Requirement!}/derive`
    const body = JSON.stringify({ name: 'Derived child' })
    const headers = (cookie: string) => ({
      Cookie: cookie,
      Origin: 'http://localhost',
      'Content-Type': 'application/json',
    })

    // Holds every resource but `requirements`: creating a requirement through
    // the generic item route is already refused, and this route is the same
    // creation by another name.
    const denied = await app.request(url, {
      method: 'POST',
      headers: headers(cookieForType.Requirement!.allButOwn),
      body,
    })
    expect(denied.status).toBe(403)

    const allowed = await app.request(url, {
      method: 'POST',
      headers: headers(cookieForType.Requirement!.onlyOwn),
      body,
    })
    expect(allowed.status).toBe(201)
  }, 60_000)
})
