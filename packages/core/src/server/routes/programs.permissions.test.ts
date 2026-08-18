// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Programs & program-membership routes — the role × membership matrix
 *
 * Programs are the permission boundary of the whole system, and membership
 * management is how that boundary is drawn, so every route here is a
 * security gate. These tests exercise the full matrix of callers against
 * every endpoint:
 *
 *   RBAC personas: Administrator (the top-level role, NOT a member) and
 *                  plain User (the baseline for all program personas)
 *   Program personas (all plain User RBAC): admin, lead, engineer, viewer,
 *                  and an outsider with no membership at all
 *
 * Invariants pinned:
 *  - detail/members reads require membership, the cross-program bypass
 *    (programs:manage — the Administrator role), or the programs:update
 *    fallback — RBAC programs:read alone is NOT enough, every built-in role
 *    has it
 *  - member add: program admin or lead (leads cannot grant 'admin'), with
 *    programs:manage as the only RBAC fallback
 *  - member update/remove: program admin only, same manage fallback
 *  - member payloads are strict: unknown keys (mass assignment of
 *    userId/programId/joinedAt) and invalid roles are rejected, and a
 *    rejected request changes nothing
 *  - a program can never lose its last admin — by removal OR demotion
 *  - a role change re-baselines the flag columns to the new role's defaults
 *
 * Run: npx vitest run packages/core/src/server/routes/programs.permissions.test.ts
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
import programsRoutes from './programs'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'

