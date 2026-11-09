// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Import routes — what gets queued
 *
 * Security gate. An import is a background job: the route authorizes the
 * request and queues it, and the jobs worker then writes every row as the
 * submitting user without checking anything again. So the route is the only
 * gate, and the invariant is about the queue, not the response code alone:
 *
 *   - a request the route refuses queues nothing — no job row exists for it
 *     (a role without `parts:create`, a caller outside the design's program,
 *     `bypassBranchProtection` without the Administrator role)
 *   - an admitted request is queued whole, as the user it was admitted for,
 *     and answered 202 with where to watch it — and nothing is written yet
 *   - there is no row cap: a sheet over the old 500-row limit is queued
 *   - an unreachable job queue answers 503 with its own code, and queues
 *     nothing
 *
 * No broker runs in CI, so `RabbitMQClient` is stubbed: `JobService.submit`
 * still writes the job row, which is what these assert on.
 *
 * Run: npx vitest run cascadia-api/src/server/routes/import.permissions.test.ts
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
  vi,
} from 'vitest'
import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { ErrorCode } from '@cascadia/commons/errors/codes'
import importRoutes from './import'
import type { MockInstance } from 'vitest'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
  insertTestUserWithRole,
} from '@/__tests__/fixtures/users'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { items, jobs, programMembers } from '@/db/schema'
import { RabbitMQClient } from '@/jobs/rabbitmq/client'
import { IMPORT_JOB_TYPES } from '@/jobs/definitions/import/config'

// Import to register item types
import '@/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('import routes — what gets queued', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/import', importRoutes)

  let admin: TestUser
  let engineer: TestUser
  let viewer: TestUser
  let outsider: TestUser
  let designId: string
  const cookies = new Map<string, string>()

  let connectSpy: MockInstance<typeof RabbitMQClient.connect>

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // `submit` connects before it writes the row, and no broker runs in CI.
    connectSpy = vi
      .spyOn(RabbitMQClient, 'connect')
      .mockResolvedValue(undefined)
    vi.spyOn(RabbitMQClient, 'publish').mockResolvedValue(undefined)

    const suffix = randomUUID().slice(0, 8)

    // May create parts, may not administer anything: the shape that must be
    // admitted to an ordinary import and refused an override. No
    // `programs:manage`, whose cross-program reach would mask the design gate.
    const creatorRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Importer ${suffix}`, {
        parts: ['read', 'create'],
        programs: ['read'],
      }),
    )

    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    viewer = (await insertTestUserWithRole(testDb.db, 'View Only')).user
    engineer = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, engineer.id, creatorRole.id)
    await assignRoleToUser(testDb.db, outsider.id, creatorRole.id)
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'Import Gate Program',
        code: `IGP-${Date.now()}-${suffix.slice(0, 4).toUpperCase()}`,
      },
      admin.id,
    )
    // Everyone but the outsider is a member (the admin already is, as the
    // program's creator); the outsider's role is the engineer's, so
    // membership is the only thing that differs.
    await testDb.db.insert(programMembers).values(
      [engineer, viewer].map((u) => ({
        programId: program.id,
        userId: u.id,
        role: 'engineer',
      })),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Import Gate Design',
        code: `IGD-${Date.now()}-${suffix.slice(4, 8).toUpperCase()}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    designId = design.id

    cookies.clear()
    for (const u of [admin, engineer, viewer, outsider]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await testDb.rollback()
  })

  function importParts(user: TestUser, body: Record<string, unknown>) {
    return app.request('/api/v1/import/parts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.get(user.id)!,
      },
      body: JSON.stringify({ designId, ...body }),
    })
  }

  function rows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      itemNumber: `IMP-${i + 1}`,
      name: `Imported part ${i + 1}`,
      partType: 'Manufacture',
    }))
  }

  /** Part imports this suite's users queued — rows committed by anything else are not ours to count. */
  async function queuedImports() {
    return testDb.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, IMPORT_JOB_TYPES.parts),
          inArray(
            jobs.createdBy,
            [admin, engineer, viewer, outsider].map((u) => u.id),
          ),
        ),
      )
  }

  it('queues an admitted import as its user, answers 202, and writes nothing yet', async () => {
    const response = await importParts(engineer, { rows: rows(2) })

    expect(response.status).toBe(202)
    const { data } = (await response.json()) as { data: { jobId: string } }
    expect(response.headers.get('Location')).toBe(`/api/v1/jobs/${data.jobId}`)

    const [job, ...others] = await queuedImports()
    expect(others).toHaveLength(0)
    expect(job?.id).toBe(data.jobId)
    expect(job?.createdBy).toBe(engineer.id)
    const payload = job?.payload as {
      userId: string
      request: { designId: string; rows: Array<unknown> }
    }
    expect(payload.userId).toBe(engineer.id)
    expect(payload.request.designId).toBe(designId)
    expect(payload.request.rows).toHaveLength(2)

    // The worker writes the rows; the request that queued them wrote none.
    const written = await testDb.db
      .select()
      .from(items)
      .where(eq(items.designId, designId))
    expect(written).toHaveLength(0)
  })

  it('queues a sheet larger than the old 500-row cap', async () => {
    const response = await importParts(engineer, { rows: rows(600) })

    expect(response.status).toBe(202)
    const [job] = await queuedImports()
    expect(
      (job?.payload as { request: { rows: Array<unknown> } }).request.rows,
    ).toHaveLength(600)
  })

  it('refuses a role without parts:create and queues nothing', async () => {
    const response = await importParts(viewer, { rows: rows(1) })

    expect(response.status).toBe(403)
    expect(await queuedImports()).toHaveLength(0)
  })

  it("refuses a caller outside the design's program and queues nothing", async () => {
    const response = await importParts(outsider, { rows: rows(1) })

    expect(response.status).toBe(403)
    const { error } = (await response.json()) as ErrorEnvelope
    expect(error.code).toBe(ErrorCode.PERMISSION_DENIED)
    expect(await queuedImports()).toHaveLength(0)
  })

  it('refuses bypassBranchProtection without the Administrator role and queues nothing', async () => {
    const response = await importParts(engineer, {
      rows: rows(1),
      bypassBranchProtection: true,
    })

    expect(response.status).toBe(403)
    expect(await queuedImports()).toHaveLength(0)

    // The same body from an administrator is admitted: the role is the gate.
    const admitted = await importParts(admin, {
      rows: rows(1),
      bypassBranchProtection: true,
    })
    expect(admitted.status).toBe(202)
  })

  it('answers 503 when the job queue cannot be reached, and queues nothing', async () => {
    connectSpy.mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:5672'),
    )

    const response = await importParts(engineer, { rows: rows(1) })

    expect(response.status).toBe(503)
    const { error } = (await response.json()) as ErrorEnvelope
    expect(error.code).toBe(ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE)
    expect(await queuedImports()).toHaveLength(0)
  })
})
