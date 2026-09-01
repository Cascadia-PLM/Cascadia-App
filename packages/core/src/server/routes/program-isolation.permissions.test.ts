// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Program isolation across the item / design / change-order surface
 *
 * RBAC says what a user may do to a *type* of thing; program membership says
 * which *instances* they may touch. These tests pin the second layer where it
 * historically leaked:
 *
 *  - creating items on main (no branchId) must honor design→program access —
 *    this path skipped the check entirely while the branch path enforced it
 *  - reading an item in another program's design is denied
 *  - creating a design in a program requires the canManageDesigns flag
 *    (program admin) or the cross-program bypass (Administrator)
 *  - ECO creation honors the member's canCreateEco flag (program viewers
 *    have it off)
 *  - ECO approval votes require membership in the ECO's program with
 *    canApproveEco on — RBAC change_orders:update alone is not enough
 *  - the change-order list's designId/programId filters are program-scoped
 *    reads and require access to that scope
 *  - the *unfiltered* change-order list, item list, and item search are
 *    bounded by the caller's accessible designs — omitting every filter must
 *    not mean "no scoping at all"
 *  - the two picker feeds draw the same boundary as the lists they sit beside:
 *    the editable-ECO list and the design-family list each took no user at all
 *    and answered about every program on the instance
 *  - running a saved report is bounded the same way: who may open a report
 *    definition is a separate question from whose rows it may return
 *  - and that separate question is enforced too: the by-ID report routes honor
 *    the row's own sharing rule, and editing or deleting one needs ownership
 *    rather than merely the RBAC verb
 *
 * Run: npx vitest run packages/core/src/server/routes/program-isolation.permissions.test.ts
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
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import itemsRoutes from './items'
import designsRoutes from './designs'
import changeOrdersRoutes from './change-orders'
import dashboardRoutes from './dashboard'
import workOrdersRoutes from './work-orders'
import physicalPartsRoutes from './physical-parts'
import reportsRoutes from './reports'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { PhysicalPartService } from '@/lib/services/PhysicalPartService'
import { ReportService } from '@/lib/reports/ReportService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { PermissionDeniedError } from '@/lib/errors'
import { issues, workOrders } from '@/lib/db/schema'
import {
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema/workflows'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('program isolation — items, designs, change orders', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/items', itemsRoutes)
    .route('/api/v1/designs', designsRoutes)
    .route('/api/v1/change-orders', changeOrdersRoutes)
    .route('/api/v1/dashboard', dashboardRoutes)
    .route('/api/v1/work-orders', workOrdersRoutes)
    .route('/api/v1/physical-parts', physicalPartsRoutes)
    .route('/api/v1/reports', reportsRoutes)

  let sysAdmin: TestUser
  let progAdmin: TestUser
  let engineer: TestUser
  let viewer: TestUser
  let approverMember: TestUser // program member, RBAC Approver, canApproveEco on
  let approverNoFlag: TestUser // program member, RBAC Approver, canApproveEco off
  let approverOutsider: TestUser // RBAC Approver, not a member
  let outsider: TestUser

  let programId: string
  let designId: string

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

    sysAdmin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    progAdmin = (await insertTestUserWithRole(testDb.db, 'User')).user
    engineer = (await insertTestUserWithRole(testDb.db, 'User')).user
    viewer = (await insertTestUserWithRole(testDb.db, 'User')).user
    approverMember = (await insertTestUserWithRole(testDb.db, 'Approver')).user
    approverNoFlag = (await insertTestUserWithRole(testDb.db, 'Approver')).user
    approverOutsider = (await insertTestUserWithRole(testDb.db, 'Approver'))
      .user
    outsider = (await insertTestUserWithRole(testDb.db, 'User')).user

    const program = await ProgramService.create(
      {
        name: 'Isolation Program',
        code: `ISO-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      },
      progAdmin.id,
    )
    programId = program.id

    await ProgramService.addMember(
      programId,
      engineer.id,
      'engineer',
      progAdmin.id,
    )
    await ProgramService.addMember(programId, viewer.id, 'viewer', progAdmin.id)
    await ProgramService.addMember(
      programId,
      approverMember.id,
      'lead',
      progAdmin.id,
    )
    await ProgramService.addMember(
      programId,
      approverNoFlag.id,
      'engineer', // canApproveEco defaults to false for engineers
      progAdmin.id,
    )

    const design = await DesignService.create(
      {
        programId,
        name: 'Isolation Design',
        code: `ISOD-${Date.now()}`,
        designType: 'Engineering',
      },
      progAdmin.id,
    )
    designId = design.id

    cookies.clear()
    for (const u of [
      sysAdmin,
      progAdmin,
      engineer,
      viewer,
      approverMember,
      approverNoFlag,
      approverOutsider,
      outsider,
    ]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function as(user: TestUser) {
    const cookie = cookies.get(user.id)!
    return {
      get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
      post: (path: string, body: unknown) =>
        app.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify(body),
        }),
      put: (path: string, body: unknown) =>
        app.request(path, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify(body),
        }),
      del: (path: string) =>
        app.request(path, { method: 'DELETE', headers: { Cookie: cookie } }),
    }
  }

  function partPayload(name: string) {
    return {
      itemType: 'Part',
      designId,
      revision: 'A',
      name,
      partType: 'Manufacture',
    }
  }

  function ecoPayload(name: string, designIds: Array<string> = [designId]) {
    // The route auto-starts a workflow for a changeType, but an absent
    // workflow definition is caught and logged — the invariant under test
    // is the program gate, not workflow config.
    //
    // `designIds`, not `designId`: change orders are created through their own
    // endpoint because the designs are part of the creation. The generic item
    // route refuses the type outright.
    return {
      designIds,
      revision: 'A',
      changeType: 'ECO',
      name,
      description: 'isolation test ECO',
    }
  }

  /**
   * An ECO shaped the way the application shapes one: no `items.designId`,
   * designs attached through `change_order_designs`. Anything that scopes a
   * change order has to survive this shape, not the convenient one.
   */
  async function mkEco(designIds: Array<string>, name = 'Scoped ECO') {
    const eco = (await ItemService.create(
      'ChangeOrder',
      { revision: 'A', changeType: 'ECO', name } as never,
      progAdmin.id,
    )) as { id: string }
    for (const d of designIds) {
      await ChangeOrderService.addDesignToEco(eco.id, d, progAdmin.id)
    }
    return eco.id
  }

  // ==========================================================================
  // Item creation on main (the branch-less path)
  // ==========================================================================

  describe('POST /api/v1/items without branchId', () => {
    it('member with RBAC create can create in their program', async () => {
      const res = await as(engineer).post(
        '/api/v1/items',
        partPayload('Member Part'),
      )
      expect(res.status).toBe(201)
    })

    it('non-member with the same RBAC role cannot reach the design', async () => {
      const res = await as(outsider).post(
        '/api/v1/items',
        partPayload('Sneaky Part'),
      )
      expect(res.status).toBe(403)
    })

    it('Administrator bypasses membership', async () => {
      const res = await as(sysAdmin).post(
        '/api/v1/items',
        partPayload('Admin Part'),
      )
      expect(res.status).toBe(201)
    })
  })

  // ==========================================================================
  // Item reads
  // ==========================================================================

  describe('GET /api/v1/items/:id', () => {
    it("an item in a program's design is invisible to non-members", async () => {
      const part = (await ItemService.create(
        'Part',
        {
          designId,
          revision: 'A',
          name: 'Hidden Part',
          partType: 'Manufacture',
        } as never,
        progAdmin.id,
      )) as { id: string }

      expect((await as(viewer).get(`/api/v1/items/${part.id}`)).status).toBe(
        200,
      )
      expect((await as(outsider).get(`/api/v1/items/${part.id}`)).status).toBe(
        403,
      )
      expect((await as(sysAdmin).get(`/api/v1/items/${part.id}`)).status).toBe(
        200,
      )
    })
  })

  // ==========================================================================
  // Design creation & reads
  // ==========================================================================

  describe('POST /api/v1/designs with programId', () => {
    function designPayload(suffix: string) {
      return {
        programId,
        name: `New Design ${suffix}`,
        code: `NEWD-${Date.now()}-${suffix}`,
        designType: 'Engineering',
      }
    }

    it('requires the canManageDesigns flag: admin yes, engineer no', async () => {
      expect(
        (await as(progAdmin).post('/api/v1/designs', designPayload('A')))
          .status,
      ).toBe(201)
      expect(
        (await as(engineer).post('/api/v1/designs', designPayload('B'))).status,
      ).toBe(403)
      expect(
        (await as(outsider).post('/api/v1/designs', designPayload('C'))).status,
      ).toBe(403)
    })

    it('Administrator can create designs in any program', async () => {
      const res = await as(sysAdmin).post('/api/v1/designs', designPayload('G'))
      expect(res.status).toBe(201)
    })
  })

  describe('GET /api/v1/designs/:id', () => {
    it('is denied outside the program', async () => {
      expect((await as(viewer).get(`/api/v1/designs/${designId}`)).status).toBe(
        200,
      )
      expect(
        (await as(outsider).get(`/api/v1/designs/${designId}`)).status,
      ).toBe(403)
      expect(
        (await as(sysAdmin).get(`/api/v1/designs/${designId}`)).status,
      ).toBe(200)
    })
  })

  // The family picker's feed passed the query string's programId straight to
  // the service, so it answered about a program on the caller's say-so alone —
  // the by-id read above refuses the very same program's designs. A `Family`
  // design is needed to test it at all: the route filters on the type, so the
  // suite's Engineering design would leave it answering empty to everyone.
  describe('GET /api/v1/designs/families', () => {
    let familyId: string

    beforeEach(async () => {
      const family = await DesignService.create(
        {
          programId,
          name: 'Isolation Family',
          code: `ISOF-${Date.now()}`,
          designType: 'Family',
        },
        progAdmin.id,
      )
      familyId = family.id
    })

    async function familyIds(user: TestUser, query = '') {
      const res = await as(user).get(`/api/v1/designs/families${query}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { families: Array<{ id: string }> }
      }
      return body.data.families.map((f) => f.id)
    }

    it('refuses a programId naming a program the caller is not in', async () => {
      expect(
        (
          await as(outsider).get(
            `/api/v1/designs/families?programId=${programId}`,
          )
        ).status,
      ).toBe(403)
    })

    it('serves the program’s families to its own members', async () => {
      expect(await familyIds(viewer, `?programId=${programId}`)).toContain(
        familyId,
      )
    })

    it('serves them to cross-program authority', async () => {
      expect(await familyIds(sysAdmin, `?programId=${programId}`)).toContain(
        familyId,
      )
    })

    it('keeps a program’s family out of the program-less listing', async () => {
      // No programId asks for the families belonging to no program, which
      // every authenticated user may read. A program's own family is not one
      // of them, for the member as much as for the outsider.
      expect(await familyIds(outsider)).not.toContain(familyId)
      expect(await familyIds(engineer)).not.toContain(familyId)
    })
  })

  // ==========================================================================
  // ECO creation — the canCreateEco member flag
  // ==========================================================================

  describe('ECO creation honors canCreateEco', () => {
    it('engineer (flag on) can create an ECO', async () => {
      const res = await as(engineer).post(
        '/api/v1/change-orders',
        ecoPayload('Engineer ECO'),
      )
      expect(res.status).toBe(201)
    })

    it('viewer (flag off) cannot create an ECO', async () => {
      const res = await as(viewer).post(
        '/api/v1/change-orders',
        ecoPayload('Viewer ECO'),
      )
      expect(res.status).toBe(403)
    })

    it('the flag is honored when explicitly revoked from an engineer', async () => {
      await ProgramService.updateMember(programId, engineer.id, {
        canCreateEco: false,
      })
      const res = await as(engineer).post(
        '/api/v1/change-orders',
        ecoPayload('Revoked ECO'),
      )
      expect(res.status).toBe(403)
    })

    it('Administrator creates ECOs without a membership row', async () => {
      const res = await as(sysAdmin).post(
        '/api/v1/change-orders',
        ecoPayload('Admin ECO'),
      )
      expect(res.status).toBe(201)
    })
  })

  // ==========================================================================
  // ECO approval votes — the canApproveEco member flag
  // ==========================================================================

  describe('POST /api/v1/change-orders/:id/approvals honors canApproveEco', () => {
    let ecoId: string

    beforeEach(async () => {
      ecoId = await mkEco([designId], 'Vote Target')
    })

    // The personas below all pass RBAC (Approver has change_orders:update).
    // What separates them is the program layer — which is exactly what used
    // to be missing. A caller who clears the program gate proceeds to the
    // workflow-instance lookup and gets 404 here (no workflow configured);
    // a caller stopped by the gate gets 403 before workflow config matters.

    it('a non-member with RBAC approval rights is stopped by the program gate', async () => {
      const res = await as(approverOutsider).post(
        `/api/v1/change-orders/${ecoId}/approvals`,
        { vote: 'approved' },
      )
      expect(res.status).toBe(403)
    })

    it('a member without canApproveEco is stopped by the flag', async () => {
      const res = await as(approverNoFlag).post(
        `/api/v1/change-orders/${ecoId}/approvals`,
        { vote: 'approved' },
      )
      expect(res.status).toBe(403)
    })

    it('a member with canApproveEco passes the gate', async () => {
      const res = await as(approverMember).post(
        `/api/v1/change-orders/${ecoId}/approvals`,
        { vote: 'approved' },
      )
      expect(res.status).toBe(404) // reached the workflow lookup — gate passed
    })

    it('Administrator passes the gate without membership', async () => {
      const res = await as(sysAdmin).post(
        `/api/v1/change-orders/${ecoId}/approvals`,
        { vote: 'approved' },
      )
      expect(res.status).toBe(404) // reached the workflow lookup — gate passed
    })

    it('the state-specific vote endpoint applies the same gate', async () => {
      const res = await as(approverOutsider).post(
        `/api/v1/change-orders/${ecoId}/approvals/some-state`,
        { vote: 'approved' },
      )
      expect(res.status).toBe(403)
    })
  })

  // ==========================================================================
  // An ECO id that names nothing
  // ==========================================================================

  describe('an unknown change-order id', () => {
    // Cross-program authority is the only persona that reaches the service
    // at all — everyone else is refused by the program gate, because an ECO
    // with no reachable designs is not theirs to see and a row that does not
    // exist has none. Past the gate the lookup used to throw a bare Error,
    // which the API error handler classified as an unexpected fault: a
    // mistyped id answered 500 and was logged as a server failure. It is a
    // missing resource, so it answers 404.
    it('is 404 to cross-program authority and 403 to an outsider', async () => {
      const unknown = randomUUID()
      expect(
        (await as(sysAdmin).get(`/api/v1/change-orders/${unknown}/summary`))
          .status,
      ).toBe(404)
      expect(
        (await as(outsider).get(`/api/v1/change-orders/${unknown}/summary`))
          .status,
      ).toBe(403)
    })
  })

  // ==========================================================================
  // Change-order list scoping
  // ==========================================================================

  describe('GET /api/v1/change-orders scoping', () => {
    let ecoId: string

    // Built the way the application builds one: `items.designId` left NULL,
    // the design linked through `change_order_designs`. Setting `designId` on
    // the ECO row instead — which no code path in the app does — made every
    // test in this block pass against a boundary that was not being drawn.
    beforeEach(async () => {
      ecoId = await mkEco([designId])
    })

    it('the programId filter requires access to that program', async () => {
      expect(
        (await as(outsider).get(`/api/v1/change-orders?programId=${programId}`))
          .status,
      ).toBe(403)
      expect(
        (await as(viewer).get(`/api/v1/change-orders?programId=${programId}`))
          .status,
      ).toBe(200)
      expect(
        (await as(sysAdmin).get(`/api/v1/change-orders?programId=${programId}`))
          .status,
      ).toBe(200)
    })

    it('the designId filter requires access to that design', async () => {
      expect(
        (await as(outsider).get(`/api/v1/change-orders?designId=${designId}`))
          .status,
      ).toBe(403)
      expect(
        (await as(viewer).get(`/api/v1/change-orders?designId=${designId}`))
          .status,
      ).toBe(200)
    })

    // Was a pinned known gap: omitting the filter used to skip scoping
    // altogether, so an outsider saw every program's ECOs. The list now
    // carries the caller's accessible designs as its own bound, applied over
    // `change_order_designs` rather than `items.designId` — the latter is
    // NULL on every ECO the app creates, which put all of them in the
    // design-less "visible to everyone" bucket.
    it('the unfiltered list hides other programs’ ECOs', async () => {
      const res = await as(outsider).get('/api/v1/change-orders?limit=200')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { changeOrders: Array<{ id: string }> }
      }
      const ids = body.data.changeOrders.map((c) => c.id)
      expect(ids).not.toContain(ecoId)
    })

    it('the unfiltered list still shows a member their own ECOs', async () => {
      const res = await as(engineer).get('/api/v1/change-orders?limit=200')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { changeOrders: Array<{ id: string }> }
      }
      expect(body.data.changeOrders.map((c) => c.id)).toContain(ecoId)
    })

    it('the by-id read draws the same boundary as the list', async () => {
      expect(
        (await as(outsider).get(`/api/v1/change-orders/${ecoId}`)).status,
      ).toBe(403)
      expect(
        (await as(engineer).get(`/api/v1/change-orders/${ecoId}`)).status,
      ).toBe(200)
    })

    // `/editable` is the second list over change orders — the picker feed the
    // "add this item to an ECO" dialog reads. It took no user at all, so it
    // answered with every editable ECO on the instance to anyone holding
    // `change_orders:read`, which every built-in role carries. These cases are
    // the sibling assertions above, repeated against it: whatever the two
    // lists disagree about is a hole, because the same rows are on both.
    describe('the editable-ECO picker draws the same boundary', () => {
      async function editableIds(user: TestUser, query = '') {
        const res = await as(user).get(`/api/v1/change-orders/editable${query}`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          data: { changeOrders: Array<{ id: string }> }
        }
        return body.data.changeOrders.map((c) => c.id)
      }

      it('hides another program’s editable ECOs', async () => {
        expect(await editableIds(outsider)).not.toContain(ecoId)
      })

      it('still shows a member their own', async () => {
        expect(await editableIds(engineer)).toContain(ecoId)
      })

      it('shows cross-program authority every program’s', async () => {
        expect(await editableIds(sysAdmin)).toContain(ecoId)
      })

      it('gates the designId filter the way the sibling list does', async () => {
        expect(
          (
            await as(outsider).get(
              `/api/v1/change-orders/editable?designId=${designId}`,
            )
          ).status,
        ).toBe(403)
        expect(await editableIds(engineer, `?designId=${designId}`)).toContain(
          ecoId,
        )
      })
    })

    // The writes drew no boundary at all: RBAC change_orders:update was the
    // whole check on ~30 by-id routes, and AUTH-1's item-level design gate
    // cannot reach them because items.designId is NULL on every ECO the app
    // creates.
    //
    // Which user asks matters more than usual here. `outsider` is an RBAC
    // `User`, who has change_orders read+create but NOT update — so a 403 from
    // them on a write would come from RBAC and prove nothing about program
    // membership. `approverOutsider` is an RBAC `Approver`: change_orders
    // read+update+approve, `programs: ['read']` only, and not a member of this
    // program. They clear RBAC and must be stopped by the boundary alone.
    it('a write from someone with the verb but not the membership is refused', async () => {
      const res = await as(approverOutsider).put(
        `/api/v1/change-orders/${ecoId}`,
        { name: 'Renamed by an outsider' },
      )
      expect(res.status).toBe(403)

      const member = await as(approverMember).put(
        `/api/v1/change-orders/${ecoId}`,
        { name: 'Renamed by a member' },
      )
      expect(member.status).toBe(200)
    })

    it('refuses before reading the request body', async () => {
      // A body that would fail validation on the way through. 403 rather than
      // 400 is what says the gate ran first.
      const res = await as(approverOutsider).post(
        `/api/v1/change-orders/${ecoId}/workflow/transition`,
        { nonsense: true },
      )
      expect(res.status).toBe(403)
    })

    // These are read-level routes, so plain `outsider` clears RBAC on them and
    // the 403 can only be the boundary.
    it('gates the read surface an outsider could otherwise walk', async () => {
      for (const path of [
        `/api/v1/change-orders/${ecoId}/approvals`,
        `/api/v1/change-orders/${ecoId}/approvals/can-approve`,
        `/api/v1/change-orders/${ecoId}/branch-history`,
        `/api/v1/change-orders/${ecoId}/branch-history/graph`,
        `/api/v1/change-orders/${ecoId}/conflict-reviews`,
        `/api/v1/change-orders/${ecoId}/release`,
        `/api/v1/change-orders/${ecoId}/risks`,
        `/api/v1/change-orders/${ecoId}/workflow`,
        `/api/v1/change-orders/${ecoId}/workflow/history`,
        `/api/v1/change-orders/${ecoId}/workflow/structure`,
        `/api/v1/change-orders/${ecoId}/workflow/transition`,
      ]) {
        expect((await as(outsider).get(path)).status).toBe(403)
      }
    })

    // The route gate alone would leave the AI tools and submit/approve/reject
    // ungated: executeWorkflowTransition is the shared entry point, so the
    // check lives there too.
    it('gates executeWorkflowTransition below the route', async () => {
      await expect(
        ChangeOrderService.executeWorkflowTransition(
          ecoId,
          'any-state',
          outsider.id,
        ),
      ).rejects.toThrow(PermissionDeniedError)
    })
  })

  // ==========================================================================
  // Change orders spanning two programs
  //
  // A change order reaches into every design it lists, and the designs are
  // equal. A member of one of them has business with the ECO and must be able
  // to open it — but what it touches elsewhere is not theirs to read.
  //
  // The withheld part is neither shown nor silently dropped. It collapses to
  // one anonymous flag: a caller who is told nothing would submit or approve
  // believing they had reviewed the whole change, and a caller told how much
  // or whose is being told the size and identity of a program they cannot
  // open. `hasRestricted` is the whole disclosure — go ask for access to
  // whatever else this ECO touches.
  // ==========================================================================

  describe('an ECO spanning two programs', () => {
    let otherDesignId: string
    let sharedEcoId: string
    let ownPartId: string
    let otherPartId: string

    beforeEach(async () => {
      const otherProgram = await ProgramService.create(
        {
          name: 'Other Program',
          code: `OTH-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        },
        progAdmin.id,
      )
      otherDesignId = (
        await DesignService.create(
          {
            programId: otherProgram.id,
            name: 'Other Design',
            code: `OTHD-${Date.now()}`,
            designType: 'Engineering',
          },
          progAdmin.id,
        )
      ).id

      // progAdmin created both programs, so they reach both designs; engineer
      // is a member of the first only.
      sharedEcoId = await mkEco([designId, otherDesignId], 'Cross-program ECO')

      const mk = async (dId: string, label: string) =>
        (
          (await ItemService.create(
            'Part',
            {
              designId: dId,
              revision: 'A',
              name: `${label} Part`,
              itemNumber: `${label}-${Date.now()}`,
              partType: 'Manufacture',
            } as never,
            progAdmin.id,
          )) as { id: string }
        ).id

      ownPartId = await mk(designId, 'OWN')
      otherPartId = await mk(otherDesignId, 'OTHER')

      for (const itemId of [ownPartId, otherPartId]) {
        await ChangeOrderService.addAffectedItem(
          sharedEcoId,
          { affectedItemId: itemId, changeAction: 'release' },
          progAdmin.id,
        )
      }
    })

    const affectedItemsFor = async (user: TestUser) => {
      const res = await as(user).get(
        `/api/v1/change-orders/${sharedEcoId}/affected-items`,
      )
      expect(res.status).toBe(200)
      return (await res.json()) as {
        data: {
          affectedItems: Array<{
            affectedItemId: string | null
            affectedItemDetails?: { designId: string | null }
          }>
          hasRestricted: boolean
        }
      }
    }

    it('a member of one program can open it', async () => {
      expect(
        (await as(engineer).get(`/api/v1/change-orders/${sharedEcoId}`)).status,
      ).toBe(200)
    })

    it('shows them their own program’s items', async () => {
      const body = await affectedItemsFor(engineer)
      expect(body.data.affectedItems.map((a) => a.affectedItemId)).toContain(
        ownPartId,
      )
    })

    it('withholds the other program’s items', async () => {
      const body = await affectedItemsFor(engineer)
      expect(
        body.data.affectedItems.map((a) => a.affectedItemId),
      ).not.toContain(otherPartId)
      expect(
        body.data.affectedItems.some(
          (a) => a.affectedItemDetails?.designId === otherDesignId,
        ),
      ).toBe(false)
    })

    it('says that something was withheld rather than hiding it silently', async () => {
      expect((await affectedItemsFor(engineer)).data.hasRestricted).toBe(true)
    })

    it('says nothing about how much, or whose', async () => {
      const body = await affectedItemsFor(engineer)
      // One flag, not a per-item marker and not a count: the number of
      // withheld rows sizes the other program, and naming its design or
      // program identifies it. Both are disclosures in their own right.
      const payload = JSON.stringify(body.data)
      expect(payload).not.toContain(otherDesignId)
      expect(payload).not.toContain(otherPartId)
      expect(Object.keys(body.data).sort()).toEqual([
        'affectedItems',
        'hasRestricted',
      ])
    })

    it('withholds the other program’s design from the ECO’s design list', async () => {
      const res = await as(engineer).get(
        `/api/v1/change-orders/${sharedEcoId}/designs`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: {
          designs: Array<{ designId: string }>
          hasRestricted: boolean
        }
      }
      expect(body.data.designs.map((d) => d.designId)).toEqual([designId])
      expect(body.data.hasRestricted).toBe(true)
      // Redacting the items while this still named every design would undo
      // the redaction in one extra request.
      expect(JSON.stringify(body.data)).not.toContain(otherDesignId)
    })

    it('reports totals the caller can see, not the ECO’s true size', async () => {
      const res = await as(engineer).get(
        `/api/v1/change-orders/${sharedEcoId}/summary`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: {
          totalItemsAffected: number
          designs: Array<{ designId: string }>
          hasRestricted: boolean
          canSubmit: boolean
          canRelease: boolean
        }
      }
      // Two affected items exist; this caller may see one. Reporting 2 here
      // would hand back the withheld count by subtraction.
      expect(body.data.totalItemsAffected).toBe(1)
      expect(body.data.designs.map((d) => d.designId)).toEqual([designId])
      expect(body.data.hasRestricted).toBe(true)
    })

    it('will not let them advance an ECO that reaches past what they can see', async () => {
      const res = await as(engineer).get(
        `/api/v1/change-orders/${sharedEcoId}/summary`,
      )
      const body = (await res.json()) as {
        data: { canSubmit: boolean; canRelease: boolean }
      }
      expect(body.data.canSubmit).toBe(false)
      expect(body.data.canRelease).toBe(false)
    })

    // ========================================================================
    // Advancing the ECO, not just being told you cannot
    //
    // The summary hint above is a hint. These drive the endpoint that actually
    // moves the change order, because a releasing transition merges *every*
    // linked design's branch and stamps permanent revision letters in designs
    // the caller cannot open — and the merge path deliberately runs with
    // per-item access checks disabled on the strength of the gate here.
    //
    // Three tiers, deliberately different: reading an ECO needs reach to one
    // linked design, voting needs canApproveEco in every linked program, and
    // advancing it — submit, release, cancel — needs reach to every linked
    // design. Cross-program authority bypasses all three.
    //
    // The actor is `approverMember`, not `engineer`: the RBAC `User` role has
    // no change_orders:update, so a denial for `engineer` would prove only
    // that RBAC ran. `approverMember` carries the verb and is a member of the
    // first program alone, which is exactly the partial-reach case.
    // ========================================================================

    /**
     * Raw-insert a Driving workflow with one non-final hop, one releasing
     * final state and one cancelling one, and park the ECO's instance in
     * `currentState`. Raw because the point is the access gate, not workflow
     * configuration, and parking directly is how a test reaches a mid-workflow
     * state without going through the gate under test.
     */
    async function giveEcoWorkflow(ecoId: string, currentState: string) {
      const defId = randomUUID()
      await testDb.db.insert(workflowDefinitions).values({
        id: defId,
        name: `ISO Advance ${randomUUID()}`,
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            {
              id: 'InReview',
              name: 'InReview',
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
            {
              id: 'Cancelled',
              name: 'Cancelled',
              isInitial: false,
              isFinal: true,
              finalKind: 'cancel',
            },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Submit',
              fromStateId: 'Draft',
              toStateId: 'InReview',
            },
            {
              id: 't2',
              name: 'Release',
              fromStateId: 'InReview',
              toStateId: 'Released',
            },
            {
              id: 't3',
              name: 'Cancel',
              fromStateId: 'InReview',
              toStateId: 'Cancelled',
            },
            {
              id: 't4',
              name: 'Return to Draft',
              fromStateId: 'InReview',
              toStateId: 'Draft',
            },
          ],
          definitionType: 'workflow',
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
        lifecycleType: 'Driving',
      })
      await testDb.db.insert(workflowInstances).values({
        workflowDefinitionId: defId,
        itemId: ecoId,
        currentState,
      })
    }

    const transition = (user: TestUser, ecoId: string, toStateId: string) =>
      as(user).post(`/api/v1/change-orders/${ecoId}/workflow/transition`, {
        toStateId,
      })

    it('refuses to release an ECO reaching past what the caller can see', async () => {
      await giveEcoWorkflow(sharedEcoId, 'InReview')
      expect(
        (await transition(approverMember, sharedEcoId, 'Released')).status,
      ).toBe(403)
    })

    it('refuses to cancel it either — abandoning the unreachable half is destruction too', async () => {
      await giveEcoWorkflow(sharedEcoId, 'InReview')
      expect(
        (await transition(approverMember, sharedEcoId, 'Cancelled')).status,
      ).toBe(403)
    })

    it('refuses to submit it — the scope they would lock is not the scope they were shown', async () => {
      await giveEcoWorkflow(sharedEcoId, 'Draft')
      expect(
        (await transition(approverMember, sharedEcoId, 'InReview')).status,
      ).toBe(403)
    })

    it('still allows a transition that neither leaves the initial state nor ends the ECO', async () => {
      await giveEcoWorkflow(sharedEcoId, 'InReview')
      // The gate is scoped to advancing transitions, not a blanket denial —
      // and this is also what proves RBAC is not what refuses the three above.
      expect(
        (await transition(approverMember, sharedEcoId, 'Draft')).status,
      ).toBe(200)
    })

    it('does not refuse cross-program authority', async () => {
      await giveEcoWorkflow(sharedEcoId, 'InReview')
      expect(
        (await transition(sysAdmin, sharedEcoId, 'Released')).status,
      ).not.toBe(403)
    })

    it('leaves a single-program ECO releasable by its own program’s member', async () => {
      // Regression guard: the rule is "reaches every linked design", not
      // "links more than one design".
      const soloEcoId = await mkEco([designId], 'Single-program ECO')
      await giveEcoWorkflow(soloEcoId, 'InReview')
      expect(
        (await transition(approverMember, soloEcoId, 'Released')).status,
      ).not.toBe(403)
    })

    // The route gate alone would leave the AI write-handlers and the MCP
    // tools ungated: executeWorkflowTransition is the shared entry point.
    it('gates the advancing transition below the route as well', async () => {
      await giveEcoWorkflow(sharedEcoId, 'InReview')
      await expect(
        ChangeOrderService.executeWorkflowTransition(
          sharedEcoId,
          'Released',
          approverMember.id,
        ),
      ).rejects.toThrow(PermissionDeniedError)
    })

    it('refuses their approval vote — one program’s consent is not the ECO’s', async () => {
      const res = await as(approverMember).post(
        `/api/v1/change-orders/${sharedEcoId}/approvals`,
        { vote: 'approved' },
      )
      // approverMember has canApproveEco in the first program and no
      // membership at all in the second.
      expect(res.status).toBe(403)
    })

    it('refuses a structure read for the design they cannot reach', async () => {
      expect(
        (
          await as(engineer).get(
            `/api/v1/change-orders/${sharedEcoId}/designs/${otherDesignId}/structure`,
          )
        ).status,
      ).toBe(403)
    })

    it('shows Administrator the whole change order', async () => {
      const body = await affectedItemsFor(sysAdmin)
      expect(body.data.hasRestricted).toBe(false)
      expect(body.data.affectedItems.map((a) => a.affectedItemId)).toEqual(
        expect.arrayContaining([ownPartId, otherPartId]),
      )
    })
  })

  // ==========================================================================
  // The at-least-one-design invariant
  // ==========================================================================

  describe('a change order must be created against a design', () => {
    it('refuses an empty design list', async () => {
      const res = await as(engineer).post(
        '/api/v1/change-orders',
        ecoPayload('Design-less ECO', []),
      )
      expect(res.status).toBe(400)
    })

    it('refuses the generic item route, which cannot take designs', async () => {
      const res = await as(engineer).post('/api/v1/items', {
        itemType: 'ChangeOrder',
        designId,
        revision: 'A',
        changeType: 'ECO',
        name: 'Back-door ECO',
      })
      expect(res.status).toBe(400)
    })

    // Rows predating the invariant. They cannot be created any more, but a
    // deployed database may hold them, and the repair is to link a design —
    // which requires someone able to open them.
    it('leaves a link-less change order reachable by Administrator alone', async () => {
      const orphan = (await ItemService.create(
        'ChangeOrder',
        { revision: 'A', changeType: 'ECO', name: 'Legacy Orphan' } as never,
        progAdmin.id,
      )) as { id: string }

      expect(
        (await as(sysAdmin).get(`/api/v1/change-orders/${orphan.id}`)).status,
      ).toBe(200)
      expect(
        (await as(engineer).get(`/api/v1/change-orders/${orphan.id}`)).status,
      ).toBe(403)

      // And it is out of the list for everyone but them, rather than in
      // everyone's list as it used to be.
      const listed = async (user: TestUser) => {
        const res = await as(user).get('/api/v1/change-orders?limit=200')
        const body = (await res.json()) as {
          data: { changeOrders: Array<{ id: string }> }
        }
        return body.data.changeOrders.map((c) => c.id)
      }
      expect(await listed(sysAdmin)).toContain(orphan.id)
      expect(await listed(engineer)).not.toContain(orphan.id)
    })

    it('leaves no change order behind when a design cannot be linked', async () => {
      const before = await as(engineer).get('/api/v1/change-orders?limit=200')
      const countBefore = (
        (await before.json()) as { data: { changeOrders: Array<unknown> } }
      ).data.changeOrders.length

      const res = await as(engineer).post(
        '/api/v1/change-orders',
        ecoPayload('Doomed ECO', [
          designId,
          '00000000-0000-0000-0000-000000000000',
        ]),
      )
      expect(res.status).not.toBe(201)

      const after = await as(engineer).get('/api/v1/change-orders?limit=200')
      const countAfter = (
        (await after.json()) as { data: { changeOrders: Array<unknown> } }
      ).data.changeOrders.length
      expect(countAfter).toBe(countBefore)
    })
  })

  // ==========================================================================
  // Unfiltered item reads
  //
  // RBAC parts:read says the outsider may read parts; program membership says
  // which ones. These paths take no designId, so nothing upstream had checked
  // the caller against a design — they listed and searched the whole instance.
  // ==========================================================================

  describe('item lists and search are bounded by accessible designs', () => {
    let partId: string

    beforeEach(async () => {
      const part = (await ItemService.create(
        'Part',
        {
          designId,
          revision: 'A',
          name: 'Scoped Part',
          itemNumber: `SCOPED-${Date.now()}`,
          partType: 'Manufacture',
        } as never,
        progAdmin.id,
      )) as { id: string }
      partId = part.id
    })

    const idsFrom = async (res: Response) => {
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { items: Array<{ id: string }> }
      }
      return body.data.items.map((i) => i.id)
    }

    it('the unfiltered item list hides another program’s parts', async () => {
      expect(
        await idsFrom(await as(outsider).get('/api/v1/items?itemType=Part')),
      ).not.toContain(partId)
    })

    it('a member still sees their own program’s parts', async () => {
      expect(
        await idsFrom(await as(engineer).get('/api/v1/items?itemType=Part')),
      ).toContain(partId)
    })

    it('Administrator sees every program’s parts', async () => {
      expect(
        await idsFrom(await as(sysAdmin).get('/api/v1/items?itemType=Part')),
      ).toContain(partId)
    })

    it('state counts agree with the rows the caller may see', async () => {
      const res = await as(outsider).get(
        '/api/v1/items?itemType=Part&limit=1&includeCounts=true&countStates=Draft',
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { total: number; counts: Record<string, number> }
      }
      expect(body.data.total).toBe(0)
      expect(body.data.counts.Draft).toBe(0)
    })

    it('the by-type search hides another program’s parts', async () => {
      expect(
        await idsFrom(
          await as(outsider).get('/api/v1/items/search?itemType=Part'),
        ),
      ).not.toContain(partId)
    })

    it('the free-text search hides another program’s parts', async () => {
      expect(
        await idsFrom(await as(outsider).get('/api/v1/items/search?q=Scoped')),
      ).not.toContain(partId)
    })

    it('a design the caller cannot reach is refused, not silently widened', async () => {
      const res = await as(outsider).get(
        `/api/v1/items?itemType=Part&designId=${designId}`,
      )
      expect(res.status).toBe(403)
    })

    it('naming another program in the filter is refused', async () => {
      const res = await as(outsider).get(
        `/api/v1/items?itemType=Part&programId=${programId}`,
      )
      expect(res.status).toBe(403)
    })
  })

  // ==========================================================================
  // Program-less designs
  //
  // Scoping bounds what a program hides, not what it shares. A design with no
  // program has no membership that could gate it — the Standard Library is
  // the case that matters, since every program's BOMs point into it — so it
  // stays readable by everyone, including a user who belongs to no program at
  // all. A Library that *has* been assigned to a program is not special and
  // follows that program's membership.
  // ==========================================================================

  describe('designs with no program stay readable by everyone', () => {
    let libraryPartId: string
    let unassignedPartId: string
    let programLibraryPartId: string

    beforeEach(async () => {
      const stdLib = await DesignService.create(
        {
          programId: null,
          name: 'Standard Library',
          code: `STD-LIB-${Date.now()}`,
          designType: 'Library',
        },
        progAdmin.id,
      )
      const unassigned = await DesignService.create(
        {
          programId: null,
          name: 'Unassigned Design',
          code: `UNASSIGNED-${Date.now()}`,
          designType: 'Engineering',
        },
        progAdmin.id,
      )
      // A Library that *is* in a program — the case the old scoping helper
      // waved through for everyone purely because its type said 'Library'.
      const programLibrary = await DesignService.create(
        {
          programId,
          name: 'Program Library',
          code: `PROGLIB-${Date.now()}`,
          designType: 'Library',
        },
        progAdmin.id,
      )

      const mkPart = async (dId: string, label: string) =>
        (
          (await ItemService.create(
            'Part',
            {
              designId: dId,
              revision: 'A',
              name: `${label} Part`,
              itemNumber: `${label}-${Date.now()}`,
              partType: 'Manufacture',
            } as never,
            progAdmin.id,
          )) as { id: string }
        ).id

      libraryPartId = await mkPart(stdLib.id, 'LIBPART')
      unassignedPartId = await mkPart(unassigned.id, 'UNASSIGNEDPART')
      programLibraryPartId = await mkPart(programLibrary.id, 'PROGLIBPART')
    })

    const listedFor = async (user: TestUser) => {
      const res = await as(user).get('/api/v1/items?itemType=Part&limit=200')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { items: Array<{ id: string }> }
      }
      return body.data.items.map((i) => i.id)
    }

    it('a user in no program still sees Standard Library parts', async () => {
      expect(await listedFor(outsider)).toContain(libraryPartId)
    })

    it('a user in no program still sees unassigned-design parts', async () => {
      expect(await listedFor(outsider)).toContain(unassignedPartId)
    })

    it('a program member sees the library alongside their own program', async () => {
      expect(await listedFor(engineer)).toContain(libraryPartId)
    })

    it('search reaches the library for a user in no program', async () => {
      const res = await as(outsider).get('/api/v1/items/search?itemType=Part')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { items: Array<{ id: string }> }
      }
      expect(body.data.items.map((i) => i.id)).toContain(libraryPartId)
    })

    it('dashboard counts include the library for a user in no program', async () => {
      const res = await as(outsider).get('/api/v1/dashboard/stats')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { stats: Record<string, number> }
      }
      // Two program-less parts above; the program's own parts stay hidden.
      expect(body.data.stats.parts).toBe(2)
    })

    it('a Library assigned to a program follows that program', async () => {
      expect(await listedFor(outsider)).not.toContain(programLibraryPartId)
      expect(await listedFor(engineer)).toContain(programLibraryPartId)
    })
  })

  // ==========================================================================
  // Work orders
  //
  // A work order names its program on its own row rather than through a
  // design, so it scopes on that axis instead — same invariant, different
  // column.
  // ==========================================================================

  describe('GET /api/v1/work-orders', () => {
    let workOrderId: string

    beforeEach(async () => {
      const part = (await ItemService.create(
        'Part',
        {
          designId,
          revision: 'A',
          name: 'WO Part',
          itemNumber: `WOP-${Date.now()}`,
          partType: 'Manufacture',
        } as never,
        progAdmin.id,
      )) as { id: string }

      const wo = await WorkOrderService.create(
        {
          partId: part.id,
          programId,
          quantity: 1,
          priority: 'Normal',
          assignedTo: [],
          requiresSignOff: false,
        },
        progAdmin.id,
      )
      workOrderId = wo.id
    })

    const woIdsFor = async (user: TestUser) => {
      const res = await as(user).get('/api/v1/work-orders?limit=200')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { workOrders: Array<{ id: string }> }
      }
      return body.data.workOrders.map((w) => w.id)
    }

    it('hides another program’s work orders', async () => {
      expect(await woIdsFor(outsider)).not.toContain(workOrderId)
    })

    it('shows a member their own program’s work orders', async () => {
      expect(await woIdsFor(engineer)).toContain(workOrderId)
    })

    it('shows Administrator every program’s work orders', async () => {
      expect(await woIdsFor(sysAdmin)).toContain(workOrderId)
    })

    it('refuses a programId filter naming another program', async () => {
      const res = await as(outsider).get(
        `/api/v1/work-orders?programId=${programId}`,
      )
      expect(res.status).toBe(403)
    })

    describe('a work order with no program at all', () => {
      let unscopedId: string

      beforeEach(async () => {
        // Creation derives the program from the part being built, so a NULL
        // column can only be reached by writing it — which is what a
        // deployment predating that derivation is full of.
        const wo = await WorkOrderService.create(
          {
            quantity: 1,
            priority: 'Normal',
            assignedTo: [],
            requiresSignOff: false,
          },
          progAdmin.id,
        )
        unscopedId = wo.id
        await testDb.db
          .update(workOrders)
          .set({ programId: null })
          .where(eq(workOrders.itemId, unscopedId))
      })

      it('is hidden from everyone without cross-program authority', async () => {
        expect(await woIdsFor(engineer)).not.toContain(unscopedId)
        expect(await woIdsFor(outsider)).not.toContain(unscopedId)
      })

      it('is listed for Administrator, who is the one who can repair it', async () => {
        expect(await woIdsFor(sysAdmin)).toContain(unscopedId)
      })
    })
  })

  // ==========================================================================
  // The part a work-order body names
  //
  // `partId` is an instance the caller reaches or does not, and the create and
  // update responses echo that part's number, name and revision back. So the
  // body is a read of the part, and it is also a write of the program: the
  // program is derived from the part when the body omits one, and where the
  // body supplies one the two must agree — a work order pointing at one
  // program's part while filed in another is a standing bridge between them,
  // which the traveler then copies that part's BOM and instructions across.
  // ==========================================================================

  describe('POST / PUT /api/v1/work-orders — the part the body names', () => {
    let ownPartId: string
    let ownPartNumber: string
    let ownPartName: string
    let foreignProgramId: string
    let foreignPartId: string
    let foreignPartNumber: string
    let foreignPartName: string
    let libraryPartId: string
    let ownWorkOrderId: string

    const mkPart = async (dId: string, label: string) => {
      const itemNumber = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
      const name = `${label} Body Part`
      const part = (await ItemService.create(
        'Part',
        {
          designId: dId,
          revision: 'A',
          name,
          itemNumber,
          partType: 'Manufacture',
        } as never,
        progAdmin.id,
      )) as { id: string }
      return { id: part.id, itemNumber, name }
    }

    beforeEach(async () => {
      // progAdmin creates both programs, so they reach both; engineer is a
      // member of the first only and outsider of neither.
      const foreign = await ProgramService.create(
        {
          name: 'Foreign Program',
          code: `FGN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        },
        progAdmin.id,
      )
      foreignProgramId = foreign.id
      const foreignDesign = await DesignService.create(
        {
          programId: foreignProgramId,
          name: 'Foreign Design',
          code: `FGND-${Date.now()}`,
          designType: 'Engineering',
        },
        progAdmin.id,
      )
      const library = await DesignService.create(
        {
          programId: null,
          name: 'Body Standard Library',
          code: `BODY-LIB-${Date.now()}`,
          designType: 'Library',
        },
        progAdmin.id,
      )

      const own = await mkPart(designId, 'OWNBODY')
      ownPartId = own.id
      ownPartNumber = own.itemNumber
      ownPartName = own.name

      const foreignPart = await mkPart(foreignDesign.id, 'FGNBODY')
      foreignPartId = foreignPart.id
      foreignPartNumber = foreignPart.itemNumber
      foreignPartName = foreignPart.name

      libraryPartId = (await mkPart(library.id, 'LIBBODY')).id

      ownWorkOrderId = (
        await WorkOrderService.create(
          {
            partId: ownPartId,
            programId,
            quantity: 1,
            priority: 'Normal',
            assignedTo: [],
            requiresSignOff: false,
          },
          progAdmin.id,
        )
      ).id
    })

    const body = (extra: Record<string, unknown>) => ({
      quantity: 1,
      priority: 'Normal',
      assignedTo: [],
      requiresSignOff: false,
      ...extra,
    })

    it('refuses a create naming a part the caller cannot reach', async () => {
      const res = await as(outsider).post(
        '/api/v1/work-orders',
        body({ partId: ownPartId }),
      )
      expect(res.status).toBe(403)

      // The refusal is the point, but so is what it does not say: the whole
      // reason the gate exists is that the 201 would have echoed this part's
      // identity to someone who cannot open its program.
      const text = await res.text()
      expect(text).not.toContain(ownPartNumber)
      expect(text).not.toContain(ownPartName)
    })

    it('still lets that same caller create a work order naming no part', async () => {
      // Anti-vacancy: `outsider` holds work_orders:create, so the 403 above is
      // instance-level and not the verb being missing.
      const res = await as(outsider).post('/api/v1/work-orders', body({}))
      expect(res.status).toBe(201)
    })

    it('allows a create naming a part in the caller’s own program', async () => {
      const res = await as(engineer).post(
        '/api/v1/work-orders',
        body({ partId: ownPartId }),
      )
      expect(res.status).toBe(201)
    })

    it('refuses an update repointing a work order at an unreachable part', async () => {
      const res = await as(engineer).put(
        `/api/v1/work-orders/${ownWorkOrderId}`,
        { partId: foreignPartId },
      )
      expect(res.status).toBe(403)

      const text = await res.text()
      expect(text).not.toContain(foreignPartNumber)
      expect(text).not.toContain(foreignPartName)
    })

    it('allows an update repointing it at a part in the same program', async () => {
      const other = await mkPart(designId, 'OWNBODY2')
      const res = await as(engineer).put(
        `/api/v1/work-orders/${ownWorkOrderId}`,
        { partId: other.id },
      )
      expect(res.status).toBe(200)
    })

    describe('a part and a program that disagree', () => {
      // sysAdmin has cross-program authority, so neither instance gate refuses
      // these — what refuses them is the agreement rule itself, which is why
      // the assertion is a 400 rather than a 403.
      it('refuses a create pairing one program’s part with another program', async () => {
        const res = await as(sysAdmin).post(
          '/api/v1/work-orders',
          body({ partId: foreignPartId, programId }),
        )
        expect(res.status).toBe(400)
        const payload = (await res.json()) as { error: { code: string } }
        expect(payload.error.code).toBe('VALIDATION_FAILED')
      })

      it('refuses an update moving the program away from the part', async () => {
        const res = await as(sysAdmin).put(
          `/api/v1/work-orders/${ownWorkOrderId}`,
          { programId: foreignProgramId },
        )
        expect(res.status).toBe(400)
        const payload = (await res.json()) as { error: { code: string } }
        expect(payload.error.code).toBe('VALIDATION_FAILED')
      })

      it('refuses an update moving the part away from the program', async () => {
        const res = await as(sysAdmin).put(
          `/api/v1/work-orders/${ownWorkOrderId}`,
          { partId: foreignPartId },
        )
        expect(res.status).toBe(400)
      })

      it('leaves an edit that touches neither alone', async () => {
        const res = await as(sysAdmin).put(
          `/api/v1/work-orders/${ownWorkOrderId}`,
          { quantity: 7 },
        )
        expect(res.status).toBe(200)
      })

      it('exempts a part whose design has no program — any program may build a library part', async () => {
        const res = await as(engineer).post(
          '/api/v1/work-orders',
          body({ partId: libraryPartId, programId }),
        )
        expect(res.status).toBe(201)
      })
    })
  })

  // ==========================================================================
  // Design-less types on GET /api/v1/items
  //
  // The item list reaches every type through one shared predicate, and that
  // predicate used to admit any row with a NULL `items.designId` to everybody.
  // For a work order that contradicted the row's own by-id gate: /work-orders
  // hid it and `requireWorkOrderAccess` refused it, while /items handed it
  // over. The types that carry an axis of their own are now scoped on it, and
  // the types that carry none are still admitted — pinned below so that reads
  // as a ruling rather than as the same oversight.
  // ==========================================================================

  describe('design-less types on GET /api/v1/items', () => {
    const listedIds = async (user: TestUser, itemType: string) => {
      const res = await as(user).get(
        `/api/v1/items?itemType=${itemType}&limit=200`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { items: Array<{ id: string }> }
      }
      return body.data.items.map((i) => i.id)
    }

    const mkPart = async (
      dId: string,
      label: string,
      trackingMode: 'none' | 'lot' | 'serial' = 'none',
    ) =>
      (await ItemService.create(
        'Part',
        {
          designId: dId,
          revision: 'A',
          name: `${label} Part`,
          itemNumber: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          partType: 'Manufacture',
          trackingMode,
        } as never,
        progAdmin.id,
      )) as { id: string; masterId: string }

    describe('work orders', () => {
      let scopedId: string
      let orphanId: string

      beforeEach(async () => {
        const part = await mkPart(designId, 'WOSCOPE')
        scopedId = (
          await WorkOrderService.create(
            {
              partId: part.id,
              programId,
              quantity: 1,
              priority: 'Normal',
              assignedTo: [],
              requiresSignOff: false,
            },
            progAdmin.id,
          )
        ).id
        orphanId = (
          await WorkOrderService.create(
            {
              quantity: 1,
              priority: 'Normal',
              assignedTo: [],
              requiresSignOff: false,
            },
            progAdmin.id,
          )
        ).id
        await testDb.db
          .update(workOrders)
          .set({ programId: null })
          .where(eq(workOrders.itemId, orphanId))
      })

      const woListIds = async (user: TestUser) => {
        const res = await as(user).get('/api/v1/work-orders?limit=200')
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          data: { workOrders: Array<{ id: string }> }
        }
        return body.data.workOrders.map((w) => w.id)
      }

      // The defect stated as a property. Two endpoints read the same rows
      // through two predicates; asserting the sets are equal is what stops
      // them drifting apart again, whatever the rule later becomes.
      it('lists exactly what GET /api/v1/work-orders lists, for every caller', async () => {
        for (const user of [outsider, engineer, sysAdmin]) {
          const fromItems = new Set(await listedIds(user, 'WorkOrder'))
          const fromWorkOrders = new Set(await woListIds(user))
          expect(fromItems).toEqual(fromWorkOrders)
        }
      })

      it('hides another program from the item list too', async () => {
        expect(await listedIds(outsider, 'WorkOrder')).not.toContain(scopedId)
        expect(await listedIds(engineer, 'WorkOrder')).toContain(scopedId)
      })

      // Fails closed on the item list for the reason it does on the
      // work-order list: no program is a data gap, not a row sitting outside
      // every boundary. Administrator keeps reach so the row can be repaired.
      it('hides a program-less work order from everyone but cross-program authority', async () => {
        expect(await listedIds(engineer, 'WorkOrder')).not.toContain(orphanId)
        expect(await listedIds(outsider, 'WorkOrder')).not.toContain(orphanId)
        expect(await listedIds(sysAdmin, 'WorkOrder')).toContain(orphanId)
      })
    })

    describe('physical parts', () => {
      let scopedId: string
      let scopedMasterId: string
      let libraryId: string
      let libraryMasterId: string

      beforeEach(async () => {
        const part = await mkPart(designId, 'PPSCOPE', 'serial')
        scopedMasterId = part.masterId
        scopedId = (
          await PhysicalPartService.register(
            { partMasterId: part.masterId, serialNumber: `SN-${Date.now()}` },
            progAdmin.id,
          )
        ).physicalPart.id

        // A part in a program-less design: nothing gates its lineage, so its
        // units stay ungated too — the exception `requirePhysicalPartAccess`
        // states, kept identical here.
        const stdLib = await DesignService.create(
          {
            programId: null,
            name: 'PP Standard Library',
            code: `PPSTD-${Date.now()}`,
            designType: 'Library',
          },
          progAdmin.id,
        )
        const libraryPart = await mkPart(stdLib.id, 'PPLIB', 'serial')
        libraryMasterId = libraryPart.masterId
        libraryId = (
          await PhysicalPartService.register(
            {
              partMasterId: libraryPart.masterId,
              serialNumber: `SN-LIB-${Date.now()}`,
            },
            progAdmin.id,
          )
        ).physicalPart.id
      })

      const ppListIds = async (user: TestUser) => {
        const res = await as(user).get('/api/v1/physical-parts?limit=200')
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          data: { physicalParts: Array<{ id: string }> }
        }
        return body.data.physicalParts.map((p) => p.id)
      }

      const recalledIds = async (user: TestUser, partMasterId: string) => {
        const res = await as(user).get(
          `/api/v1/physical-parts/recall?partMasterId=${partMasterId}`,
        )
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          data: { results: Array<{ physicalPart: { itemId: string } }> }
        }
        return body.data.results.map((r) => r.physicalPart.itemId)
      }

      it('scopes a unit on the design its part lineage sits in', async () => {
        expect(await listedIds(outsider, 'PhysicalPart')).not.toContain(
          scopedId,
        )
        expect(await listedIds(engineer, 'PhysicalPart')).toContain(scopedId)
        expect(await listedIds(sysAdmin, 'PhysicalPart')).toContain(scopedId)
      })

      it('leaves a unit whose lineage sits in no program visible to everyone', async () => {
        expect(await listedIds(outsider, 'PhysicalPart')).toContain(libraryId)
        expect(await listedIds(engineer, 'PhysicalPart')).toContain(libraryId)
      })

      // The defect stated as a property, the shape the work-order pair above
      // uses. The type's own index ran with no scope at all while the item list
      // scoped it, so the two surfaces answered one question two ways; asserting
      // the sets are equal is what stops them separating again, whatever the
      // rule later becomes.
      it('lists exactly what GET /api/v1/physical-parts lists, for every caller', async () => {
        for (const user of [outsider, engineer, sysAdmin]) {
          const fromItems = new Set(await listedIds(user, 'PhysicalPart'))
          const fromIndex = new Set(await ppListIds(user))
          expect(fromIndex).toEqual(fromItems)
        }
      })

      it('hides another program from the index', async () => {
        expect(await ppListIds(outsider)).not.toContain(scopedId)
      })

      // The over-refusal guard. A boundary that hid the caller's own units
      // would satisfy every negative leg above and be useless, so the
      // admissions are pinned as hard as the refusals.
      it('still shows a member and an administrator their own units', async () => {
        expect(await ppListIds(engineer)).toContain(scopedId)
        expect(await ppListIds(sysAdmin)).toContain(scopedId)
      })

      it('keeps a program-less lineage on the index for everyone', async () => {
        expect(await ppListIds(outsider)).toContain(libraryId)
        expect(await ppListIds(engineer)).toContain(libraryId)
      })

      // /recall is the sibling list surface, and it took the same axis in the
      // same change: `partMasterId` enumerates a whole lineage, so closing the
      // index alone would have left the disclosure reachable one route over.
      it('scopes the recall seeds on the same boundary as the index', async () => {
        expect(await recalledIds(outsider, scopedMasterId)).toEqual([])
        expect(await recalledIds(engineer, scopedMasterId)).toContain(scopedId)
        expect(await recalledIds(sysAdmin, scopedMasterId)).toContain(scopedId)
        // Fail-open follows the predicate here too, rather than being restated.
        expect(await recalledIds(outsider, libraryMasterId)).toContain(
          libraryId,
        )
      })

      // Registering names a part master, and the route answers about it three
      // ways before writing: 404, a ValidationError naming the part's number
      // and trackingMode, or a 201 echoing its name. `physical_parts:create`
      // alone therefore read a lineage in a program the caller cannot reach.
      it('refuses to register an instance against an unreachable lineage', async () => {
        const res = await as(outsider).post('/api/v1/physical-parts/register', {
          partMasterId: scopedMasterId,
          serialNumber: `SN-OUT-${Date.now()}`,
        })
        expect(res.status).toBe(403)

        const allowed = await as(engineer).post(
          '/api/v1/physical-parts/register',
          {
            partMasterId: scopedMasterId,
            serialNumber: `SN-ENG-${Date.now()}`,
          },
        )
        expect(allowed.status).toBe(201)
      })
    })

    // An issue is the only type whose arm is a disjunction, because it is the
    // only one that genuinely carries three axes. Each `it` below pins one
    // disjunct; drop any of them and the predicate collapses into the
    // work-order shape, which would take real rows dark rather than only the
    // rows with no axis at all.
    describe('issues', () => {
      let derivedId: string
      let designCarryingId: string
      let linkOnlyId: string
      let orphanId: string
      let spanningId: string
      let otherDesignId: string

      const mkIssue = async (fields: Record<string, unknown>) =>
        (
          (await ItemService.create(
            'Issue',
            { revision: 'A', ...fields } as never,
            progAdmin.id,
          )) as { id: string }
        ).id

      beforeEach(async () => {
        const otherProgram = await ProgramService.create(
          {
            name: 'Other Isolation Program',
            code: `ISO2-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          },
          sysAdmin.id,
        )
        otherDesignId = (
          await DesignService.create(
            {
              programId: otherProgram.id,
              name: 'Other Isolation Design',
              code: `ISOD2-${Date.now()}`,
              designType: 'Engineering',
            },
            sysAdmin.id,
          )
        ).id

        derivedId = await mkIssue({
          name: 'Derived Issue',
          designIds: [designId],
        })
        designCarryingId = await mkIssue({
          name: 'Branch Issue',
          designId,
        })
        linkOnlyId = await mkIssue({
          name: 'Link Only Issue',
          designIds: [designId],
        })
        await testDb.db
          .update(issues)
          .set({ programId: null })
          .where(eq(issues.itemId, linkOnlyId))
        orphanId = await mkIssue({ name: 'Loose Issue' })
        spanningId = await mkIssue({
          name: 'Spanning Issue',
          designIds: [designId, otherDesignId],
        })
      })

      // The derivation is what stops new rows arriving orphaned. Its input is
      // the designs the create form already collects, so it adds no authority
      // the caller was not already exercising by picking them.
      it('takes the program from the designs chosen at create time', async () => {
        const [row] = await testDb.db
          .select()
          .from(issues)
          .where(eq(issues.itemId, derivedId))
        expect(row?.programId).toBe(programId)
      })

      // Two programs have no single answer, and picking one would move the
      // issue into a program nobody chose. It stays NULL and is reached
      // through its links instead.
      it('derives nothing when the chosen designs span two programs', async () => {
        const [row] = await testDb.db
          .select()
          .from(issues)
          .where(eq(issues.itemId, spanningId))
        expect(row?.programId).toBeNull()
        expect(await listedIds(engineer, 'Issue')).toContain(spanningId)
        expect(await listedIds(outsider, 'Issue')).not.toContain(spanningId)
      })

      it('scopes an issue on the program its designs derived', async () => {
        expect(await listedIds(engineer, 'Issue')).toContain(derivedId)
        expect(await listedIds(outsider, 'Issue')).not.toContain(derivedId)
      })

      // The program disjunct is drawn on `programIds`, which a caller can hold
      // while reaching no design at all — a program with no designs yet leaves
      // `designIds` empty and sends the predicate down its early return.
      // Leaving the issue arm out of that branch would hide a program's own
      // issues from its own members, which is the whole bug restated.
      it('lists an issue to a member of a program that has no designs yet', async () => {
        const emptyProgram = await ProgramService.create(
          {
            name: 'Design-less Program',
            code: `ISO3-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          },
          sysAdmin.id,
        )
        await ProgramService.addMember(
          emptyProgram.id,
          outsider.id,
          'engineer',
          sysAdmin.id,
        )
        const id = await mkIssue({
          name: 'Design-less Program Issue',
          programId: emptyProgram.id,
        })

        expect(await listedIds(outsider, 'Issue')).toContain(id)
        expect(await listedIds(engineer, 'Issue')).not.toContain(id)
      })

      // The disjunct a literal copy of the work-order arm would have dropped:
      // `ItemVersioningFacade.createOnBranch` stamps the branch's design onto
      // every issue raised on an ECO, and those rows carry no program.
      it('keeps an issue carrying a reachable design listed with no program at all', async () => {
        const [row] = await testDb.db
          .select()
          .from(issues)
          .where(eq(issues.itemId, designCarryingId))
        expect(row?.programId).toBeNull()

        expect(await listedIds(engineer, 'Issue')).toContain(designCarryingId)
        expect(await listedIds(outsider, 'Issue')).not.toContain(
          designCarryingId,
        )
      })

      // The third disjunct on its own: no program, no `items.design_id`, one
      // hand-picked design link. Every issue an install created before the
      // derivation and the backfill looks like this.
      it('keeps an issue reachable through its design links alone listed', async () => {
        expect(await listedIds(engineer, 'Issue')).toContain(linkOnlyId)
        expect(await listedIds(outsider, 'Issue')).not.toContain(linkOnlyId)
      })

      // Fails closed for the reason a program-less work order does: no axis at
      // all is a data gap someone has to repair, not a row that sits outside
      // every boundary. Administrator keeps reach so there is someone to
      // repair it — `programId` on `issueUpdateSchema` is how.
      it('hides an issue with no axis at all from everyone but cross-program authority', async () => {
        expect(await listedIds(engineer, 'Issue')).not.toContain(orphanId)
        expect(await listedIds(outsider, 'Issue')).not.toContain(orphanId)
        expect(await listedIds(sysAdmin, 'Issue')).toContain(orphanId)
      })
    })

    // ------------------------------------------------------------------
    // Types with no axis at all stay admitted. That is the current ruling,
    // not an oversight:
    //
    //  - `tools` carries neither a program nor a design column, so there is
    //    nothing to scope on. Tightening it needs a schema change first.
    //  - `tasks.program_id` exists and the type handler writes it, but nothing
    //    in the application ever supplies one and nothing can derive one. The
    //    only structurally single-valued chain, `parent_task_id` → `items` →
    //    `designs`, is written by no form and would terminate in NULL anyway,
    //    because a task's parent is another task and tasks carry no design.
    //    `assignee` → `program_members` is not a derivation but a circle: it
    //    takes the authorization boundary from the membership table the
    //    boundary is checked against, and is right only by accident on a
    //    single-program install — where it looks right while being wrong by
    //    construction, and is wrong precisely when a second program exists,
    //    the only situation the gate exists for. Scoping Task is therefore a
    //    decision to *require* a program at creation, which takes every task
    //    already in an install dark with none of them rescuable:
    //    `taskUpdateSchema` carries no `programId`, so a row scoped in error
    //    has no repair path. That makes it a two-part product change — create
    //    *and* update schemas, plus a picker — not a predicate flip.
    //
    // The ruling has been made rather than deferred: a program is deliberately
    // not required at task creation and Task is deliberately not scoped. It is
    // scoped rather than eternal — right for an install where tasks are
    // instance-wide chores; revisiting it is a product decision about whether
    // tasks are program-private data, not a bug fix. The reasoning lives on
    // `accessScopeCondition` in `@/lib/db/filters` and on `requireItemAccess`
    // in `@/lib/auth/access`; these two tests are what stop either moving by
    // accident.
    //
    // Issue used to sit in this list, on the premise that no form populated
    // `issues.program_id` and that `issue_designs` was empty. Both were false
    // — the create form renders a design multi-select, and the CSV import
    // wizard sends a membership-checked program — so it is scoped now, in the
    // sibling describe above.
    // ------------------------------------------------------------------
    describe('types with no axis to scope on stay admitted', () => {
      it('lists a design-less Tool and Task for a caller in no program', async () => {
        const tool = (await ItemService.create(
          'Tool',
          {
            revision: 'A',
            name: 'Shared Jig',
            toolType: 'manufacturing',
            toolSubtype: 'fixture',
          } as never,
          progAdmin.id,
        )) as { id: string }
        const task = (await ItemService.create(
          'Task',
          { revision: 'A', name: 'Loose Task' } as never,
          progAdmin.id,
        )) as { id: string }

        expect(await listedIds(outsider, 'Tool')).toContain(tool.id)
        expect(await listedIds(outsider, 'Task')).toContain(task.id)
      })

      // The list assertion above exercises `accessScopeCondition` only. This
      // one exercises `requireItemAccess`, the by-id gate that must not drift
      // from it — a reversal reaching only that function would otherwise pass
      // CI green. GET /:id/relationships is `apiHandler({}, …)`: authenticated
      // but with no RBAC resource check at all, so the status is that gate's
      // verdict and nothing else's. Assert the exact 200 rather than "not
      // 403": a refusal on these routes could come from either layer, so only
      // the positive answer is unambiguous.
      it('admits a design-less Task on the by-id gate for a caller in no program', async () => {
        const task = (await ItemService.create(
          'Task',
          { revision: 'A', name: 'Loose Task By Id' } as never,
          progAdmin.id,
        )) as { id: string }

        const res = await as(outsider).get(
          `/api/v1/items/${task.id}/relationships`,
        )

        expect(res.status).toBe(200)
      })
    })
  })

  // ==========================================================================
  // Dashboard counts
  //
  // A count is a disclosure: "12 parts" tells an outsider how much work sits
  // in a program they cannot open.
  // ==========================================================================

  describe('GET /api/v1/dashboard/stats', () => {
    beforeEach(async () => {
      await ItemService.create(
        'Part',
        {
          designId,
          revision: 'A',
          name: 'Counted Part',
          itemNumber: `COUNTED-${Date.now()}`,
          partType: 'Manufacture',
        } as never,
        progAdmin.id,
      )
    })

    const statsFor = async (user: TestUser) => {
      const res = await as(user).get('/api/v1/dashboard/stats')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { stats: Record<string, number> }
      }
      return body.data.stats
    }

    it('counts nothing from a program the caller is not in', async () => {
      const stats = await statsFor(outsider)
      expect(stats.parts).toBe(0)
      expect(stats.programs).toBe(0)
    })

    it('counts the caller’s own program', async () => {
      const stats = await statsFor(engineer)
      expect(stats.parts).toBeGreaterThan(0)
      expect(stats.programs).toBe(1)
    })

    it('Administrator counts everything', async () => {
      const stats = await statsFor(sysAdmin)
      expect(stats.parts).toBeGreaterThan(0)
      expect(stats.programs).toBeGreaterThan(0)
    })
  })

  // ==========================================================================
  // Report execution
  //
  // A report is a saved query somebody else wrote. Sharing it settles who may
  // *run* it — `reports.isPublic` / `sharedWithRoles` / `sharedWithUsers` —
  // and says nothing about whose rows come back. Unbounded, a public report is
  // a general read primitive over every program in the instance, and the CSV
  // export walks the answer straight out the door.
  // ==========================================================================

  describe('POST /api/v1/reports/:id/execute', () => {
    let reportId: string
    let programPartId: string
    let libraryPartId: string

    beforeEach(async () => {
      const library = await DesignService.create(
        {
          programId: null,
          name: 'Report Library',
          code: `RPTLIB-${Date.now()}`,
          designType: 'Library',
        },
        progAdmin.id,
      )

      const mkPart = async (dId: string, label: string) =>
        (
          (await ItemService.create(
            'Part',
            {
              designId: dId,
              revision: 'A',
              name: `${label} Part`,
              itemNumber: `${label}-${Date.now()}`,
              partType: 'Manufacture',
            } as never,
            progAdmin.id,
          )) as { id: string }
        ).id

      programPartId = await mkPart(designId, 'RPTPROG')
      libraryPartId = await mkPart(library.id, 'RPTLIB')

      // Public on purpose: every caller below is allowed to open this report,
      // so the only thing that can bound the rows is the caller's own reach.
      const report = await ReportService.create(
        {
          name: 'Every Part',
          itemType: 'Part',
          isPublic: true,
          columns: [
            { fieldPath: 'id', label: 'ID', displayOrder: 0, isVisible: true },
          ],
          filters: [],
          sorts: [],
        },
        progAdmin.id,
      )
      reportId = report.id!
    })

    const runFor = async (user: TestUser) => {
      const res = await as(user).post(`/api/v1/reports/${reportId}/execute`, {
        limit: 500,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { result: { totalRows: number; rows: Array<{ id: string }> } }
      }
      return body.data.result
    }

    it('withholds parts from a program the caller is not in', async () => {
      const ids = (await runFor(outsider)).rows.map((r) => r.id)
      expect(ids).not.toContain(programPartId)
    })

    it('still returns program-less parts to that caller', async () => {
      const ids = (await runFor(outsider)).rows.map((r) => r.id)
      expect(ids).toContain(libraryPartId)
    })

    it('returns the program’s parts to a member', async () => {
      const ids = (await runFor(engineer)).rows.map((r) => r.id)
      expect(ids).toContain(programPartId)
      expect(ids).toContain(libraryPartId)
    })

    it('returns every program’s parts to Administrator', async () => {
      const ids = (await runFor(sysAdmin)).rows.map((r) => r.id)
      expect(ids).toContain(programPartId)
    })

    it('bounds totalRows, not just the page that came back', async () => {
      // The count is its own disclosure: an outsider must not learn how much
      // work a program holds by reading the total off a page they cannot see.
      // Stated as a relation rather than a literal, because this suite runs
      // against a database that may already hold parts of its own — what has
      // to hold is that the total agrees with the page, and that membership
      // adds exactly the one program part.
      const outside = await runFor(outsider)
      const inside = await runFor(engineer)

      expect(outside.totalRows).toBe(outside.rows.length)
      expect(inside.totalRows).toBe(inside.rows.length)
      expect(inside.totalRows).toBe(outside.totalRows + 1)
    })

    it('bounds the CSV export the same way', async () => {
      const res = await as(outsider).post(
        `/api/v1/reports/${reportId}/export`,
        {},
      )
      expect(res.status).toBe(200)
      const csv = await res.text()
      expect(csv).not.toContain(programPartId)
      expect(csv).toContain(libraryPartId)
    })
  })

  // ==========================================================================
  // Report definitions
  //
  // The other half of the report question. Scoping settles whose *rows* come
  // back; this settles who may open, rewrite, or destroy the saved query
  // itself. `reports:read` / `:update` / `:delete` are type-level verbs — they
  // say the caller may work with reports, not that they may work with *this*
  // one, which is the row's own createdBy / isPublic / sharedWith rule.
  // ==========================================================================

  describe('report definition access', () => {
    // Identical RBAC over reports, so the only thing separating these two is
    // which of them created the row.
    let reportOwner: TestUser
    let reportEditor: TestUser
    let privateReportId: string

    const mkReport = async (
      name: string,
      sharing: {
        isPublic?: boolean
        sharedWithRoles?: Array<string>
        sharedWithUsers?: Array<string>
      } = {},
    ) => {
      const report = await ReportService.create(
        {
          name,
          itemType: 'Part',
          isPublic: sharing.isPublic ?? false,
          sharedWithRoles: sharing.sharedWithRoles ?? null,
          sharedWithUsers: sharing.sharedWithUsers ?? null,
          columns: [
            { fieldPath: 'id', label: 'ID', displayOrder: 0, isVisible: true },
          ],
          filters: [],
          sorts: [],
        },
        reportOwner.id,
      )
      return report.id!
    }

    beforeEach(async () => {
      reportOwner = (await insertTestUserWithRole(testDb.db, 'Power User')).user
      reportEditor = (await insertTestUserWithRole(testDb.db, 'Power User'))
        .user
      for (const u of [reportOwner, reportEditor]) {
        const { sessionToken } = await SessionManager.createSession(u.id)
        cookies.set(u.id, `session=${sessionToken}`)
      }

      privateReportId = await mkReport('Private Report')
    })

    it('hides a private report from someone it was never shared with', async () => {
      // 404 rather than 403: a 403 would confirm the report exists, which is
      // all an ID probe needs to enumerate other people's saved queries.
      const res = await as(outsider).get(`/api/v1/reports/${privateReportId}`)
      expect(res.status).toBe(404)
    })

    it('shows it to the person who created it', async () => {
      const res = await as(reportOwner).get(
        `/api/v1/reports/${privateReportId}`,
      )
      expect(res.status).toBe(200)
    })

    it('refuses to run a report the caller cannot open', async () => {
      const res = await as(outsider).post(
        `/api/v1/reports/${privateReportId}/execute`,
        {},
      )
      expect(res.status).toBe(404)
    })

    it('refuses to export one', async () => {
      const res = await as(outsider).post(
        `/api/v1/reports/${privateReportId}/export`,
        {},
      )
      expect(res.status).toBe(404)
    })

    it('leaves a public report readable by anyone holding reports:read', async () => {
      const id = await mkReport('Public Report', { isPublic: true })
      expect((await as(outsider).get(`/api/v1/reports/${id}`)).status).toBe(200)
    })

    it('honors sharing with a role', async () => {
      // The arm that was dead while every route passed `[]` for the caller's
      // roles: sharing with a role used to share with nobody.
      const id = await mkReport('Approver Report', {
        sharedWithRoles: ['Approver'],
      })
      expect(
        (await as(approverOutsider).get(`/api/v1/reports/${id}`)).status,
      ).toBe(200)
      expect((await as(outsider).get(`/api/v1/reports/${id}`)).status).toBe(404)
    })

    it('surfaces a role-shared report in the list as well', async () => {
      const id = await mkReport('Approver List Report', {
        sharedWithRoles: ['Approver'],
      })
      const res = await as(approverOutsider).get('/api/v1/reports?limit=200')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { reports: Array<{ id: string }> }
      }
      expect(body.data.reports.map((r) => r.id)).toContain(id)
    })

    it('honors sharing with a named user, and only that user', async () => {
      const id = await mkReport('Named Report', {
        sharedWithUsers: [outsider.id],
      })
      expect((await as(outsider).get(`/api/v1/reports/${id}`)).status).toBe(200)
      expect((await as(viewer).get(`/api/v1/reports/${id}`)).status).toBe(404)
    })

    it('will not let a non-owner edit a report they can see', async () => {
      const id = await mkReport('Public Report', { isPublic: true })
      const res = await as(reportEditor).put(`/api/v1/reports/${id}`, {
        name: 'Hijacked',
        columns: [
          { fieldPath: 'id', label: 'ID', displayOrder: 0, isVisible: true },
        ],
      })
      expect(res.status).toBe(403)
    })

    it('will not let a non-owner delete a report they can see', async () => {
      const id = await mkReport('Public Report', { isPublic: true })
      expect((await as(reportEditor).del(`/api/v1/reports/${id}`)).status).toBe(
        403,
      )
    })

    it('lets the creator edit and delete their own', async () => {
      const edit = await as(reportOwner).put(
        `/api/v1/reports/${privateReportId}`,
        {
          name: 'Renamed',
          columns: [
            { fieldPath: 'id', label: 'ID', displayOrder: 0, isVisible: true },
          ],
        },
      )
      expect(edit.status).toBe(200)

      const removed = await as(reportOwner).del(
        `/api/v1/reports/${privateReportId}`,
      )
      expect(removed.status).toBe(200)
    })

    it('lets an administrator clean up a report never shared with them', async () => {
      // The one deliberate asymmetry: `system:manage` reaches past the sharing
      // rule on write, so a departed author's report is still removable.
      const res = await as(sysAdmin).del(`/api/v1/reports/${privateReportId}`)
      expect(res.status).toBe(200)
    })
  })
})
