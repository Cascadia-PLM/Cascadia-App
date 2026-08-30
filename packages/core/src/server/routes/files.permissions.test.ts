// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * File vault routes — program isolation
 *
 * Security gate. `documents:read` says a user may read documents; it says
 * nothing about *whose*. Only three of the vault's twenty by-id endpoints
 * checked design reach, so a file id was enough to download another program's
 * drawing, check it out, mark it up, recategorise it, or delete it.
 *
 * The collection route `GET /api/v1/files` had the same hole in the other
 * direction: it listed every file in the instance, so a caller did not even
 * need the id. Its block below asserts the listing draws exactly the boundary
 * the by-id routes draw.
 *
 * Both users here hold the same role — create, read, update and delete on
 * documents, and nothing else. The only difference between them is program
 * membership, so a 403 (or an absent row) can only come from the design gate.
 * The role used to carry `documents:manage` as well, which existed solely to
 * satisfy `POST /:fileId/force-unlock`'s old tuple; nothing charges that
 * action now, and keeping it made a reader think the route was covered.
 *
 * The final block covers what that grant was hiding: force-unlock is charged
 * `documents:update` plus `system:manage` on eviction, and no leg here had
 * ever asserted that a role can actually reach it.
 *
 * Run: npx vitest run packages/core/src/server/routes/files.permissions.test.ts
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
import { eq, inArray } from 'drizzle-orm'
import filesRoutes from './files'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { Tool } from '@/lib/items/types/tool'
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
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { items, vaultFiles } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

interface FileListEnvelope {
  data: {
    files: Array<{ id: string; itemId: string }>
    count: number
  }
}

interface BatchResult {
  data: {
    checkedOut: Array<{ fileId: string }>
    errors: Array<{ fileId: string; error: string }>
  }
}

