// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * GET /api/v1/jobs/:id — the status poll belongs to the job's submitter
 *
 * Security gate. The route was declared auth-only, so any authenticated user
 * who could name a job id read that job's status, its `result` payload and
 * its `error` string — including the maintenance jobs the scheduler submits
 * for itself, which no user submitted at all. Its admin siblings under
 * `/api/v1/admin/jobs` have always required `system:manage`; this one was the
 * hole beside them.
 *
 * The scoping is: the submitter, plus `system:manage`. A job with a null
 * `createdBy` is system-submitted and therefore administrator-only, since
 * there is no submitter for it to belong to. `system:read` is deliberately
 * not enough — a Power User can open the System section without being
 * handed every job on the instance.
 *
 * The refusal is a 404 rather than a 403, so a caller cannot use the route to
 * learn which job ids exist; the enumeration test pins that by comparing the
 * refusal against a read of a job id that was never issued. Same hardening as
 * `by-id-enumeration.permissions.test.ts` draws over the item routes.
 *
 * The API-key legs at the end cover the other half of the gate: the route
 * declares no permission tuple, and `apiHandler` narrows key scope only inside
 * its declared-permission branch, so the `system:manage` escalation has to
 * intersect the key's scope itself. Without that, an administrator's key
 * minted for a read-only integration read every job on the instance here while
 * `/api/v1/admin/jobs/:id` refused the same key.
 *
 * Run: npx vitest run packages/core/src/server/routes/jobs.permissions.test.ts
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
import jobsRoutes from './jobs'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import {
  generateApiKey,
  getKeyPrefix,
  hashApiKey,
} from '@/lib/auth/api-key-utils'
import { apiKeys } from '@/lib/db/schema/api-keys'
import { jobs } from '@/lib/db/schema/jobs'
import { takeFirst } from '@/lib/db/take-first'
import { ErrorCode } from '@/lib/errors/codes'

const JOB_TYPE = 'test.jobs.permissions'

interface ErrorEnvelope {
  error: { code: string }
}

interface JobEnvelope {
  data: { id: string; result: Record<string, unknown> | null }
}

describe('GET /api/v1/jobs/:id — submitter scoping', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/jobs', jobsRoutes)

  let submitter: TestUser
  let stranger: TestUser
  let powerUser: TestUser // system:read, but not system:manage
  let admin: TestUser

  let ownJobId: string
  let systemJobId: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  /** A finished job row, carrying a result payload worth not leaking. */
  async function insertJob(createdBy: string | null): Promise<string> {
    const row = takeFirst(
      await testDb.db
        .insert(jobs)
        .values({
          type: JOB_TYPE,
          status: 'completed',
          payload: { itemId: randomUUID() },
          result: { generatedFileName: 'confidential.step' },
          createdBy,
        })
        .returning(),
    )
    return row.id
  }

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    submitter = (await insertTestUserWithRole(testDb.db, 'User')).user
    stranger = (await insertTestUserWithRole(testDb.db, 'User')).user
    powerUser = (await insertTestUserWithRole(testDb.db, 'Power User')).user
    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    permissionService.clearCache()

    ownJobId = await insertJob(submitter.id)
    systemJobId = await insertJob(null)

    cookies.clear()
    for (const u of [submitter, stranger, powerUser, admin]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function read(user: TestUser, jobId: string) {
    return app.request(`/api/v1/jobs/${jobId}`, {
      headers: {
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
      },
    })
  }

  /** An API key on `userId`, scoped to `scope` (null = the owner's rights). */
  async function mintKey(
    userId: string,
    scope: Record<string, Array<string>> | null,
  ): Promise<string> {
    const rawKey = generateApiKey()
    await testDb.db.insert(apiKeys).values({
      userId,
      name: 'jobs test key',
      keyHash: hashApiKey(rawKey),
      keyPrefix: getKeyPrefix(rawKey),
      permissions: scope,
    })
    return rawKey
  }

  function readWithKey(rawKey: string, jobId: string) {
    return app.request(`/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    })
  }

  async function expectNotFound(response: Response) {
    expect(response.status).toBe(404)
    const payload = (await response.json()) as ErrorEnvelope
    expect(payload.error.code).toBe(ErrorCode.RESOURCE_NOT_FOUND)
  }

  it('serves the submitter the job they started', async () => {
    const response = await read(submitter, ownJobId)

    expect(response.status).toBe(200)
    const payload = (await response.json()) as JobEnvelope
    expect(payload.data.id).toBe(ownJobId)
    expect(payload.data.result).toEqual({
      generatedFileName: 'confidential.step',
    })
  })

  it('refuses another user the job they did not start', async () => {
    await expectNotFound(await read(stranger, ownJobId))
  })

  it('serves a system:manage holder any user’s job', async () => {
    const response = await read(admin, ownJobId)

    expect(response.status).toBe(200)
    const payload = (await response.json()) as JobEnvelope
    expect(payload.data.id).toBe(ownJobId)
  })

  it('refuses a holder of system:read without system:manage', async () => {
    await expectNotFound(await read(powerUser, ownJobId))
  })

  it('refuses a non-admin a system-submitted job', async () => {
    await expectNotFound(await read(submitter, systemJobId))
    await expectNotFound(await read(stranger, systemJobId))
  })

  it('serves a system:manage holder a system-submitted job', async () => {
    const response = await read(admin, systemJobId)

    expect(response.status).toBe(200)
    const payload = (await response.json()) as JobEnvelope
    expect(payload.data.id).toBe(systemJobId)
  })

  it('refuses an unreachable job exactly as it refuses a missing one', async () => {
    const refused = await read(stranger, ownJobId)
    const missing = await read(stranger, randomUUID())

    expect(refused.status).toBe(missing.status)
    const refusedPayload = (await refused.json()) as ErrorEnvelope
    const missingPayload = (await missing.json()) as ErrorEnvelope
    expect(refusedPayload.error.code).toBe(missingPayload.error.code)
  })

  it('refuses an administrator’s scoped key the jobs they did not submit', async () => {
    // The read-only CI key an admin mints: it carries their identity, so the
    // escalation must come from the intersected scope, not their roles.
    const key = await mintKey(admin.id, { parts: ['read'] })

    await expectNotFound(await readWithKey(key, ownJobId))
    await expectNotFound(await readWithKey(key, systemJobId))
  })

  it('serves the same administrator through a key carrying full scope', async () => {
    const key = await mintKey(admin.id, null)

    const response = await readWithKey(key, ownJobId)

    expect(response.status).toBe(200)
    const payload = (await response.json()) as JobEnvelope
    expect(payload.data.id).toBe(ownJobId)
  })

  it('serves the submitter their own job through a narrowly scoped key', async () => {
    // Ownership, not permission, admits this one — narrowing the key must not
    // take the submitter's own status poll away.
    const key = await mintKey(submitter.id, { parts: ['read'] })

    const response = await readWithKey(key, ownJobId)

    expect(response.status).toBe(200)
    const payload = (await response.json()) as JobEnvelope
    expect(payload.data.id).toBe(ownJobId)
  })
})
