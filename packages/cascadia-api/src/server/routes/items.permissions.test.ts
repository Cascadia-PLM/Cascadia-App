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
 *  - stealing another user's lock (force) requires system:manage, and so
 *    does breaking one — otherwise a forced unlock followed by a plain lock
 *    reaches the same end state without the key
 *  - type-scoped reads require read permission on that type; the
 *    autocomplete path returns nothing for a user with no read grants
 *  - the thumbnail route charges the item's own resource, not a fixed
 *    parts:read, so a Document's thumbnail is gated on documents:read
 *  - and so do the eight other item-detail reads, which charged nothing at
 *    all until now
 *
 * Run: npx vitest run src/server/routes/items.permissions.test.ts
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
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Document } from '@/lib/items/types/document'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
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
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('items routes — authorization gates', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)

  let admin: TestUser
  let viewer: TestUser
  let noRole: TestUser
  let partsOnly: TestUser
  let docsOnly: TestUser
  let partsWriter: TestUser
  let partsOnlyCookie: string
  let docsOnlyCookie: string
  let partsWriterCookie: string
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

    // Two users whose grants differ only in which item type they may read —
    // the axis the thumbnail route is meant to dispatch on. Neither holds
    // programs:manage; the cross-program bypass would mask the tuple.
    const suffix = randomUUID().slice(0, 8)
    const partsOnlyRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Parts Only ${suffix}`, { parts: ['read'] }),
    )
    const docsOnlyRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Docs Only ${suffix}`, { documents: ['read'] }),
    )
    // May edit a part, may not administer one. The lock-override test needs
    // exactly this shape: /:id/lock now charges parts:update as well, so an
    // actor lacking it would answer 403 from the tuple and stop measuring
    // whether stealing a lock still requires system:manage.
    const partsWriterRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Parts Writer ${suffix}`, {
        parts: ['read', 'update'],
      }),
    )
    partsOnly = await insertTestUser(testDb.db)
    docsOnly = await insertTestUser(testDb.db)
    partsWriter = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, partsOnly.id, partsOnlyRole.id)
    await assignRoleToUser(testDb.db, docsOnly.id, docsOnlyRole.id)
    await assignRoleToUser(testDb.db, partsWriter.id, partsWriterRole.id)
    permissionService.clearCache()

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
      [admin, viewer, noRole, partsOnly, docsOnly, partsWriter].map((u) => ({
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
    partsOnlyCookie = `session=${(await SessionManager.createSession(partsOnly.id)).sessionToken}`
    docsOnlyCookie = `session=${(await SessionManager.createSession(docsOnly.id)).sessionToken}`
    partsWriterCookie = `session=${(await SessionManager.createSession(partsWriter.id)).sessionToken}`
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

  async function refusalCode(response: Response): Promise<string | null> {
    if (response.status !== 403) return null
    const payload = (await response.json()) as ErrorEnvelope
    return payload.error.code
  }

  async function lockedBy(id: string): Promise<string | null | undefined> {
    const after = await ItemService.findById(id)
    return (after as { lockedBy?: string | null } | null)?.lockedBy
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

  describe('update body validation', () => {
    it('rejects a type-invalid field on PUT with 400 and a field error', async () => {
      const part = await createPart('Validated Part')

      const res = await app.request(`/api/v1/items/${part.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ leadTimeDays: 'soon' }),
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as {
        error: { fieldErrors?: Array<{ field: string }> }
      }
      expect(json.error.fieldErrors?.map((f) => f.field)).toContain(
        'leadTimeDays',
      )
      // Validation fired before any write.
      const untouched = await ItemService.findById(part.id)
      expect(untouched?.name).toBe('Validated Part')
    })
  })

  describe('lock override', () => {
    it("only system:manage may steal another user's lock", async () => {
      const part = await createPart('Contested')

      // Admin takes the lock first
      const lock = await post(`/api/v1/items/${part.id}/lock`, adminCookie, {})
      expect(lock.status).toBe(200)

      // A member who may edit the part, but does not hold system:manage,
      // still cannot force it away. The actor has to hold parts:update or the
      // 403 would arrive from the route's own tuple and this would stop
      // measuring the override rule.
      const steal = await post(
        `/api/v1/items/${part.id}/lock`,
        partsWriterCookie,
        { force: true },
      )
      expect(steal.status).toBe(403)

      const after = await ItemService.findById(part.id)
      expect((after as { lockedBy?: string }).lockedBy).toBe(admin.id)
    })

    it("only system:manage may break another user's lock", async () => {
      const part = await createPart('Contested Unlock')

      const lock = await post(`/api/v1/items/${part.id}/lock`, adminCookie, {})
      expect(lock.status).toBe(200)

      const evict = await post(
        `/api/v1/items/${part.id}/unlock`,
        partsWriterCookie,
        { force: true },
      )
      expect(evict.status).toBe(403)
      expect(await refusalCode(evict)).toBe(ErrorCode.PERMISSION_DENIED)

      // The status and the code are both ambiguous on this route: the
      // ownership refusal this actor would hit without `force` is also
      // 403/PERMISSION_DENIED. The lock still belonging to its holder is
      // what makes the refusal mean something.
      expect(await lockedBy(part.id)).toBe(admin.id)
    })

    it('admits system:manage to a forced unlock', async () => {
      // Without this leg the refusal above would pass just as well against a
      // charge nothing can satisfy.
      const part = await createPart('Evictable')

      const lock = await post(
        `/api/v1/items/${part.id}/lock`,
        partsWriterCookie,
        {},
      )
      expect(lock.status).toBe(200)
      expect(await lockedBy(part.id)).toBe(partsWriter.id)

      const evict = await post(`/api/v1/items/${part.id}/unlock`, adminCookie, {
        force: true,
      })
      expect(evict.status).toBe(200)
      expect(await lockedBy(part.id)).toBeNull()
    })

    it('leaves a caller releasing its own lock unaffected, force or not', async () => {
      // The override is charged on eviction only; releasing a lock you hold
      // must stay free even when the caller redundantly sends force.
      const part = await createPart('Self Held')

      for (const body of [{}, { force: true }]) {
        const lock = await post(
          `/api/v1/items/${part.id}/lock`,
          partsWriterCookie,
          {},
        )
        expect(lock.status).toBe(200)

        const release = await post(
          `/api/v1/items/${part.id}/unlock`,
          partsWriterCookie,
          body,
        )
        expect(release.status).toBe(200)
        expect(await lockedBy(part.id)).toBeNull()
      }
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

    it('thumbnail dispatches on the item type, not always parts', async () => {
      // No thumbnail is designated for either item, so the pass condition is
      // "not 403": a 404 means the gate admitted the caller and the resolver
      // found nothing, which is the whole claim here. Charging a fixed
      // parts:read made a documents-only reader 403 on a Document and let a
      // parts-only reader through to one.
      const part = await createPart('Thumbnailed Part')
      const doc = await ItemService.create<Document>(
        'Document',
        {
          itemType: 'Document',
          designId,
          revision: 'A',
          name: 'Thumbnailed Document',
        },
        admin.id,
      )
      if (!doc.id) throw new Error('document id missing')

      const get = (id: string, cookie: string) =>
        app.request(`/api/v1/items/${id}/thumbnail`, {
          headers: { Cookie: cookie },
        })

      expect((await get(doc.id, docsOnlyCookie)).status).not.toBe(403)
      expect((await get(doc.id, partsOnlyCookie)).status).toBe(403)

      expect((await get(part.id, partsOnlyCookie)).status).not.toBe(403)
      expect((await get(part.id, docsOnlyCookie)).status).toBe(403)
    })

    it('the eight item-detail reads dispatch on the item type too', async () => {
      // The same claim as the thumbnail test, over the rest of the file:
      // /items/:id/* serves all 13 types, so the tuple has to be charged on
      // the row rather than fixed at parts:read. partsOnly and docsOnly
      // differ ONLY in which item resource holds `read`, and the pair of
      // mirrored refusals is what distinguishes a dispatch from a hardcoded
      // resource.
      //
      // Plain status is sound here where the write suite needed refusalCode():
      // that suite's confound was branch protection answering
      // 403/BRANCH_PROTECTED from below the tuple, and no read path in
      // items/detail.ts reaches branch protection. Membership — the other 403
      // source — is held constant, every user in this suite being a program
      // member. So a 403 on these eight can come from nothing but the tuple.
      //
      // Admitted legs assert `.not.toBe(403)`, not an exact success code:
      // pinning one would pin service behaviour this suite is not about.
      const part = await createPart('Tupled Part')
      const doc = await ItemService.create<Document>(
        'Document',
        {
          itemType: 'Document',
          designId,
          revision: 'A',
          name: 'Tupled Document',
        },
        admin.id,
      )
      if (!doc.id) throw new Error('document id missing')

      const routes = [
        'at-context',
        'available-contexts',
        'history',
        'impact-analysis',
        'lock-status',
        'relationships',
        'satisfied-requirements',
        'where-used',
      ]

      const send = (id: string, route: string, cookie: string) =>
        route === 'impact-analysis'
          ? // A POST with a required body. `apiHandler` parses `body:` before
            // the handler runs, so an absent or invalid one answers 400 and
            // the refusal leg would pass vacuously.
            post(`/api/v1/items/${id}/impact-analysis`, cookie, {
              changeType: 'revision',
              direction: 'both',
            })
          : app.request(`/api/v1/items/${id}/${route}`, {
              headers: { Cookie: cookie },
            })

      for (const route of routes) {
        expect(
          (await send(part.id, route, partsOnlyCookie)).status,
          `${route} — part / parts-only reader`,
        ).not.toBe(403)
        expect(
          (await send(part.id, route, docsOnlyCookie)).status,
          `${route} — part / docs-only reader`,
        ).toBe(403)

        expect(
          (await send(doc.id, route, docsOnlyCookie)).status,
          `${route} — document / docs-only reader`,
        ).not.toBe(403)
        expect(
          (await send(doc.id, route, partsOnlyCookie)).status,
          `${route} — document / parts-only reader`,
        ).toBe(403)
      }
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
