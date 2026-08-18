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
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
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

  function ecoPayload(name: string) {
    // The route auto-starts a workflow for a changeType, but an absent
    // workflow definition is caught and logged — the invariant under test
    // is the program gate, not workflow config.
    return {
      itemType: 'ChangeOrder',
      designId,
      revision: 'A',
      changeType: 'ECO',
      name,
      description: 'isolation test ECO',
    }
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
        '/api/v1/items',
        ecoPayload('Engineer ECO'),
      )
      expect(res.status).toBe(201)
    })

    it('viewer (flag off) cannot create an ECO', async () => {
      const res = await as(viewer).post(
        '/api/v1/items',
        ecoPayload('Viewer ECO'),
      )
      expect(res.status).toBe(403)
    })

    it('the flag is honored when explicitly revoked from an engineer', async () => {
      await ProgramService.updateMember(programId, engineer.id, {
        canCreateEco: false,
      })
      const res = await as(engineer).post(
        '/api/v1/items',
        ecoPayload('Revoked ECO'),
      )
      expect(res.status).toBe(403)
    })

    it('Administrator creates ECOs without a membership row', async () => {
      const res = await as(sysAdmin).post(
        '/api/v1/items',
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
      const eco = (await ItemService.create(
        'ChangeOrder',
        {
          designId,
          revision: 'A',
          changeType: 'ECO',
          name: 'Vote Target',
        } as never,
        progAdmin.id,
      )) as { id: string }
      ecoId = eco.id
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

    beforeEach(async () => {
      const eco = (await ItemService.create(
        'ChangeOrder',
        {
          designId,
          revision: 'A',
          changeType: 'ECO',
          name: 'Scoped ECO',
        } as never,
        progAdmin.id,
      )) as { id: string }
      ecoId = eco.id
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
    // carries the caller's accessible designs as its own bound. ECOs with no
    // design link stay visible to everyone — they sit outside every program,
    // so there is no boundary to place them on.
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
})