describe('file vault routes — program isolation', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/files', filesRoutes)

  let member: TestUser
  let outsider: TestUser
  let ownFileId: string
  let ownDesignId: string
  let foreignFileId: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  /** A part in its own program, with one file attached. */
  async function programWithFile(owner: TestUser, label: string) {
    const program = await ProgramService.create(
      {
        name: `Vault Program ${label}`,
        code: `VP${label}-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      owner.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: `Vault Design ${label}`,
        code: `VD${label}-${Date.now()}`,
        designType: 'Engineering',
      },
      owner.id,
    )
    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: `Vault Part ${label}`,
        partType: 'Manufacture',
      },
      owner.id,
    )
    const file = takeFirst(
      await testDb.db
        .insert(vaultFiles)
        .values({
          itemId: part.id!,
          fileName: `drawing-${label}.pdf`,
          originalFileName: `drawing-${label}.pdf`,
          fileSize: 1024,
          mimeType: 'application/pdf',
          fileHash: randomUUID().replace(/-/g, ''),
          storagePath: `vault/${randomUUID()}/drawing-${label}.pdf`,
          fileCategory: 'drawing',
          uploadedBy: owner.id,
        })
        .returning(),
    )
    return { fileId: file.id, designId: design.id }
  }

  /**
   * A file on an item that belongs to no design at all — a Tool.
   *
   * `accessScopeCondition` admits these to everyone, on the same reasoning
   * `canAccessDesign` uses: they sit outside every program, so there is no
   * boundary to isolate them across. Pinned here so the exception reads as
   * deliberate rather than as a hole the scoping missed.
   */
  async function designLessFile(owner: TestUser) {
    const tool = await ItemService.create<Tool>(
      'Tool',
      {
        itemType: 'Tool',
        revision: 'A',
        name: 'Shared Calibration Jig',
        toolType: 'manufacturing',
        toolSubtype: 'fixture',
      },
      owner.id,
    )
    const file = takeFirst(
      await testDb.db
        .insert(vaultFiles)
        .values({
          itemId: tool.id!,
          fileName: 'jig.pdf',
          originalFileName: 'jig.pdf',
          fileSize: 512,
          mimeType: 'application/pdf',
          fileHash: randomUUID().replace(/-/g, ''),
          storagePath: `vault/${randomUUID()}/jig.pdf`,
          fileCategory: 'drawing',
          uploadedBy: owner.id,
        })
        .returning(),
    )
    return file.id
  }

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // Every documents verb and nothing else — in particular no
    // programs:manage, which is the cross-program bypass, and no system:manage,
    // which is what force-unlock charges to evict another holder. Unique name
    // because `roles` is shared and suites run in parallel.
    const role = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Documents All ${randomUUID().slice(0, 8)}`, {
        documents: ['create', 'read', 'update', 'delete'],
        parts: ['create', 'read', 'update'],
        designs: ['create', 'read'],
      }),
    )

    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    for (const u of [member, outsider]) {
      await assignRoleToUser(testDb.db, u.id, role.id)
    }
    permissionService.clearCache()

    const own = await programWithFile(member, 'A')
    ownFileId = own.fileId
    ownDesignId = own.designId
    foreignFileId = (await programWithFile(outsider, 'B')).fileId

    cookies.clear()
    for (const u of [member, outsider]) {
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

  // One row per shape the vault exposes: metadata, binary, history, mutation,
  // markup, admin override. `foreignFileId` is real — these are not 404s.
  const denied: Array<[string, string, string, object?]> = [
    ['metadata', 'GET', '/metadata'],
    ['thumbnail', 'GET', '/thumbnail'],
    ['download', 'GET', '/download'],
    ['content', 'GET', '/content'],
    ['lock-status', 'GET', '/lock-status'],
    ['versions', 'GET', '/versions'],
    ['version download', 'GET', '/versions/1/download'],
    ['annotations list', 'GET', '/annotations'],
    ['convert', 'POST', '/convert'],
    ['checkout', 'POST', '/checkout'],
    ['checkin', 'POST', '/checkin'],
    ['force-unlock', 'POST', '/force-unlock'],
    ['delete', 'DELETE', ''],
    ['category', 'PATCH', '/category', { category: 'drawing' }],
    [
      'annotation create',
      'POST',
      '/annotations',
      // Schema-valid on purpose. The route now validates the body in the
      // wrapper, before the handler's access check, so an invalid one would
      // answer 400 and prove nothing about who may reach the file.
      {
        pageNumber: 1,
        color: '#ff0000',
        geometry: { kind: 'note', anchor: { x: 0.5, y: 0.5 } },
        contents: 'smuggled',
      },
    ],
  ]

  it.each(denied)(
    'refuses a non-member: %s',
    async (_label, method, suffix, body) => {
      const response = await request(
        outsider,
        `/api/v1/files/${ownFileId}${suffix}`,
        method,
        body,
      )

      expect(response.status).toBe(403)
      const payload = (await response.json()) as ErrorEnvelope
      expect(payload.error.code).toBe(ErrorCode.PERMISSION_DENIED)
    },
  )

  it('serves the same routes to a member', async () => {
    expect(
      (await request(member, `/api/v1/files/${ownFileId}/metadata`)).status,
    ).toBe(200)
    expect(
      (await request(member, `/api/v1/files/${ownFileId}/versions`)).status,
    ).toBe(200)
    expect(
      (await request(member, `/api/v1/files/${ownFileId}/lock-status`)).status,
    ).toBe(200)
  })

  it('checks out only the reachable files in a mixed batch', async () => {
    const response = await request(
      member,
      '/api/v1/files/batch-checkout',
      'POST',
      { fileIds: [ownFileId, foreignFileId] },
    )

    // 207: the request is neither wholly refused nor wholly satisfied, which
    // is the contract these endpoints already had for partial failure.
    expect(response.status).toBe(207)
    const { data } = (await response.json()) as BatchResult
    expect(data.checkedOut.map((f) => f.fileId)).toEqual([ownFileId])
    expect(data.errors).toEqual([
      { fileId: foreignFileId, error: 'Access denied' },
    ])
  })

  describe('GET /api/v1/files — the collection draws the same boundary', () => {
    async function listedFiles(user: TestUser) {
      const response = await request(user, '/api/v1/files?limit=500')
      expect(response.status).toBe(200)
      const payload = (await response.json()) as FileListEnvelope
      return payload.data.files
    }

    it('serves a member the files of the design they can reach', async () => {
      const files = await listedFiles(member)

      expect(files.map((f) => f.id)).toContain(ownFileId)
      expect(files.map((f) => f.id)).not.toContain(foreignFileId)
    })

    it('serves a non-member none of another program’s files', async () => {
      const files = await listedFiles(outsider)

      expect(files.map((f) => f.id)).not.toContain(ownFileId)
      // The outsider is not fileless — they own program B, so a 403-shaped
      // empty answer would pass a weaker assertion than this one.
      expect(files.map((f) => f.id)).toContain(foreignFileId)
    })

    it('returns no row whose item sits outside the caller’s design set', async () => {
      // The invariant, stated positively: every listed row belongs either to a
      // design the caller reaches or to no design at all.
      const files = await listedFiles(outsider)

      const reachable = await AccessControlService.getAccessibleDesignIds(
        outsider.id,
      )
      expect(reachable).not.toBeNull()
      const itemIds = files.map((f) => f.itemId)
      const rows = itemIds.length
        ? await testDb.db
            .select({ id: items.id, designId: items.designId })
            .from(items)
            .where(inArray(items.id, itemIds))
        : []
      for (const row of rows) {
        if (row.designId !== null) {
          expect(reachable).toContain(row.designId)
        }
      }
      expect(reachable).not.toContain(ownDesignId)
    })

    it('serves cross-program authority every program’s files', async () => {
      const auditorRole = await insertTestRole(
        testDb.db,
        createCustomTestRole(`Vault Auditor ${randomUUID().slice(0, 8)}`, {
          documents: ['read'],
          // The bypass: `getAccessibleDesignIds` answers null for this.
          programs: ['manage'],
        }),
      )
      const auditor = await insertTestUser(testDb.db)
      await assignRoleToUser(testDb.db, auditor.id, auditorRole.id)
      permissionService.clearCache()
      const { sessionToken } = await SessionManager.createSession(auditor.id)
      cookies.set(auditor.id, `session=${sessionToken}`)

      const files = await listedFiles(auditor)

      expect(files.map((f) => f.id)).toEqual(
        expect.arrayContaining([ownFileId, foreignFileId]),
      )
    })

    it('admits a design-less item’s file to everyone', async () => {
      const jigId = await designLessFile(member)

      expect((await listedFiles(member)).map((f) => f.id)).toContain(jigId)
      expect((await listedFiles(outsider)).map((f) => f.id)).toContain(jigId)
    })
  })

  describe('POST /:fileId/force-unlock — the override is reachable and charged', () => {
    /** Who the vault thinks holds the lock, read straight from the row. */
    async function lockHolder(fileId: string): Promise<string | null> {
      const row = takeFirst(
        await testDb.db
          .select({
            isCheckedOut: vaultFiles.isCheckedOut,
            checkedOutBy: vaultFiles.checkedOutBy,
          })
          .from(vaultFiles)
          .where(eq(vaultFiles.id, fileId)),
      )
      // The two columns must agree; a released lock naming a holder would
      // pass a `checkedOutBy === null` assertion for the wrong reason.
      if (!row.isCheckedOut) {
        expect(row.checkedOutBy).toBeNull()
        return null
      }
      return row.checkedOutBy
    }

    async function checkOut(user: TestUser, fileId: string) {
      const response = await request(
        user,
        `/api/v1/files/${fileId}/checkout`,
        'POST',
      )
      expect(response.status).toBe(200)
      expect(await lockHolder(fileId)).toBe(user.id)
    }

    async function forceUnlock(user: TestUser, fileId: string) {
      return request(user, `/api/v1/files/${fileId}/force-unlock`, 'POST')
    }

    it('admits a seeded Administrator to breaking another user’s lock', async () => {
      // The leg whose absence hid the defect: the route charged
      // `documents:manage`, which no role in ROLE_DEFINITIONS grants on any
      // item-type resource, so it refused everyone — and every refusal leg
      // passed just as well against a charge nothing can satisfy.
      //
      // Administrator reaches the file itself through its seeded
      // programs:manage cross-program bypass, and holds both halves of the
      // new charge: documents:update and system:manage.
      const { user: admin } = await insertTestUserWithRole(
        testDb.db,
        'Administrator',
      )
      permissionService.clearCache()
      const { sessionToken } = await SessionManager.createSession(admin.id)
      cookies.set(admin.id, `session=${sessionToken}`)

      await checkOut(member, ownFileId)

      const evict = await forceUnlock(admin, ownFileId)

      expect(evict.status).toBe(200)
      expect(await lockHolder(ownFileId)).toBeNull()
    })

    it('refuses a caller holding no system:manage, and leaves the lock standing', async () => {
      // On a design-less item, deliberately: `requireFileAccess` cannot refuse
      // it (see `designLessFile` above), so the only gate left standing on
      // this route is the eviction override. A 403 here is attributable to
      // that charge and to nothing else.
      const jigId = await designLessFile(member)
      await checkOut(member, jigId)

      // The outsider really can reach this file — proving the refusal below
      // is the override and not program isolation.
      expect(
        (await request(outsider, `/api/v1/files/${jigId}/metadata`)).status,
      ).toBe(200)

      const evict = await forceUnlock(outsider, jigId)

      expect(evict.status).toBe(403)
      const payload = (await evict.json()) as ErrorEnvelope
      expect(payload.error.code).toBe(ErrorCode.PERMISSION_DENIED)
      expect(await lockHolder(jigId)).toBe(member.id)
    })

    it('lets a holder release its own lock without the override', async () => {
      // The override is charged on eviction only. `member` holds
      // documents:update and no system:manage.
      await checkOut(member, ownFileId)

      const release = await forceUnlock(member, ownFileId)

      expect(release.status).toBe(200)
      expect(await lockHolder(ownFileId)).toBeNull()
    })

    it('answers a file nobody holds without charging the override', async () => {
      // Pins the ordering: the "not checked out" early return sits above the
      // override, so a caller that merely lost a race to another release
      // keeps its 200 instead of being turned into a 403.
      expect(await lockHolder(ownFileId)).toBeNull()

      const response = await forceUnlock(member, ownFileId)

      expect(response.status).toBe(200)
      expect(await lockHolder(ownFileId)).toBeNull()
    })
  })
})