describe('programs routes — role × membership matrix', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/programs', programsRoutes)

  let sysAdmin: TestUser
  let progAdmin: TestUser
  let progLead: TestUser
  let progEngineer: TestUser
  let progViewer: TestUser
  let outsider: TestUser

  let programId: string

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
    progLead = (await insertTestUserWithRole(testDb.db, 'User')).user
    progEngineer = (await insertTestUserWithRole(testDb.db, 'User')).user
    progViewer = (await insertTestUserWithRole(testDb.db, 'User')).user
    outsider = (await insertTestUserWithRole(testDb.db, 'User')).user

    // progAdmin creates the program (auto-added as program admin)
    const program = await ProgramService.create(
      {
        name: 'Matrix Program',
        code: `MTRX-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      },
      progAdmin.id,
    )
    programId = program.id

    await ProgramService.addMember(programId, progLead.id, 'lead', progAdmin.id)
    await ProgramService.addMember(
      programId,
      progEngineer.id,
      'engineer',
      progAdmin.id,
    )
    await ProgramService.addMember(
      programId,
      progViewer.id,
      'viewer',
      progAdmin.id,
    )

    cookies.clear()
    for (const u of [
      sysAdmin,
      progAdmin,
      progLead,
      progEngineer,
      progViewer,
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
      send: (method: string, path: string, body?: unknown) =>
        app.request(path, {
          method,
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    }
  }

  async function json<T = any>(res: Response): Promise<T> {
    return (await res.json()) as T
  }

  // ==========================================================================
  // Program CRUD
  // ==========================================================================

  describe('GET /api/v1/programs (list scoping)', () => {
    it('scopes the list to membership; Administrator sees everything', async () => {
      for (const [user, shouldSee] of [
        [progViewer, true],
        [outsider, false],
        [sysAdmin, true],
      ] as const) {
        const res = await as(user).get('/api/v1/programs')
        expect(res.status).toBe(200)
        const body = await json(res)
        const ids = body.data.programs.map((p: { id: string }) => p.id)
        expect(ids.includes(programId)).toBe(shouldSee)
      }
    })
  })

  describe('POST /api/v1/programs', () => {
    it('only programs:create (Administrator) may create programs', async () => {
      const payload = (suffix: string) => ({
        name: 'New Program',
        code: `NEWP-${Date.now()}-${suffix}`,
      })

      expect(
        (await as(outsider).send('POST', '/api/v1/programs', payload('A')))
          .status,
      ).toBe(403)
      expect(
        (await as(progAdmin).send('POST', '/api/v1/programs', payload('B')))
          .status,
      ).toBe(403)

      const res = await as(sysAdmin).send(
        'POST',
        '/api/v1/programs',
        payload('C'),
      )
      expect(res.status).toBe(201)
      const body = await json(res)
      // Creator is auto-enrolled as the program's admin
      const member = await ProgramService.getMember(
        body.data.program.id,
        sysAdmin.id,
      )
      expect(member?.role).toBe('admin')
    })
  })

  describe('GET /api/v1/programs/:id (detail)', () => {
    it('members of any program role can read the program', async () => {
      for (const user of [progAdmin, progLead, progEngineer, progViewer]) {
        const res = await as(user).get(`/api/v1/programs/${programId}`)
        expect(res.status).toBe(200)
      }
    })

    it('reports the caller-specific program role', async () => {
      const res = await as(progViewer).get(`/api/v1/programs/${programId}`)
      const body = await json(res)
      expect(body.data.program.userRole).toBe('viewer')
    })

    it('non-members are denied even though every role has programs:read', async () => {
      // This is the metadata-leak gate: customer / contract number must not
      // be readable by ID from outside the program.
      expect(
        (await as(outsider).get(`/api/v1/programs/${programId}`)).status,
      ).toBe(403)
    })

    it('Administrator reads across programs without membership', async () => {
      const res = await as(sysAdmin).get(`/api/v1/programs/${programId}`)
      expect(res.status).toBe(200)
      // Not a member, so no program role comes back
      expect((await json(res)).data.program.userRole).toBeNull()
    })
  })

  describe('GET /api/v1/programs/:id/graph', () => {
    it('applies the same membership gate as the detail route', async () => {
      expect(
        (await as(progViewer).get(`/api/v1/programs/${programId}/graph`))
          .status,
      ).toBe(200)
      expect(
        (await as(outsider).get(`/api/v1/programs/${programId}/graph`)).status,
      ).toBe(403)
      expect(
        (await as(sysAdmin).get(`/api/v1/programs/${programId}/graph`)).status,
      ).toBe(200)
    })
  })

  describe('PUT /api/v1/programs/:id', () => {
    const update = { name: 'Renamed Program' }

    it('program admin can update', async () => {
      const res = await as(progAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}`,
        update,
      )
      expect(res.status).toBe(200)
      expect((await json(res)).data.program.name).toBe('Renamed Program')
    })

    it('non-admin members and outsiders without programs:update cannot', async () => {
      for (const user of [progLead, progEngineer, progViewer, outsider]) {
        const res = await as(user).send(
          'PUT',
          `/api/v1/programs/${programId}`,
          update,
        )
        expect(res.status).toBe(403)
      }
      const after = await ProgramService.getById(programId)
      expect(after?.name).toBe('Matrix Program')
    })

    it('Administrator can update any program via RBAC', async () => {
      expect(
        (
          await as(sysAdmin).send('PUT', `/api/v1/programs/${programId}`, {
            name: 'Admin Rename',
          })
        ).status,
      ).toBe(200)
    })
  })

  describe('DELETE /api/v1/programs/:id', () => {
    it('program admin can delete', async () => {
      const res = await as(progAdmin).send(
        'DELETE',
        `/api/v1/programs/${programId}`,
      )
      expect(res.status).toBe(200)
      expect(await ProgramService.getById(programId)).toBeNull()
    })

    it('lead / outsider cannot delete', async () => {
      for (const user of [progLead, outsider]) {
        const res = await as(user).send(
          'DELETE',
          `/api/v1/programs/${programId}`,
        )
        expect(res.status).toBe(403)
      }
      expect(await ProgramService.getById(programId)).not.toBeNull()
    })

    it('Administrator can delete', async () => {
      const res = await as(sysAdmin).send(
        'DELETE',
        `/api/v1/programs/${programId}`,
      )
      expect(res.status).toBe(200)
      expect(await ProgramService.getById(programId)).toBeNull()
    })
  })

  // ==========================================================================
  // Membership: read
  // ==========================================================================

  describe('GET /api/v1/programs/:id/members', () => {
    it('every member — including viewers — can see the team', async () => {
      for (const user of [progAdmin, progLead, progEngineer, progViewer]) {
        const res = await as(user).get(`/api/v1/programs/${programId}/members`)
        expect(res.status).toBe(200)
        const body = await json(res)
        expect(body.data.members).toHaveLength(4)
      }
    })

    it('rows carry the joined user identity for display', async () => {
      const res = await as(progViewer).get(
        `/api/v1/programs/${programId}/members`,
      )
      const body = await json(res)
      const row = body.data.members.find(
        (m: { userId: string }) => m.userId === progEngineer.id,
      )
      expect(row.user).toMatchObject({
        id: progEngineer.id,
        email: progEngineer.email,
      })
    })

    it('non-members without an org-level grant cannot enumerate the team', async () => {
      expect(
        (await as(outsider).get(`/api/v1/programs/${programId}/members`))
          .status,
      ).toBe(403)
    })

    it('Administrator can see any team without being a member', async () => {
      const res = await as(sysAdmin).get(
        `/api/v1/programs/${programId}/members`,
      )
      expect(res.status).toBe(200)
      expect((await json(res)).data.members).toHaveLength(4)
    })
  })

  // ==========================================================================
  // Membership: add
  // ==========================================================================

  describe('POST /api/v1/programs/:id/members', () => {
    it('program admin adds a member; role defaults are applied', async () => {
      const res = await as(progAdmin).send(
        'POST',
        `/api/v1/programs/${programId}/members`,
        { userId: outsider.id, role: 'engineer' },
      )
      expect(res.status).toBe(201)
      const member = (await json(res)).data.member
      expect(member).toMatchObject({
        userId: outsider.id,
        role: 'engineer',
        canCreateEco: true,
        canApproveEco: false,
        canManageDesigns: false,
      })
    })

    it('lead can add non-admin members', async () => {
      const res = await as(progLead).send(
        'POST',
        `/api/v1/programs/${programId}/members`,
        { userId: outsider.id, role: 'viewer' },
      )
      expect(res.status).toBe(201)
    })

    it('lead cannot mint a program admin', async () => {
      const res = await as(progLead).send(
        'POST',
        `/api/v1/programs/${programId}/members`,
        { userId: outsider.id, role: 'admin' },
      )
      expect(res.status).toBe(403)
      expect(await ProgramService.getMember(programId, outsider.id)).toBeNull()
    })

    it('engineer, viewer, and outsider cannot add members', async () => {
      for (const user of [progEngineer, progViewer, outsider]) {
        const res = await as(user).send(
          'POST',
          `/api/v1/programs/${programId}/members`,
          { userId: outsider.id, role: 'viewer' },
        )
        expect(res.status).toBe(403)
      }
      expect(await ProgramService.getMember(programId, outsider.id)).toBeNull()
    })

    it('Administrator can add members (including admins) from outside', async () => {
      const res = await as(sysAdmin).send(
        'POST',
        `/api/v1/programs/${programId}/members`,
        { userId: outsider.id, role: 'admin' },
      )
      expect(res.status).toBe(201)
      expect((await json(res)).data.member.role).toBe('admin')
    })

    it('rejects unknown roles', async () => {
      const res = await as(progAdmin).send(
        'POST',
        `/api/v1/programs/${programId}/members`,
        { userId: outsider.id, role: 'superuser' },
      )
      expect(res.status).toBe(400)
      expect(await ProgramService.getMember(programId, outsider.id)).toBeNull()
    })

    it('rejects flag smuggling on the add payload', async () => {
      // The flags are derived from the role server-side; a caller must not
      // hand a viewer approval rights in the same breath.
      const res = await as(progAdmin).send(
        'POST',
        `/api/v1/programs/${programId}/members`,
        { userId: outsider.id, role: 'viewer', canApproveEco: true },
      )
      expect(res.status).toBe(400)
      expect(await ProgramService.getMember(programId, outsider.id)).toBeNull()
    })

    it('rejects a duplicate membership', async () => {
      const res = await as(progAdmin).send(
        'POST',
        `/api/v1/programs/${programId}/members`,
        { userId: progViewer.id, role: 'engineer' },
      )
      expect(res.status).toBe(400)
      // and the existing membership is untouched
      const member = await ProgramService.getMember(programId, progViewer.id)
      expect(member?.role).toBe('viewer')
    })
  })

  // ==========================================================================
  // Membership: update
  // ==========================================================================

  describe('PUT /api/v1/programs/:id/members/:userId', () => {
    it('program admin promotes a member; flags re-baseline to the new role', async () => {
      const res = await as(progAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}/members/${progViewer.id}`,
        { role: 'lead' },
      )
      expect(res.status).toBe(200)
      const member = (await json(res)).data.member
      // viewer had all flags off; lead defaults turn create/approve on
      expect(member).toMatchObject({
        role: 'lead',
        canCreateEco: true,
        canApproveEco: true,
        canManageDesigns: false,
      })
    })

    it('explicit flags in the same request win over the role defaults', async () => {
      const res = await as(progAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}/members/${progViewer.id}`,
        { role: 'lead', canApproveEco: false },
      )
      expect(res.status).toBe(200)
      const member = (await json(res)).data.member
      expect(member).toMatchObject({
        role: 'lead',
        canCreateEco: true,
        canApproveEco: false,
      })
    })

    it('flag-only updates leave the role alone', async () => {
      const res = await as(progAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}/members/${progEngineer.id}`,
        { canCreateEco: false },
      )
      expect(res.status).toBe(200)
      expect((await json(res)).data.member).toMatchObject({
        role: 'engineer',
        canCreateEco: false,
      })
    })

    it('lead / engineer / viewer / outsider cannot update members', async () => {
      for (const user of [progLead, progEngineer, progViewer, outsider]) {
        const res = await as(user).send(
          'PUT',
          `/api/v1/programs/${programId}/members/${progViewer.id}`,
          { role: 'lead' },
        )
        expect(res.status).toBe(403)
      }
      const member = await ProgramService.getMember(programId, progViewer.id)
      expect(member?.role).toBe('viewer')
    })

    it('rejects mass assignment of row-identity columns', async () => {
      // userId/programId/id/joinedAt in the body would re-point the
      // membership row itself; the strict schema must refuse them.
      const res = await as(progAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}/members/${progViewer.id}`,
        { role: 'admin', userId: outsider.id },
      )
      expect(res.status).toBe(400)
      // nothing moved: viewer unchanged, outsider still not a member
      expect(
        (await ProgramService.getMember(programId, progViewer.id))?.role,
      ).toBe('viewer')
      expect(await ProgramService.getMember(programId, outsider.id)).toBeNull()
    })

    it('rejects unknown role values', async () => {
      const res = await as(progAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}/members/${progViewer.id}`,
        { role: 'owner' },
      )
      expect(res.status).toBe(400)
    })

    it('cannot demote the last admin — not even an Administrator can', async () => {
      const res = await as(sysAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}/members/${progAdmin.id}`,
        { role: 'viewer' },
      )
      expect(res.status).toBe(400)
      expect(
        (await ProgramService.getMember(programId, progAdmin.id))?.role,
      ).toBe('admin')
    })

    it('demotion is allowed once another admin exists', async () => {
      await ProgramService.addMember(
        programId,
        outsider.id,
        'admin',
        sysAdmin.id,
      )
      const res = await as(progAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}/members/${progAdmin.id}`,
        { role: 'engineer' },
      )
      expect(res.status).toBe(200)
    })

    it('Administrator can update members from outside the program', async () => {
      const res = await as(sysAdmin).send(
        'PUT',
        `/api/v1/programs/${programId}/members/${progEngineer.id}`,
        { canApproveEco: true },
      )
      expect(res.status).toBe(200)
    })
  })

  // ==========================================================================
  // Membership: remove
  // ==========================================================================

  describe('DELETE /api/v1/programs/:id/members/:userId', () => {
    it('program admin removes a member', async () => {
      const res = await as(progAdmin).send(
        'DELETE',
        `/api/v1/programs/${programId}/members/${progEngineer.id}`,
      )
      expect(res.status).toBe(200)
      expect(
        await ProgramService.getMember(programId, progEngineer.id),
      ).toBeNull()
    })

    it('cannot remove the last admin', async () => {
      const res = await as(progAdmin).send(
        'DELETE',
        `/api/v1/programs/${programId}/members/${progAdmin.id}`,
      )
      expect(res.status).toBe(400)
      expect(
        await ProgramService.getMember(programId, progAdmin.id),
      ).not.toBeNull()
    })

    it('lead and members cannot remove; membership is intact after denial', async () => {
      for (const user of [progLead, progEngineer, progViewer, outsider]) {
        const res = await as(user).send(
          'DELETE',
          `/api/v1/programs/${programId}/members/${progViewer.id}`,
        )
        expect(res.status).toBe(403)
      }
      expect(
        await ProgramService.getMember(programId, progViewer.id),
      ).not.toBeNull()
    })

    it('a member cannot remove themselves (no self-service leave)', async () => {
      const res = await as(progEngineer).send(
        'DELETE',
        `/api/v1/programs/${programId}/members/${progEngineer.id}`,
      )
      expect(res.status).toBe(403)
    })

    it('Administrator can remove members from outside the program', async () => {
      const res = await as(sysAdmin).send(
        'DELETE',
        `/api/v1/programs/${programId}/members/${progViewer.id}`,
      )
      expect(res.status).toBe(200)
      expect(
        await ProgramService.getMember(programId, progViewer.id),
      ).toBeNull()
    })
  })
})
