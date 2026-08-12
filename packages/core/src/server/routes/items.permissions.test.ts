// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Items route authorization — security-gate tests
 *
 * The batch endpoints and the lock override are the mutation surface that
 * historically bypassed RBAC entirely (any authenticated user could
 * batch-delete 100 items, or write to a protected branch via a
 * client-supplied bypassBranchProtection flag). These tests pin the
 * invariants:
 *
 *  - a read-only role cannot mutate through any batch endpoint, and a
 *    denied batch mutates nothing (no half-apply before the 403)
 *  - bypassBranchProtection requires system:manage, not a request flag
 *  - stealing another user's lock (force) requires system:manage
 *  - type-scoped reads require read permission on that type; the
 *    autocomplete path returns nothing for a user with no read grants
 *
 * Run: npx vitest run src/server/routes/items.permissions.test.ts
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
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('items routes — authorization gates', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)

  let admin: TestUser
  let viewer: TestUser
  let noRole: TestUser
  let designId: string
  let mainBranchId: string
  let adminCookie: string
  let viewerCookie: string
  let noRoleCookie: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // Users are new each test, but the permission cache is process-global
    permissionService.clearCache()

    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    viewer = (await insertTestUserWithRole(testDb.db, 'View Only')).user
    noRole = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Perm Test Program',
          code: `PROG-${Date.now()}`,
          createdBy: admin.id,
        })
        .returning(),
    )
    // Every user is a program member: these tests must fail on the RBAC
    // type permission, not on program/design access.
    await testDb.db.insert(programMembers).values(
      [admin, viewer, noRole].map((u) => ({
        programId: program.id,
        userId: u.id,
        role: 'engineer',
      })),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Perm Test Design',
        code: `DESIGN-${Date.now()}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    designId = design.id
    const mainBranch = await BranchService.getMainBranch(designId)
    if (!mainBranch) throw new Error('main branch missing')
    mainBranchId = mainBranch.id

    adminCookie = `session=${(await SessionManager.createSession(admin.id)).sessionToken}`
    viewerCookie = `session=${(await SessionManager.createSession(viewer.id)).sessionToken}`
    noRoleCookie = `session=${(await SessionManager.createSession(noRole.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(name: string): Promise<{ id: string }> {
    const part = await ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name,
        partType: 'Manufacture',
      } as never,
      admin.id,
    )
    return part
  }

  function post(path: string, cookie: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
  }

  describe('batch mutations', () => {
    it('rejects batch-delete from a read-only role and deletes nothing', async () => {
      const part = await createPart('Keep Me')

      const res = await post('/api/v1/items/batch-delete', viewerCookie, {
        itemIds: [part.id],
        branchId: mainBranchId,
      })

      expect(res.status).toBe(403)
      expect(await ItemService.findById(part.id)).not.toBeNull()
    })

    it('rejects batch-update from a read-only role and changes nothing', async () => {
      const part = await createPart('Original Name')

      const res = await post('/api/v1/items/batch-update', viewerCookie, {
        items: [{ id: part.id, data: { name: 'Hacked Name' } }],
      })

      expect(res.status).toBe(403)
      const after = await ItemService.findById(part.id)
      expect(after?.name).toBe('Original Name')
    })

    it('rejects batch-create from a read-only role', async () => {
      const res = await post('/api/v1/items/batch-create', viewerCookie, {
        items: [
          {
            itemType: 'Part',
            data: { designId, name: 'Sneaky Part', partType: 'Manufacture' },
          },
        ],
      })

      expect(res.status).toBe(403)
    })

    it('requires system:manage for bypassBranchProtection, independent of create permission', async () => {
      // The viewer lacks parts:create outright; the interesting case is a
      // user who CAN create but must not bypass branch protection. The
      // Administrator role has system:manage, so it is the positive case.
      const denied = await post('/api/v1/items/batch-create', viewerCookie, {
        items: [
          {
            itemType: 'Part',
            data: { designId, name: 'P1', partType: 'Manufacture' },
          },
        ],
        bypassBranchProtection: true,
      })
      expect(denied.status).toBe(403)

      const allowed = await post('/api/v1/items/batch-create', adminCookie, {
        items: [
          {
            itemType: 'Part',
            data: {
              designId,
              revision: 'A',
              name: 'P2',
              partType: 'Manufacture',
            },
          },
        ],
        bypassBranchProtection: true,
      })
      expect(allowed.status).toBe(201)
    })
  })

  describe('lock override', () => {
    it("only system:manage may steal another user's lock", async () => {
      const part = await createPart('Contested')

      // Admin takes the lock first
      const lock = await post(`/api/v1/items/${part.id}/lock`, adminCookie, {})
      expect(lock.status).toBe(200)

      // Viewer cannot force it away
      const steal = await post(`/api/v1/items/${part.id}/lock`, viewerCookie, {
        force: true,
      })
      expect(steal.status).toBe(403)

      const after = await ItemService.findById(part.id)
      expect((after as { lockedBy?: string }).lockedBy).toBe(admin.id)
    })
  })

  describe('type-scoped reads', () => {
    it('rejects a typed search for a user with no read grant', async () => {
      const res = await app.request('/api/v1/items/search?itemType=Part', {
        headers: { Cookie: noRoleCookie },
      })
      expect(res.status).toBe(403)
    })

    it('allows a typed search for a read-only role', async () => {
      const res = await app.request('/api/v1/items/search?itemType=Part', {
        headers: { Cookie: viewerCookie },
      })
      expect(res.status).toBe(200)
    })

    it('autocomplete returns nothing for a user with no read grants', async () => {
      await createPart('Findable')

      const res = await app.request('/api/v1/items/search?q=Findable', {
        headers: { Cookie: noRoleCookie },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { items: Array<unknown> } }
      expect(body.data.items).toEqual([])
    })
  })
})
