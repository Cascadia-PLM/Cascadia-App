// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Requirement traceability routes — RBAC gate
 *
 * Security gate. The six traceability writes (satisfy, allocate, verify —
 * link and unlink) declared no `permission` tuple at all, so `apiHandler`
 * skipped the whole RBAC block: role permissions were never consulted and a
 * scoped API key had nothing to intersect against. Program membership was the
 * only gate, which meant a read-only member could rewire the traceability
 * graph of any requirement in a program they belonged to. The four matching
 * reads had the same hole, harmless for stock roles but not for key scoping.
 *
 * Both users here are members of the same program and hold the same
 * item-reaching grants. The ONLY difference is `requirements:update`, so a 403
 * can come from nothing but the tuple. The writer's legs assert
 * "anything but 403": the permission check runs ahead of body parsing and the
 * service, so a 400/404/409 from further down still proves the gate admitted
 * the caller, and pinning the exact success code would pin service behaviour
 * this suite is not about.
 *
 * Run: npx vitest run packages/core/src/server/routes/requirements.traceability.permissions.test.ts
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
import { eq, or } from 'drizzle-orm'
import requirementsRoutes from './requirements'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Requirement } from '@/lib/items/types/requirement'
import type { Part } from '@/lib/items/types/part'
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
import { itemRelationships, programMembers } from '@/lib/db/schema'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('requirement traceability routes — RBAC gate', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/requirements', requirementsRoutes)

  let reader: TestUser
  let writer: TestUser
  let stranger: TestUser
  let requirementId: string
  let partId: string

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

    // READER is the shape of the stock 'View Only' role: requirements:read and
    // nothing else on requirements. WRITER differs by exactly one grant.
    // Neither holds programs:manage — the cross-program bypass would mask the
    // very gate under test.
    const readerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Trace Reader ${suffix}`, {
        requirements: ['read'],
        parts: ['read'],
        programs: ['read'],
      }),
    )
    const writerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Trace Writer ${suffix}`, {
        requirements: ['create', 'read', 'update'],
        parts: ['create', 'read', 'update'],
        designs: ['create', 'read'],
        programs: ['read'],
      }),
    )
    // Holds a read grant on everything the fixture touches EXCEPT
    // requirements, so the read legs isolate the requirements tuple.
    const strangerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Trace Stranger ${suffix}`, {
        parts: ['read'],
        documents: ['read'],
        programs: ['read'],
      }),
    )

    reader = await insertTestUser(testDb.db)
    writer = await insertTestUser(testDb.db)
    stranger = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, reader.id, readerRole.id)
    await assignRoleToUser(testDb.db, writer.id, writerRole.id)
    await assignRoleToUser(testDb.db, stranger.id, strangerRole.id)
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'Trace Program',
        code: `TRC-${Date.now()}-${suffix.slice(0, 4).toUpperCase()}`,
      },
      writer.id,
    )
    // Every user is a member: these tests must fail on the RBAC tuple, never
    // on program access.
    await testDb.db.insert(programMembers).values(
      [reader, stranger].map((u) => ({
        programId: program.id,
        userId: u.id,
        role: 'engineer',
      })),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Trace Design',
        code: `TRCD-${Date.now()}`,
        designType: 'Engineering',
      },
      writer.id,
    )

    const requirement = await ItemService.create<Requirement>(
      'Requirement',
      {
        itemType: 'Requirement',
        designId: design.id,
        revision: 'A',
        name: 'The arm shall lift 5kg',
      },
      writer.id,
    )
    requirementId = requirement.id!

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Lift Actuator',
        partType: 'Manufacture',
      },
      writer.id,
    )
    partId = part.id!

    cookies.clear()
    for (const u of [reader, writer, stranger]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function call(
    user: TestUser,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`/api/v1/requirements${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  /** The six traceability writes, each as a callable request. */
  function writes(): Array<{
    name: string
    send: (user: TestUser) => Promise<Response>
  }> {
    return [
      {
        name: 'POST /:id/satisfy',
        send: (u) =>
          call(u, 'POST', `/${requirementId}/satisfy`, { itemIds: [partId] }),
      },
      {
        name: 'DELETE /:id/satisfy',
        send: (u) =>
          call(u, 'DELETE', `/${requirementId}/satisfy`, { itemId: partId }),
      },
      {
        name: 'POST /:id/allocate',
        send: (u) =>
          call(u, 'POST', `/${requirementId}/allocate`, { itemIds: [partId] }),
      },
      {
        name: 'DELETE /:id/allocate',
        send: (u) =>
          call(u, 'DELETE', `/${requirementId}/allocate`, { itemId: partId }),
      },
      {
        name: 'POST /:id/verify',
        send: (u) =>
          call(u, 'POST', `/${requirementId}/verify`, { testCaseIds: [] }),
      },
      {
        name: 'DELETE /:id/verify',
        send: (u) =>
          call(
            u,
            'DELETE',
            `/${requirementId}/verify?testCaseId=${randomUUID()}`,
          ),
      },
    ]
  }

  describe('writes require requirements:update', () => {
    it('refuses a read-only member every traceability write', async () => {
      for (const { name, send } of writes()) {
        const response = await send(reader)

        expect(response.status, name).toBe(403)
        const payload = (await response.json()) as ErrorEnvelope
        expect(payload.error.code, name).toBe(ErrorCode.PERMISSION_DENIED)
      }
    })

    it('admits a member holding requirements:update to every one', async () => {
      // Anything but 403 proves the gate passed. The permission check runs
      // ahead of body parsing and the service, so a downstream 400/404/409 is
      // still a pass for this invariant.
      for (const { name, send } of writes()) {
        const response = await send(writer)

        expect(response.status, name).not.toBe(403)
      }
    })

    it('leaves the graph untouched when the write is refused', async () => {
      const edgeCount = async () =>
        (
          await testDb.db
            .select()
            .from(itemRelationships)
            .where(
              or(
                eq(itemRelationships.sourceId, requirementId),
                eq(itemRelationships.targetId, requirementId),
              ),
            )
        ).length

      const before = await edgeCount()

      const response = await call(reader, 'POST', `/${requirementId}/satisfy`, {
        itemIds: [partId],
      })
      expect(response.status).toBe(403)

      expect(await edgeCount()).toBe(before)
    })
  })

  describe('reads require requirements:read', () => {
    const reads = [
      '/parent',
      '/satisfy',
      '/allocate',
      '/verifying-tests',
    ] as const

    it('refuses a member with every other read grant but not requirements', async () => {
      for (const suffix of reads) {
        const response = await call(
          stranger,
          'GET',
          `/${requirementId}${suffix}`,
        )

        expect(response.status, suffix).toBe(403)
        const payload = (await response.json()) as ErrorEnvelope
        expect(payload.error.code, suffix).toBe(ErrorCode.PERMISSION_DENIED)
      }
    })

    it('serves a member holding requirements:read', async () => {
      for (const suffix of reads) {
        const response = await call(reader, 'GET', `/${requirementId}${suffix}`)

        expect(response.status, suffix).toBe(200)
      }
    })
  })
})
