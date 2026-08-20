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
 *  - running a saved report is bounded the same way: who may open a report
 *    definition is a separate question from whose rows it may return
 *  - and that separate question is enforced too: the by-ID report routes honor
 *    the row's own sharing rule, and editing or deleting one needs ownership
 *    rather than merely the RBAC verb
 *
 * Run: npx vitest run packages/core/src/server/routes/program-isolation.permissions.test.ts
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
import designsRoutes from './designs'
import changeOrdersRoutes from './change-orders'
import dashboardRoutes from './dashboard'
import workOrdersRoutes from './work-orders'
import reportsRoutes from './reports'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { ReportService } from '@/lib/reports/ReportService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'

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
