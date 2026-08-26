// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Password routes — the self/admin boundary
 *
 * Three routes share the job and each is a security gate:
 *
 *  - PUT /auth/password — self-service. Session-only (an API key must not be
 *    able to replace its owner's interactive credential), proves the current
 *    password, keeps the calling session, revokes the rest.
 *  - PUT /users/:id/password — users:manage AND the target's current
 *    password ("verified admin change").
 *  - POST /users/:id/reset-password — users:manage, no current password,
 *    revokes ALL of the target's sessions.
 *
 * The caller × route matrix is pinned:
 *
 *  - self via /auth/password with correct current → changed, current session
 *    preserved, other sessions revoked
 *  - wrong current password → 401, password unchanged
 *  - missing current password → 400
 *  - bearer-authenticated caller on /auth/password → 401 (session-only)
 *  - plain user on either /users/:id route (own id included) → 403
 *  - admin reset → changed, ALL target sessions revoked
 *
 * Run: npx vitest run packages/core/src/server/routes/users.password.test.ts
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
import { eq } from 'drizzle-orm'
import usersRoutes from './users'
import authRoutes from './auth'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { SessionManager } from '@/lib/auth/session'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { permissionService } from '@/lib/auth/permission-service'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema/users'

const OLD_PASSWORD = 'OldPassword-1'
const NEW_PASSWORD = 'NewPassword-2'

describe('password routes — self/admin boundary', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/users', usersRoutes)
    .route('/api/v1/auth', authRoutes)

  let admin: TestUser
  let alice: TestUser
  let bob: TestUser

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

    const passwordHash = await hashPassword(OLD_PASSWORD)
    admin = (
      await insertTestUserWithRole(testDb.db, 'Administrator', {
        passwordHash,
      })
    ).user
    alice = (await insertTestUserWithRole(testDb.db, 'User', { passwordHash }))
      .user
    bob = (await insertTestUserWithRole(testDb.db, 'User', { passwordHash }))
      .user

    cookies.clear()
    for (const u of [admin, alice, bob]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function as(user: TestUser, extraHeaders: Record<string, string> = {}) {
    const cookie = cookies.get(user.id)!
    return {
      send: (method: string, path: string, body?: unknown) =>
        app.request(path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            ...extraHeaders,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    }
  }

  async function storedHash(userId: string): Promise<string> {
    const row = await db.query.users.findFirst({
      where: eq(users.id, userId),
    })
    return row!.passwordHash!
  }

  describe('PUT /auth/password (self-service)', () => {
    it('changes own password with the correct current password and keeps the current session', async () => {
      const res = await as(alice).send('PUT', `/api/v1/auth/password`, {
        password: NEW_PASSWORD,
        currentPassword: OLD_PASSWORD,
      })
      expect(res.status).toBe(200)

      expect(
        await verifyPassword(await storedHash(alice.id), NEW_PASSWORD),
      ).toBe(true)

      // The session that made the change still works…
      const again = await as(alice).send('PUT', `/api/v1/auth/password`, {
        password: OLD_PASSWORD,
        currentPassword: NEW_PASSWORD,
      })
      expect(again.status).toBe(200)
    })

    it('revokes the user’s other sessions on change', async () => {
      const { sessionToken: otherToken } = await SessionManager.createSession(
        alice.id,
      )

      const res = await as(alice).send('PUT', `/api/v1/auth/password`, {
        password: NEW_PASSWORD,
        currentPassword: OLD_PASSWORD,
      })
      expect(res.status).toBe(200)

      expect(await SessionManager.validateSession(otherToken)).toBeNull()
    })

    it('rejects a wrong current password with 401 and leaves the password unchanged', async () => {
      const before = await storedHash(alice.id)
      const res = await as(alice).send('PUT', `/api/v1/auth/password`, {
        password: NEW_PASSWORD,
        currentPassword: 'not-the-password',
      })
      expect(res.status).toBe(401)
      expect(await storedHash(alice.id)).toBe(before)
    })

    it('rejects a missing current password with 400', async () => {
      const res = await as(alice).send('PUT', `/api/v1/auth/password`, {
        password: NEW_PASSWORD,
      })
      expect(res.status).toBe(400)
    })

    it('refuses bearer-authenticated callers — a key cannot replace its owner’s credential', async () => {
      const before = await storedHash(alice.id)
      const res = await as(alice, { Authorization: 'Bearer some-key' }).send(
        'PUT',
        `/api/v1/auth/password`,
        { password: NEW_PASSWORD, currentPassword: OLD_PASSWORD },
      )
      expect(res.status).toBe(401)
      expect(await storedHash(alice.id)).toBe(before)
    })
  })

  describe('PUT /users/:id/password (verified admin change)', () => {
    it('denies callers without users:manage — their own id included', async () => {
      for (const target of [alice, bob]) {
        const before = await storedHash(target.id)
        const res = await as(bob).send(
          'PUT',
          `/api/v1/users/${target.id}/password`,
          { password: NEW_PASSWORD, currentPassword: OLD_PASSWORD },
        )
        expect(res.status).toBe(403)
        expect(await storedHash(target.id)).toBe(before)
      }
    })

    it('lets users:manage change a password only with the target’s current password', async () => {
      const wrong = await as(admin).send(
        'PUT',
        `/api/v1/users/${alice.id}/password`,
        { password: NEW_PASSWORD, currentPassword: 'not-the-password' },
      )
      expect(wrong.status).toBe(401)

      const right = await as(admin).send(
        'PUT',
        `/api/v1/users/${alice.id}/password`,
        { password: NEW_PASSWORD, currentPassword: OLD_PASSWORD },
      )
      expect(right.status).toBe(200)
      expect(
        await verifyPassword(await storedHash(alice.id), NEW_PASSWORD),
      ).toBe(true)
    })
  })

  describe('POST /users/:id/reset-password (admin)', () => {
    it('lets users:manage reset another user’s password and revokes all target sessions', async () => {
      const { sessionToken: aliceToken } = await SessionManager.createSession(
        alice.id,
      )

      const res = await as(admin).send(
        'POST',
        `/api/v1/users/${alice.id}/reset-password`,
        { password: NEW_PASSWORD },
      )
      expect(res.status).toBe(200)

      expect(
        await verifyPassword(await storedHash(alice.id), NEW_PASSWORD),
      ).toBe(true)
      expect(await SessionManager.validateSession(aliceToken)).toBeNull()
    })

    it('denies reset to callers without users:manage', async () => {
      const before = await storedHash(alice.id)
      const res = await as(bob).send(
        'POST',
        `/api/v1/users/${alice.id}/reset-password`,
        { password: NEW_PASSWORD },
      )
      expect(res.status).toBe(403)
      expect(await storedHash(alice.id)).toBe(before)
    })
  })
})
