// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Webhook administration — the gate, and the projection.
 *
 * Gate 2 only, and only on the server. Two things are pinned here and the second
 * is the one nothing else can catch:
 *
 * **The gate.** Every route declares `permission: ['system', 'manage']`, which is
 * Administrator-only. A session without it is refused, and so is an
 * Administrator's API key whose scope excludes it — the handler intersects key
 * scope with role permissions, so a narrowed key must not recover its owner's
 * full reach.
 *
 * **The projection.** A subscription row holds a live HMAC signing key. There is
 * no shared public-projection helper in this codebase and no CI gate for one, so
 * an ordinary `select()` in a list route returns that key to any caller who
 * legitimately holds `system:manage` — and every permission check passes,
 * because they do hold it. The assertion below is the only thing standing
 * between a refactor and a leaked signing key, and it is written over the
 * *response's own values* rather than as a hardcoded omission of one field name:
 * a future column holding the ciphertext under a different name has to fail it
 * too.
 *
 * Run: npx vitest run packages/cascadia-api/src/server/routes/webhooks.permissions.test.ts
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
import { ErrorCode } from '@cascadia/commons/lib/errors/codes'
import webhookRoutes from './webhooks'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { ApiKeyService } from '@/lib/auth/ApiKeyService'
import { webhookSubscriptions } from '@/lib/db/schema'

const ENCRYPTION_KEY = 'b'.repeat(64)

/** Every route on this router, with the shape of a legal request to it. */
const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '' },
  {
    method: 'POST',
    path: '',
    body: { name: 'probe', targetUrl: 'https://hooks.example.test/x' },
  },
  { method: 'GET', path: '/:id' },
  { method: 'PATCH', path: '/:id', body: { name: 'renamed' } },
  { method: 'DELETE', path: '/:id' },
  { method: 'POST', path: '/:id/enable' },
  { method: 'POST', path: '/:id/disable' },
  { method: 'POST', path: '/:id/rotate-secret' },
  { method: 'GET', path: '/:id/deliveries' },
]

