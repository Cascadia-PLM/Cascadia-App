// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Item detail writes — RBAC gate
 *
 * Security gate. Four writes under `/api/v1/items/:id/*` declared no
 * `permission` tuple at all, so `apiHandler` skipped the whole RBAC block:
 * role permissions were never consulted and a scoped API key had nothing to
 * intersect against. Program membership was the only gate — and
 * `requireItemAccess` only gates on `items.designId`, which WorkOrder and
 * PhysicalPart rows never carry, so `POST /:id/sync-properties` on one of
 * those was gated by authentication alone.
 *
 * The users here are members of the same program and differ ONLY in which
 * item resource they hold `update` on, so a PERMISSION_DENIED can come from
 * nothing but the tuple.
 *
 * Two things this suite has to get right, or it passes vacuously:
 *
 *  - The check is in-handler rather than a declared `permission:` key, so the
 *    wrapper parses `body:` FIRST. An empty body yields 400, not 403. Every
 *    body below is schema-valid.
 *  - A 403 is not by itself proof of refusal here: branch protection answers
 *    403/BRANCH_PROTECTED from further down. The admitted legs therefore
 *    assert on `error.code`, not on the status.
 *
 * Run: npx vitest run packages/core/src/server/routes/items.detail-writes.permissions.test.ts
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
import { eq } from 'drizzle-orm'
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { Document } from '@/lib/items/types/document'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { itemRelationships, items, programMembers } from '@/lib/db/schema'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('item detail writes — RBAC gate', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)

  let reader: TestUser
  let partsWriter: TestUser
  let docsWriter: TestUser
  let partId: string
  let docId: string
  let targetPartId: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // The permission cache is process-global; these users are new each test.
    permissionService.clearCache()

    const suffix = randomUUID().slice(0, 8)

    // READER is the shape of the stock 'View Only' role: read on every
    // resource the fixture touches and nothing else. The two writers differ
    // from it by exactly one grant each, and from each other only in WHICH
    // item resource carries that grant — the axis `getResourceType` dispatches
    // on. None holds programs:manage; the cross-program bypass would mask the
    // very gate under test.
    const readerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Detail Reader ${suffix}`, {
        parts: ['read'],
        documents: ['read'],
        programs: ['read'],
      }),
    )
    const partsWriterRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Detail Parts Writer ${suffix}`, {
        parts: ['read', 'update'],
        documents: ['read'],
        programs: ['read'],
      }),
    )
    const docsWriterRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Detail Docs Writer ${suffix}`, {
        parts: ['read'],
        documents: ['read', 'update'],
        programs: ['read'],
      }),
    )

    reader = await insertTestUser(testDb.db)
    partsWriter = await insertTestUser(testDb.db)
    docsWriter = await insertTestUser(testDb.db)
    const owner = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, reader.id, readerRole.id)
    await assignRoleToUser(testDb.db, partsWriter.id, partsWriterRole.id)
    await assignRoleToUser(testDb.db, docsWriter.id, docsWriterRole.id)
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'Detail Writes Program',
        code: `DTW-${Date.now()}-${suffix.slice(0, 4).toUpperCase()}`,
      },
      owner.id,
    )
    // Every actor is a member: these tests must fail on the RBAC tuple, never
    // on program access.
    await testDb.db.insert(programMembers).values(
      [reader, partsWriter, docsWriter].map((u) => ({
        programId: program.id,
        userId: u.id,
        role: 'engineer',
      })),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Detail Writes Design',
        code: `DTWD-${Date.now()}`,
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
        name: 'Gate Subject',
        partType: 'Manufacture',
      },
      owner.id,
    )
    partId = part.id!

    const targetPart = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Edge Target',
        partType: 'Manufacture',
      },
      owner.id,
    )
    targetPartId = targetPart.id!

    const doc = await ItemService.create<Document>(
      'Document',
      {
        itemType: 'Document',
        designId: design.id,
        revision: 'A',
        name: 'Gate Subject Document',
      },
      owner.id,
    )
    docId = doc.id!

    cookies.clear()
    for (const u of [reader, partsWriter, docsWriter]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function call(
    user: TestUser,
    path: string,
    body: unknown,
  ): Promise<Response> {
    return app.request(`/api/v1/items${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
      },
      body: JSON.stringify(body),
    })
  }

  /**
   * The RBAC verdict alone. A 403 from branch protection or from the unlock
   * ownership rule is a different answer than "your role may not do this",
   * and only the latter is this suite's subject.
   */
  async function refusalCode(response: Response): Promise<string | null> {
    if (response.status !== 403) return null
    const payload = (await response.json()) as ErrorEnvelope
    return payload.error.code
  }

  /** The four writes, each as a callable request against the Part. */
  function writes(): Array<{
    name: string
    send: (user: TestUser) => Promise<Response>
  }> {
    return [
      {
        name: 'POST /:id/relationships',
        send: (u) =>
          call(u, `/${partId}/relationships`, {
            targetId: targetPartId,
            relationshipType: 'Reference',
          }),
      },
      {
        name: 'POST /:id/sync-properties',
        send: (u) =>
          call(u, `/${partId}/sync-properties`, {
            properties: { name: 'Renamed By Caller' },
          }),
      },
      { name: 'POST /:id/lock', send: (u) => call(u, `/${partId}/lock`, {}) },
      {
        name: 'POST /:id/unlock',
        send: (u) => call(u, `/${partId}/unlock`, {}),
      },
    ]
  }

  describe('writes require update on the item type', () => {
    it('refuses a read-only member every detail write', async () => {
      for (const { name, send } of writes()) {
        const response = await send(reader)

        expect(response.status, name).toBe(403)
        expect(await refusalCode(response), name).toBe(
          ErrorCode.PERMISSION_DENIED,
        )
      }
    })

    it('admits a member holding parts:update to every one', async () => {
      // The gate runs ahead of the service, so a downstream 400/404/409 — or
      // a 403 carrying BRANCH_PROTECTED — still proves the caller was
      // admitted. Pinning an exact success code would pin service behaviour
      // this suite is not about.
      for (const { name, send } of writes()) {
        const response = await send(partsWriter)

        expect(await refusalCode(response), name).not.toBe(
          ErrorCode.PERMISSION_DENIED,
        )
      }
    })

    it('leaves name and state untouched when sync-properties is refused', async () => {
      const readRow = async () =>
        (
          await testDb.db
            .select({ name: items.name, state: items.state })
            .from(items)
            .where(eq(items.id, partId))
        ).at(0)

      const before = await readRow()

      const response = await call(reader, `/${partId}/sync-properties`, {
        properties: { name: 'Renamed By Caller', state: 'Released' },
      })
      expect(response.status).toBe(403)

      expect(await readRow()).toEqual(before)
    })

    it('leaves the edge count untouched when the relationship write is refused', async () => {
      const edgeCount = async () =>
        (
          await testDb.db
            .select()
            .from(itemRelationships)
            .where(eq(itemRelationships.sourceId, partId))
        ).length

      const before = await edgeCount()

      const response = await call(reader, `/${partId}/relationships`, {
        targetId: targetPartId,
        relationshipType: 'Reference',
      })
      expect(response.status).toBe(403)

      expect(await edgeCount()).toBe(before)
    })
  })

  describe('the tuple dispatches on the item type', () => {
    it("charges the source item's own resource, not a fixed parts", async () => {
      // A fixed ['parts','update'] would both refuse the docs writer a
      // Document's own edges and let the parts writer rewire one. Only this
      // pair distinguishes the dispatch from a hardcoded resource.
      const edge = (user: TestUser, sourceId: string) =>
        call(user, `/${sourceId}/relationships`, {
          targetId: targetPartId,
          relationshipType: 'Reference',
        })

      expect(await refusalCode(await edge(docsWriter, docId))).not.toBe(
        ErrorCode.PERMISSION_DENIED,
      )
      expect(await refusalCode(await edge(docsWriter, partId))).toBe(
        ErrorCode.PERMISSION_DENIED,
      )

      expect(await refusalCode(await edge(partsWriter, partId))).not.toBe(
        ErrorCode.PERMISSION_DENIED,
      )
      expect(await refusalCode(await edge(partsWriter, docId))).toBe(
        ErrorCode.PERMISSION_DENIED,
      )
    })
  })
})
