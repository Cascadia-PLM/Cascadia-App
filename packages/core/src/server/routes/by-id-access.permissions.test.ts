// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The remaining by-id surfaces — program isolation
 *
 * Security gate. AUTH-2 closed the type-specific route files; this covers what
 * was left: the generic `items` sub-routes (transition, lock, relationships,
 * files), `requirements`, and the two physical-lane files whose rows carry no
 * `designId` at all and so need their own derivation.
 *
 * One route per family rather than all seventy-five. Every user here holds the
 * same RBAC role, so a 403 can only come from the instance-level gate:
 *
 *  - a generic sub-route that mutates through a service AUTH-1 does not cover
 *    (`POST /items/:id/transition` goes through LifecycleService)
 *  - a generic sub-route that reads (`GET /items/:id/relationships`)
 *  - a lock, which writes the items row directly (`POST /items/:id/lock`)
 *  - the vault-adjacent file listing (`GET /items/:itemId/files`)
 *  - a requirement sub-route (`GET /requirements/:id/derive`)
 *  - a physical instance, scoped through the part it instantiates
 *  - a work order, scoped through the program it names
 *  - both of those again on the *generic* `/items/:id/*` router, which for a
 *    long time was the one surface that answered a third way
 *  - an issue, scoped on whichever of its three axes it carries, plus the
 *    repair path that keeps a row with none of them fixable
 *  - the three version-context reads (`at-context`, `available-contexts`,
 *    `history`), which hand-rolled a design check that an ECO — whose
 *    `items.design_id` is always NULL — passed vacuously
 *
 * Run: npx vitest run packages/core/src/server/routes/by-id-access.permissions.test.ts
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
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
import requirementsRoutes from './requirements'
import physicalPartsRoutes from './physical-parts'
import workOrdersRoutes from './work-orders'
import issuesRoutes from './issues'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { Requirement } from '@/lib/items/types/requirement'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { PhysicalPartService } from '@/lib/services/PhysicalPartService'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { ErrorCode } from '@/lib/errors/codes'
import { issueDesigns, items, workOrders } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('remaining by-id surfaces — program isolation', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/items', itemsRoutes)
    .route('/api/v1/requirements', requirementsRoutes)
    .route('/api/v1/physical-parts', physicalPartsRoutes)
    .route('/api/v1/work-orders', workOrdersRoutes)
    .route('/api/v1/issues', issuesRoutes)

  let member: TestUser
  let outsider: TestUser
  let crossProgramAdmin: TestUser
  let partId: string
  let partMasterId: string
  let requirementId: string
  let physicalPartId: string
  let workOrderId: string
  let programId: string
  let foreignProgramId: string
  let derivedIssueId: string
  let orphanIssueId: string
  let ecoId: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // Same role for both — 'User' carries every read/update verb these routes
    // ask for, and no programs:manage, so neither has the cross-program bypass.
    member = (await insertTestUserWithRole(testDb.db, 'User')).user
    outsider = (await insertTestUserWithRole(testDb.db, 'User')).user
    // The exception, and only for the program-less cases below: an
    // Administrator carries programs:manage, which is the cross-program
    // authority a row with no program now answers to.
    crossProgramAdmin = (
      await insertTestUserWithRole(testDb.db, 'Administrator')
    ).user

    const program = await ProgramService.create(
      {
        name: 'By-id Access Program',
        code: `BAP-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    programId = program.id
    // A program the member is not in — the destination half of the repair
    // path's own gate.
    foreignProgramId = (
      await ProgramService.create(
        {
          name: 'Foreign Program',
          code: `FGN-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
        },
        crossProgramAdmin.id,
      )
    ).id
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'By-id Access Design',
        code: `BAD-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Gated Assembly',
        partType: 'Manufacture',
        trackingMode: 'serial',
      },
      member.id,
    )
    partId = part.id!
    partMasterId = part.masterId!

    requirementId = (
      await ItemService.create<Requirement>(
        'Requirement',
        {
          itemType: 'Requirement',
          designId: design.id,
          revision: 'A',
          name: 'Gated Requirement',
        },
        member.id,
      )
    ).id!

    // A physical instance carries no designId — it is scoped through the part
    // whose lineage it names.
    physicalPartId = (
      await PhysicalPartService.register(
        { partMasterId, serialNumber: `SN-${Date.now()}` },
        member.id,
      )
    ).physicalPart.id

    // A work order carries no designId either — it names its program directly.
    workOrderId = (
      await WorkOrderService.create(
        {
          partId,
          quantity: 1,
          programId: program.id,
          assignedTo: [],
        } as never,
        member.id,
      )
    ).id

    // An issue carries no designId of its own here — the program comes from
    // the designs the create form collects, which is the derivation this gate
    // rests on. The orphan is what every row predating that derivation is.
    derivedIssueId = (
      (await ItemService.create(
        'Issue',
        {
          itemType: 'Issue',
          revision: 'A',
          name: 'Gated Issue',
          designIds: [design.id],
        } as never,
        member.id,
      )) as { id: string }
    ).id
    orphanIssueId = (
      (await ItemService.create(
        'Issue',
        { itemType: 'Issue', revision: 'A', name: 'Orphan Issue' } as never,
        member.id,
      )) as { id: string }
    ).id

    // An ECO carries no designId of its own — its designs hang off
    // `change_order_designs`, which is what the gate has to walk.
    ecoId = (
      await ChangeOrderService.create(
        { revision: 'A', changeType: 'ECO', name: 'Gated ECO' },
        [design.id],
        member.id,
      )
    ).id!

    cookies.clear()
    for (const u of [member, outsider, crossProgramAdmin]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function request(
    user: TestUser,
    path: string,
    method = 'GET',
    body?: object,
  ) {
    return app.request(path, {
      method,
      headers: {
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function expectDenied(response: Response, label?: string) {
    expect(response.status, label).toBe(403)
    const payload = (await response.json()) as ErrorEnvelope
    expect(payload.error.code, label).toBe(ErrorCode.PERMISSION_DENIED)
  }

  it('refuses a non-member the generic item sub-routes', async () => {
    // A read, a service-backed write, a direct row write, and the file listing.
    await expectDenied(
      await request(outsider, `/api/v1/items/${partId}/relationships`),
    )
    await expectDenied(
      await request(outsider, `/api/v1/items/${partId}/transition`, 'POST', {
        toState: 'In Review',
      }),
    )
    await expectDenied(
      await request(outsider, `/api/v1/items/${partId}/lock`, 'POST'),
    )
    await expectDenied(await request(outsider, `/api/v1/items/${partId}/files`))
  })

  // ==========================================================================
  // The three version-context reads
  //
  // `at-context`, `available-contexts` and `history` hand-rolled
  // `if (designId) requireDesignAccess(...)` instead of calling
  // `requireItemAccess`. An ECO's `items.design_id` is always NULL and an
  // issue's may be too, so on those two types the branch never ran and
  // authentication was the whole gate — while `at-context` ships the row
  // merged with its type-specific table.
  // ==========================================================================

  const contextReads = ['at-context', 'available-contexts', 'history'] as const

  it('scopes an ECO on its linked designs across the three context reads', async () => {
    for (const route of contextReads) {
      await expectDenied(
        await request(outsider, `/api/v1/items/${ecoId}/${route}`),
        `eco ${route}`,
      )
      expect(
        (await request(member, `/api/v1/items/${ecoId}/${route}`)).status,
        `eco ${route}`,
      ).toBe(200)
    }
  })

  it('scopes an issue on its derived program across the three context reads', async () => {
    // The same vacuous-design-check shape, reached through the `Issue` arm
    // rather than the `ChangeOrder` one.
    for (const route of contextReads) {
      await expectDenied(
        await request(outsider, `/api/v1/items/${derivedIssueId}/${route}`),
        `issue ${route}`,
      )
      expect(
        (await request(member, `/api/v1/items/${derivedIssueId}/${route}`))
          .status,
        `issue ${route}`,
      ).toBe(200)
    }
  })

  it('serves the same item sub-routes to a member', async () => {
    expect(
      (await request(member, `/api/v1/items/${partId}/relationships`)).status,
    ).toBe(200)
    expect(
      (await request(member, `/api/v1/items/${partId}/files`)).status,
    ).toBe(200)
  })

  it('refuses a non-member a requirement sub-route', async () => {
    await expectDenied(
      await request(outsider, `/api/v1/requirements/${requirementId}/derive`),
    )

    expect(
      (await request(member, `/api/v1/requirements/${requirementId}/derive`))
        .status,
    ).toBe(200)
  })

  it('scopes a physical instance through the part it instantiates', async () => {
    // physical_parts rows carry no designId, so requireItemAccess would have
    // passed this vacuously — the gate walks partMasterId to the part's design.
    await expectDenied(
      await request(
        outsider,
        `/api/v1/physical-parts/${physicalPartId}/genealogy`,
      ),
    )

    expect(
      (
        await request(
          member,
          `/api/v1/physical-parts/${physicalPartId}/genealogy`,
        )
      ).status,
    ).toBe(200)
  })

  it('scopes a work order through the program it names', async () => {
    await expectDenied(
      await request(outsider, `/api/v1/work-orders/${workOrderId}`),
    )

    expect(
      (await request(member, `/api/v1/work-orders/${workOrderId}`)).status,
    ).toBe(200)
  })

  /**
   * A work order whose program column really is NULL.
   *
   * Creation derives the program from the part now, so this shape can only be
   * reached by writing the column — which is exactly what a deployment that
   * predates the derivation is full of.
   */
  async function programLessWorkOrder(): Promise<string> {
    const created = await WorkOrderService.create(
      { partId, quantity: 1, assignedTo: [] } as never,
      member.id,
    )
    await testDb.db
      .update(workOrders)
      .set({ programId: null })
      .where(eq(workOrders.itemId, created.id))
    return created.id
  }

  it('refuses a program-less work order to a caller without cross-program authority', async () => {
    // No program is a data gap, not a row outside every boundary. This gate is
    // the only instance-level check the work-order routes have — it covers the
    // traveler, sign-off and production — so it fails closed, the same rule
    // requireEcoAccess applies to a link-less ECO.
    await expectDenied(
      await request(
        outsider,
        `/api/v1/work-orders/${await programLessWorkOrder()}`,
      ),
    )
  })

  it('leaves a program-less work order reachable by cross-program authority', async () => {
    // The repair path, and the reason the column stays nullable rather than
    // becoming NOT NULL: someone has to be able to open the row and set a
    // program on it.
    expect(
      (
        await request(
          crossProgramAdmin,
          `/api/v1/work-orders/${await programLessWorkOrder()}`,
        )
      ).status,
    ).toBe(200)
  })

  it('scopes a work order created with no program through its part', async () => {
    // What keeps the fail-closed rule from hiding ordinary work: the create
    // form does not require a program, so the service derives it from the
    // design the part sits in.
    const derived = await WorkOrderService.create(
      { partId, quantity: 1, assignedTo: [] } as never,
      member.id,
    )

    expect(
      (await request(member, `/api/v1/work-orders/${derived.id}`)).status,
    ).toBe(200)
    await expectDenied(
      await request(outsider, `/api/v1/work-orders/${derived.id}`),
    )
  })

  // ==========================================================================
  // The same two types on the generic /items/:id router
  //
  // The typed routers above have gated WorkOrder and PhysicalPart for two
  // releases, and `accessScopeCondition` has excluded them from every list for
  // one. The generic router did neither: `requireItemAccess` ended in
  // `if (item.designId) requireDesignAccess(...)`, and neither type's `items`
  // row carries a design, so 31 sub-routes plus the AI/MCP tool handlers were
  // gated by authentication and a read verb alone.
  //
  // Every user here holds `User`, which carries `work_orders:read` and
  // `physical_parts:read`, so the RBAC tuple these routes charge passes for
  // all of them. The refusal can therefore only be the instance gate — and the
  // member's exact 200 on the same URL is what proves it, since only the
  // admission is unambiguous.
  // ==========================================================================

  it('scopes a work order on the generic item router', async () => {
    await expectDenied(
      await request(outsider, `/api/v1/items/${workOrderId}/relationships`),
    )

    expect(
      (await request(member, `/api/v1/items/${workOrderId}/relationships`))
        .status,
    ).toBe(200)
  })

  it('scopes a physical instance on the generic item router', async () => {
    await expectDenied(
      await request(outsider, `/api/v1/items/${physicalPartId}/relationships`),
    )

    expect(
      (await request(member, `/api/v1/items/${physicalPartId}/relationships`))
        .status,
    ).toBe(200)
  })

  it('refuses a program-less work order on the generic router too', async () => {
    // The leg that proves the by-id gate and `workOrderAccessScopeCondition`
    // now answer the NULL axis the same way: fail closed, with cross-program
    // authority keeping the repair path open.
    const dark = await programLessWorkOrder()

    await expectDenied(
      await request(outsider, `/api/v1/items/${dark}/relationships`),
    )
    await expectDenied(
      await request(member, `/api/v1/items/${dark}/relationships`),
    )

    expect(
      (await request(crossProgramAdmin, `/api/v1/items/${dark}/relationships`))
        .status,
    ).toBe(200)
  })

  it('leaves a design-less part lineage ungated by id', async () => {
    // A ruling, not an oversight, and inherited rather than introduced:
    // `requirePhysicalPartAccess` gates only `if (partVersion?.designId)`, so
    // an instance whose lineage carries no design is admitted to any
    // authenticated caller — the same admission
    // `physicalPartAccessScopeCondition`'s second NOT EXISTS makes on the list.
    // Pinned here so a later "tighten it" edit cannot flip it silently.
    await testDb.db
      .update(items)
      .set({ designId: null })
      .where(eq(items.masterId, partMasterId))

    expect(
      (await request(outsider, `/api/v1/items/${physicalPartId}/relationships`))
        .status,
    ).toBe(200)
  })

  it('gates GET /api/v1/items/:id on the dispatched helper', async () => {
    // The route hand-rolled the design check, so it was vacuous on all four
    // types whose `items.design_id` is NULL — this closes the ChangeOrder and
    // Issue halves as well as the two this change is about, deliberately.
    for (const id of [ecoId, derivedIssueId, workOrderId, physicalPartId]) {
      await expectDenied(await request(outsider, `/api/v1/items/${id}`), id)
      expect((await request(member, `/api/v1/items/${id}`)).status, id).toBe(
        200,
      )
    }
  })

  // ==========================================================================
  // Issues
  //
  // The by-id half of the disjunctive arm in `accessScopeCondition`. Both
  // surfaces moved in one change on purpose: closing only the list, or only
  // this, manufactures exactly the disagreement the work-order gate spent two
  // changes undoing.
  // ==========================================================================

  it('scopes an issue on the program its designs derived', async () => {
    await expectDenied(
      await request(outsider, `/api/v1/issues/${derivedIssueId}`),
    )
    await expectDenied(
      await request(outsider, `/api/v1/items/${derivedIssueId}/relationships`),
    )

    expect(
      (await request(member, `/api/v1/issues/${derivedIssueId}`)).status,
    ).toBe(200)
    expect(
      (await request(member, `/api/v1/items/${derivedIssueId}/relationships`))
        .status,
    ).toBe(200)
  })

  // What makes the derivation load-bearing rather than cosmetic. Clearing the
  // design links leaves only `issues.program_id` standing, so this passes only
  // if creation actually wrote one.
  it('keeps an issue reachable after its design links are cleared', async () => {
    await testDb.db
      .delete(issueDesigns)
      .where(eq(issueDesigns.issueItemId, derivedIssueId))

    expect(
      (await request(member, `/api/v1/issues/${derivedIssueId}`)).status,
    ).toBe(200)
    await expectDenied(
      await request(outsider, `/api/v1/issues/${derivedIssueId}`),
    )
  })

  it('refuses an issue with no axis at all to a caller without cross-program authority', async () => {
    // No program, no design, no links — a data gap, not a row outside every
    // boundary. Same rule as a program-less work order.
    await expectDenied(await request(member, `/api/v1/issues/${orphanIssueId}`))
    await expectDenied(
      await request(outsider, `/api/v1/issues/${orphanIssueId}`),
    )
  })

  it('leaves an issue with no axis reachable by cross-program authority, and repairable', async () => {
    // The repair path the fail-closed rule rests on: `programId` on
    // `issueUpdateSchema` is the only way to give an orphan an axis, and
    // without it this row would be visible to an administrator and still
    // unfixable through any route.
    expect(
      (await request(crossProgramAdmin, `/api/v1/issues/${orphanIssueId}`))
        .status,
    ).toBe(200)

    const repaired = await request(
      crossProgramAdmin,
      `/api/v1/issues/${orphanIssueId}`,
      'PUT',
      { programId },
    )
    expect(repaired.status).toBe(200)

    expect(
      (await request(member, `/api/v1/issues/${orphanIssueId}`)).status,
    ).toBe(200)
    await expectDenied(
      await request(outsider, `/api/v1/issues/${orphanIssueId}`),
    )
  })

  it('refuses to move an issue into a program the caller cannot reach', async () => {
    // Setting the program is a write into the destination: reaching the issue
    // where it sits says nothing about where it is being sent.
    await expectDenied(
      await request(member, `/api/v1/issues/${derivedIssueId}`, 'PUT', {
        programId: foreignProgramId,
      }),
    )
    await expectDenied(
      await request(member, `/api/v1/items/${derivedIssueId}`, 'PUT', {
        programId: foreignProgramId,
      }),
    )
  })
})