describe('webhook administration', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/webhooks', webhookRoutes)

  let admin: TestUser
  let reader: TestUser
  let subscriptionId: string
  const cookies = new Map<string, string>()
  let originalKey: string | undefined

  beforeAll(async () => {
    await testDb.setup()
    originalKey = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY
  })

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = originalKey
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    const adminRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`WH Admin ${randomUUID().slice(0, 8)}`, {
        system: ['manage'],
      }),
    )
    // Every verb this instance knows except `system:manage`, so a refusal can
    // only ever be about that one tuple.
    const readerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`WH Reader ${randomUUID().slice(0, 8)}`, {
        parts: ['create', 'read', 'update', 'delete'],
        items: ['create', 'read', 'update', 'delete'],
        programs: ['read'],
      }),
    )

    admin = await insertTestUser(testDb.db)
    reader = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, admin.id, adminRole.id)
    await assignRoleToUser(testDb.db, reader.id, readerRole.id)

    for (const user of [admin, reader]) {
      cookies.set(
        user.id,
        `session=${(await SessionManager.createSession(user.id)).sessionToken}`,
      )
    }

    const [row] = await testDb.db
      .insert(webhookSubscriptions)
      .values({
        name: `fixture-${randomUUID().slice(0, 8)}`,
        targetUrl: 'https://hooks.example.test/fixture',
        eventTypes: [],
        encryptedSecret: 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        secretPrefix: 'cscwh_abc123',
      })
      .returning({ id: webhookSubscriptions.id })
    subscriptionId = row?.id ?? ''
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const url = (path: string) =>
    `/api/v1/webhooks${path.replace(':id', subscriptionId)}`

  function request(
    user: TestUser,
    route: (typeof ROUTES)[number],
    headers: Record<string, string> = {},
  ) {
    return app.request(url(route.path), {
      method: route.method,
      headers: {
        Cookie: cookies.get(user.id) ?? '',
        ...(route.body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
    })
  }

  describe('the gate', () => {
    it.each(ROUTES.map((r) => [`${r.method} ${r.path || '/'}`, r] as const))(
      '%s refuses a session without system:manage',
      async (_label, route) => {
        const response = await request(reader, route)
        expect(response.status).toBe(403)
      },
    )

    it.each(ROUTES.map((r) => [`${r.method} ${r.path || '/'}`, r] as const))(
      '%s refuses an unauthenticated caller',
      async (_label, route) => {
        const response = await app.request(url(route.path), {
          method: route.method,
          ...(route.body
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(route.body),
              }
            : {}),
        })
        expect(response.status).toBe(401)
      },
    )

    it.each(ROUTES.map((r) => [`${r.method} ${r.path || '/'}`, r] as const))(
      '%s admits an administrator',
      async (_label, route) => {
        const response = await request(admin, route)
        expect(response.status).not.toBe(401)
        expect(response.status).not.toBe(403)
      },
    )

    /**
     * A key can only ever narrow. Without the intersection, a key scoped to
     * `{ parts: ['read'] }` would still reach every route here purely because
     * its owner is an administrator.
     */
    it('refuses an administrator API key whose scope excludes system', async () => {
      const { rawKey } = await ApiKeyService.create(admin.id, {
        name: 'narrowed',
        permissions: { parts: ['read'] },
      })

      const response = await app.request(url(''), {
        headers: { Authorization: `Bearer ${rawKey}` },
      })
      expect(response.status).toBe(403)
    })

    it('admits an administrator API key scoped to system:manage', async () => {
      const { rawKey } = await ApiKeyService.create(admin.id, {
        name: 'scoped',
        permissions: { system: ['manage'] },
      })

      const response = await app.request(url(''), {
        headers: { Authorization: `Bearer ${rawKey}` },
      })
      expect(response.status).toBe(200)
    })
  })

  /**
   * The invariant no gate can make. Asserted over the response's own values
   * rather than by naming one field to omit, so a column that later holds the
   * ciphertext under a different name fails this too.
   */
  describe('the projection', () => {
    /** Every string value anywhere in a parsed response body. */
    function stringValues(value: unknown, found: Array<string> = []) {
      if (typeof value === 'string') found.push(value)
      else if (Array.isArray(value)) {
        for (const entry of value) stringValues(entry, found)
      } else if (value && typeof value === 'object') {
        for (const entry of Object.values(value)) stringValues(entry, found)
      }
      return found
    }

    async function storedCiphertext(): Promise<string> {
      const [row] = await testDb.db
        .select({ secret: webhookSubscriptions.encryptedSecret })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, subscriptionId))
      const secret = row?.secret
      if (!secret) throw new Error('fixture has no stored secret')
      return secret
    }

    it('the list response contains no value equal to the stored ciphertext', async () => {
      const ciphertext = await storedCiphertext()
      const response = await request(admin, { method: 'GET', path: '' })
      expect(response.status).toBe(200)

      const values = stringValues(await response.json())
      expect(values.length).toBeGreaterThan(0)
      expect(values).not.toContain(ciphertext)
      // Nor a substring of it, which a partial projection would produce.
      expect(values.some((v) => ciphertext.includes(v) && v.length > 16)).toBe(
        false,
      )
    })

    it('the read response contains no value equal to the stored ciphertext', async () => {
      const ciphertext = await storedCiphertext()
      const response = await request(admin, { method: 'GET', path: '/:id' })
      expect(response.status).toBe(200)

      const values = stringValues(await response.json())
      expect(values).not.toContain(ciphertext)
    })

    it('no read path names a secret-bearing property at all', async () => {
      const response = await request(admin, { method: 'GET', path: '/:id' })
      const body = (await response.json()) as {
        data: { subscription: Record<string, unknown> }
      }
      const keys = Object.keys(body.data.subscription)

      expect(keys).not.toContain('encryptedSecret')
      expect(keys).not.toContain('secret')
      // The display prefix is deliberately present: identification, not a
      // credential.
      expect(keys).toContain('secretPrefix')
    })

    /**
     * Creation is the one response that carries a secret, and it carries the
     * *plaintext* — once — exactly as an API key does. What it must never carry
     * is the stored ciphertext, which is what a careless `returning()` would
     * produce.
     */
    it('creation returns the plaintext once and never the ciphertext', async () => {
      const response = await request(admin, {
        method: 'POST',
        path: '',
        body: { name: 'created', targetUrl: 'https://hooks.example.test/new' },
      })
      expect(response.status).toBe(201)

      const body = (await response.json()) as {
        data: {
          subscription: Record<string, unknown>
          secret: string
        }
      }
      expect(typeof body.data.secret).toBe('string')
      expect(body.data.secret.startsWith('cscwh_')).toBe(true)
      expect(Object.keys(body.data.subscription)).not.toContain(
        'encryptedSecret',
      )

      // And the stored value is not what was returned.
      const [stored] = await testDb.db
        .select({ secret: webhookSubscriptions.encryptedSecret })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, body.data.subscription.id as string))
      expect(stored?.secret).not.toBe(body.data.secret)
      expect(stored?.secret?.startsWith('enc:v1:')).toBe(true)
    })

    it('rotation returns a new plaintext and never the ciphertext', async () => {
      const response = await request(admin, {
        method: 'POST',
        path: '/:id/rotate-secret',
      })
      expect(response.status).toBe(200)

      const body = (await response.json()) as {
        data: { subscription: Record<string, unknown>; secret: string }
      }
      expect(body.data.secret.startsWith('cscwh_')).toBe(true)
      expect(Object.keys(body.data.subscription)).not.toContain(
        'encryptedSecret',
      )
      expect(body.data.secret).not.toBe(await storedCiphertext())
    })
  })

  /**
   * The target URL goes through the egress guard rather than `z.string().url()`,
   * which on this repository's Zod version accepts `file:` and a loopback
   * address with a database port.
   */
  describe('target validation', () => {
    it.each([
      ['https://127.0.0.1/hook'],
      ['https://[::1]/hook'],
      ['https://169.254.169.254/latest/meta-data/'],
      ['file:///etc/passwd'],
      ['http://hooks.example.test/x'],
    ])('refuses %s at creation', async (targetUrl) => {
      const response = await request(admin, {
        method: 'POST',
        path: '',
        body: { name: 'bad-target', targetUrl },
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED)
    })

    it('refuses an unknown event type rather than silently never firing', async () => {
      const response = await request(admin, {
        method: 'POST',
        path: '',
        body: {
          name: 'typo',
          targetUrl: 'https://hooks.example.test/x',
          eventTypes: ['desgin.released'],
        },
      })
      expect(response.status).toBe(400)
    })
  })
})
