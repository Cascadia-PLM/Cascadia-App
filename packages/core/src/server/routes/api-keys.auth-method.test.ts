// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * API-key management is session-only — the escalation gate
 *
 * A key can be scoped to less than its owner holds, so key management has to
 * be out of reach of a key. Otherwise the narrowing is decorative: a scoped
 * key could mint a second key carrying the owner's full roles (creation scopes
 * against the *owner*, not the calling credential), learn a broad key's new
 * secret by rotating it, or re-enable a key an administrator had just
 * disabled. Each of those recovers authority the scope was meant to remove.
 *
 * The invariant is therefore about the credential, not the permission: on
 * every key-management route, a valid API key is refused whatever its scope —
 * including a full-scope key belonging to an Administrator — while the same
 * request over a session cookie is not refused for that reason. The same rule
 * covers the key *policy* routes, which decide expiry rules for every key on
 * the instance.
 *
 * `PUT /auth/password` is here for the same reason: a key must not be able to
 * replace its owner's interactive credential.
 *
 * Run: npx vitest run packages/core/src/server/routes/api-keys.auth-method.test.ts
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
import adminRoutes from './admin'
import authRoutes from './auth'
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

interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: (keyId: string) => string
  body?: object
}

/** Self-service key management, under /api/v1/auth. */
const SELF_SERVICE: Array<Route> = [
  { method: 'GET', path: () => '/api/v1/auth/api-keys' },
  { method: 'POST', path: () => '/api/v1/auth/api-keys', body: { name: 'x' } },
  {
    method: 'PATCH',
    path: (id) => `/api/v1/auth/api-keys/${id}`,
    body: { name: 'renamed' },
  },
  { method: 'POST', path: (id) => `/api/v1/auth/api-keys/${id}/rotate` },
  { method: 'POST', path: (id) => `/api/v1/auth/api-keys/${id}/disable` },
  { method: 'POST', path: (id) => `/api/v1/auth/api-keys/${id}/enable` },
  { method: 'GET', path: (id) => `/api/v1/auth/api-keys/${id}/activity` },
  { method: 'DELETE', path: (id) => `/api/v1/auth/api-keys/${id}` },
]

/** The administrator equivalents, plus the instance-wide key policy. */
const ADMINISTRATIVE: Array<Route> = [
  { method: 'GET', path: () => '/api/v1/admin/api-key-policy' },
  {
    method: 'PUT',
    path: () => '/api/v1/admin/api-key-policy',
    body: { requireExpiration: false },
  },
  { method: 'GET', path: () => '/api/v1/admin/api-keys' },
  {
    method: 'PATCH',
    path: (id) => `/api/v1/admin/api-keys/${id}`,
    body: { name: 'renamed' },
  },
  { method: 'POST', path: (id) => `/api/v1/admin/api-keys/${id}/disable` },
  { method: 'POST', path: (id) => `/api/v1/admin/api-keys/${id}/enable` },
  { method: 'GET', path: (id) => `/api/v1/admin/api-keys/${id}/activity` },
  { method: 'DELETE', path: (id) => `/api/v1/admin/api-keys/${id}` },
]

describe('API-key management refuses API-key credentials', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/auth', authRoutes)
    .route('/api/v1/admin', adminRoutes)

  let admin: TestUser

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()
    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** A key with no scope narrowing — it carries everything its owner holds. */
  async function mintFullScopeKey(userId: string): Promise<string> {
    const rawKey = generateApiKey()
    await testDb.db.insert(apiKeys).values({
      userId,
      name: 'test key',
      keyHash: hashApiKey(rawKey),
      keyPrefix: getKeyPrefix(rawKey),
      permissions: null,
      expiresAt: null,
    })
    return rawKey
  }

  /** The id of some existing key, so a by-id route has a real target. */
  async function existingKeyId(userId: string): Promise<string> {
    const rawKey = generateApiKey()
    const [row] = await testDb.db
      .insert(apiKeys)
      .values({
        userId,
        name: 'target key',
        keyHash: hashApiKey(rawKey),
        keyPrefix: getKeyPrefix(rawKey),
        permissions: null,
        expiresAt: null,
      })
      .returning()
    return row!.id
  }

  async function send(
    route: Route,
    keyId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    return app.request(route.path(keyId), {
      method: route.method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: route.body ? JSON.stringify(route.body) : undefined,
    })
  }

  describe.each([
    ['self-service', SELF_SERVICE],
    ['administrative', ADMINISTRATIVE],
  ])('%s routes', (_label, routes) => {
    it.each(routes.map((r) => [`${r.method} ${r.path(':keyId')}`, r] as const))(
      '%s refuses a full-scope API key',
      async (_name, route) => {
        const rawKey = await mintFullScopeKey(admin.id)
        const keyId = await existingKeyId(admin.id)

        const res = await send(route, keyId, {
          Authorization: `Bearer ${rawKey}`,
        })

        expect(res.status).toBe(401)
      },
    )

    it.each(routes.map((r) => [`${r.method} ${r.path(':keyId')}`, r] as const))(
      '%s accepts the same request over a session',
      async (_name, route) => {
        const { sessionToken } = await SessionManager.createSession(admin.id)
        const keyId = await existingKeyId(admin.id)

        const res = await send(route, keyId, {
          Cookie: `session=${sessionToken}`,
        })

        // Only the credential is under test — a route may still answer 4xx for
        // its own reasons, but never 401, which is what a refused credential
        // reads as.
        expect(res.status).not.toBe(401)
      },
    )
  })

  it('refuses a full-scope API key on PUT /auth/password', async () => {
    const rawKey = await mintFullScopeKey(admin.id)

    const res = await app.request('/api/v1/auth/password', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({
        password: 'NewPassword-2',
        currentPassword: 'OldPassword-1',
      }),
    })

    expect(res.status).toBe(401)
  })
})
