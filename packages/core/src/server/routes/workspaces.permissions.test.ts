// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Workspaces route authorization — security-gate tests
 *
 * The items listing historically had no access check at all: any
 * authenticated user could enumerate any workspace's contents across
 * programs. These tests pin the fixed invariants:
 *
 *  - reads (detail, items) require access to the workspace's design
 *  - mutations (delete, remove item, convert) require ownership — even an
 *    Administrator with design access cannot mutate someone else's workspace
 *  - non-workspace branches are not reachable through this API
 *  - creation validates its payload and the caller's design access
 *
 * Run: npx vitest run src/server/routes/workspaces.permissions.test.ts
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
import workspacesRoutes from './workspaces'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  insertTestUser,
  insertTestUserWithRole,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { programMembers, programs } from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('workspaces routes — authorization gates', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/workspaces', workspacesRoutes)

  let owner: TestUser
  let member: TestUser
  let outsider: TestUser
  let adminIntruder: TestUser
  let designId: string
  let workspaceId: string
  let ownerCookie: string
  let memberCookie: string
  let outsiderCookie: string
  let adminIntruderCookie: string

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
    permissionService.clearCache()

    // Owner holds the RBAC grants convert-to-eco checks; the intruder holds
    // them too, so their failures prove ownership, not a missing grant
    owner = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    adminIntruder = (await insertTestUserWithRole(testDb.db, 'Administrator'))
      .user
    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Workspace Perm Program',
          code: `PROG-WSP-${Date.now()}`,
          createdBy: owner.id,
        })
        .returning(),
    )
    // Owner and member belong to the program; outsider does not
    await testDb.db.insert(programMembers).values(
      [owner, member].map((u) => ({
        programId: program.id,
        userId: u.id,
        role: 'engineer',
      })),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Workspace Perm Design',
        code: `DESIGN-WSP-${Date.now()}`,
        designType: 'Engineering',
      },
      owner.id,
    )
    designId = design.id

    const workspace = await BranchService.createWorkspaceBranch(
      designId,
      owner.id,
      'perm-test',
    )
    workspaceId = workspace.id

    ownerCookie = `session=${(await SessionManager.createSession(owner.id)).sessionToken}`
    memberCookie = `session=${(await SessionManager.createSession(member.id)).sessionToken}`
    outsiderCookie = `session=${(await SessionManager.createSession(outsider.id)).sessionToken}`
    adminIntruderCookie = `session=${(await SessionManager.createSession(adminIntruder.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function get(path: string, cookie: string) {
    return app.request(path, { headers: { Cookie: cookie } })
  }

  function del(path: string, cookie: string) {
    return app.request(path, { method: 'DELETE', headers: { Cookie: cookie } })
  }

  function post(path: string, cookie: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
  }

  async function draftPartOnWorkspace() {
    const { item } = await ItemService.createOnBranch(
      'Part',
      {
        itemNumber: `PN-WSP-${Date.now()}`,
        revision: 'A',
        name: 'Workspace Draft',
        state: 'Draft',
        designId,
        partType: 'Manufacture',
      } as never,
      workspaceId,
      'Drafted on workspace',
      owner.id,
    )
    return item
  }

  describe('reads require design access', () => {
    it('denies workspace detail to a user outside the program', async () => {
      const res = await get(`/api/v1/workspaces/${workspaceId}`, outsiderCookie)
      expect(res.status).toBe(403)
    })

    it('denies the items listing to a user outside the program', async () => {
      const res = await get(
        `/api/v1/workspaces/${workspaceId}/items`,
        outsiderCookie,
      )
      expect(res.status).toBe(403)
    })

    it('serves detail with design info to a program member', async () => {
      const res = await get(`/api/v1/workspaces/${workspaceId}`, memberCookie)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.designName).toBe('Workspace Perm Design')
      expect(body.data.itemCount).toBe(0)
      expect(body.data.workspaceOnlyItemCount).toBe(0)
    })

    it('does not serve non-workspace branches', async () => {
      const mainBranch = await BranchService.getMainBranch(designId)
      const res = await get(`/api/v1/workspaces/${mainBranch!.id}`, ownerCookie)
      expect(res.status).toBe(404)
    })
  })

  describe('mutations require ownership', () => {
    it('denies deletion to a program member who is not the owner', async () => {
      const res = await del(`/api/v1/workspaces/${workspaceId}`, memberCookie)
      expect(res.status).toBe(403)

      const branch = await BranchService.getById(workspaceId)
      expect(branch?.isArchived).toBe(false)
    })

    it('denies item removal to a non-owner', async () => {
      const item = await draftPartOnWorkspace()
      const res = await del(
        `/api/v1/workspaces/${workspaceId}/items/${item.masterId}`,
        memberCookie,
      )
      expect(res.status).toBe(403)

      const survivor = await ItemService.findById(item.id!)
      expect(survivor).not.toBeNull()
    })

    it('denies convert-to-eco to an Administrator who does not own the workspace', async () => {
      await draftPartOnWorkspace()
      const res = await post(
        `/api/v1/workspaces/${workspaceId}/convert-to-eco`,
        adminIntruderCookie,
        { ecoTitle: 'Not yours' },
      )
      expect(res.status).toBe(403)
    })

    it('lets the owner delete, archiving the branch', async () => {
      const res = await del(`/api/v1/workspaces/${workspaceId}`, ownerCookie)
      expect(res.status).toBe(200)

      const branch = await BranchService.getById(workspaceId)
      expect(branch?.isArchived).toBe(true)
    })

    it('converts for the owner, carrying the draft into the new ECO', async () => {
      const item = await draftPartOnWorkspace()
      const res = await post(
        `/api/v1/workspaces/${workspaceId}/convert-to-eco`,
        ownerCookie,
        { ecoTitle: 'Owner conversion', deleteWorkspace: true },
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.data.itemsConverted).toBe(1)
      expect(body.data.workspaceDeleted).toBe(true)

      // The draft survived the workspace deletion — it now belongs to the ECO
      const survivor = await ItemService.findById(item.id!)
      expect(survivor).not.toBeNull()
    })
  })

  describe('creation', () => {
    it('rejects a payload without a name', async () => {
      const res = await post('/api/v1/workspaces', ownerCookie, { designId })
      expect(res.status).toBe(400)
    })

    it('denies creation on a design the caller cannot access', async () => {
      const res = await post('/api/v1/workspaces', outsiderCookie, {
        designId,
        workspaceName: 'intruder-ws',
      })
      expect(res.status).toBe(403)
    })
  })
})
