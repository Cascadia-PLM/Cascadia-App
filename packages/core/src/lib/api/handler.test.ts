// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * apiHandler — request bodies
 *
 * Security gate: apiHandler is the choke point every API route passes
 * through, so what it does with an unrecognized throw decides the status
 * code and log severity of ~155 raw `await request.json()` call sites. A
 * malformed body used to reach handleApiError's unknown-error branch and
 * come back as a 500 logged at CRITICAL — an unauthenticated caller could
 * fill the error log with criticals by sending garbage. The `body:` option
 * is the other half: it decides whether a route's declared schema is
 * enforced or merely advertised.
 *
 * Invariants: a body that does not parse is the caller's fault (400,
 * VALIDATION_FAILED); a body that does parse still reaches the handler
 * untouched; a declared schema rejects what does not conform before the
 * handler runs and is the schema the document shows unless the annotation
 * opts out by name; and a route that declares no schema is untouched by any
 * of it.
 *
 * Run: npx vitest run packages/core/src/lib/api/handler.test.ts
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
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { apiHandler } from './handler'
import { errorResponseSchema } from './openapi-helpers'
import { adapt } from '@/server/adapter'
import { ErrorCode } from '@/lib/errors/codes'
import { PermissionDeniedError } from '@/lib/errors'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { SessionManager } from '@/lib/auth/session'
import { authEvents } from '@/lib/db/schema/users'

/**
 * A public route so the test exercises body handling alone — auth and CSRF
 * are other tasks' concerns and would only add fixtures here.
 */
function appWithEchoRoute() {
  return new Hono().post(
    '/echo',
    adapt(
      apiHandler({ public: true }, async ({ request }) => {
        const body = (await request.json()) as { name?: string }
        return { echoed: body.name }
      }),
    ),
  )
}

interface ErrorEnvelope {
  error: { code: string; message: string }
}

describe('apiHandler request bodies', () => {
  const post = (body: string) =>
    appWithEchoRoute().request('/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

  it('rejects a malformed body as a client error, not a server error', async () => {
    const response = await post('{bad json')

    expect(response.status).toBe(400)
    const payload = (await response.json()) as ErrorEnvelope
    expect(payload.error.code).toBe(ErrorCode.VALIDATION_FAILED)
    // The documented envelope describes this response, field for field.
    expect(() => errorResponseSchema.parse(payload)).not.toThrow()
  })

  it('still passes a well-formed body to the handler', async () => {
    const response = await post(JSON.stringify({ name: 'widget' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { echoed: 'widget' } })
  })

  it('leaves non-parse failures classified as server errors', async () => {
    const app = new Hono().post(
      '/boom',
      adapt(
        apiHandler({ public: true }, () =>
          Promise.reject(new Error('handler blew up')),
        ),
      ),
    )

    const response = await app.request('/boom', { method: 'POST' })

    expect(response.status).toBe(500)
    const payload = (await response.json()) as ErrorEnvelope
    expect(payload.error.code).toBe(ErrorCode.INTERNAL_ERROR)
  })
})

const widgetSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().optional(),
})

interface ValidationEnvelope {
  error: {
    code: string
    fieldErrors?: Array<{ field: string; message: string }>
  }
}

describe('apiHandler body schemas', () => {
  const appWithSchema = () =>
    new Hono().post(
      '/widgets',
      adapt(
        apiHandler(
          { public: true, body: widgetSchema },
          // No annotation, no cast: `body` is typed from the schema alone.
          ({ body }) => Promise.resolve({ name: body.name.toUpperCase() }),
        ),
      ),
    )

  const post = (body: string) =>
    appWithSchema().request('/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

  it('rejects a non-conforming body with 400 and per-field errors', async () => {
    const response = await post(JSON.stringify({ count: 3 }))

    expect(response.status).toBe(400)
    const payload = (await response.json()) as ValidationEnvelope
    expect(payload.error.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(payload.error.fieldErrors).toContainEqual(
      expect.objectContaining({ field: 'name' }),
    )
  })

  it('rejects a missing body against a schema that requires one', async () => {
    const response = await appWithSchema().request('/widgets', {
      method: 'POST',
    })

    expect(response.status).toBe(400)
  })

  it('hands the parsed value to the handler', async () => {
    const response = await post(JSON.stringify({ name: 'widget', count: 3 }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { name: 'WIDGET' } })
  })

  it('strips keys the schema does not declare', async () => {
    const app = new Hono().post(
      '/widgets',
      adapt(
        apiHandler({ public: true, body: widgetSchema }, ({ body }) =>
          Promise.resolve({ received: body }),
        ),
      ),
    )

    const response = await app.request('/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'widget', itemNumber: 'SMUGGLED' }),
    })

    expect(await response.json()).toEqual({
      data: { received: { name: 'widget' } },
    })
  })

  it('runs an optional schema on its defaults when the body is absent', async () => {
    const app = new Hono().post(
      '/convert',
      adapt(
        apiHandler(
          {
            public: true,
            body: z.object({ format: z.string().default('glb') }).optional(),
          },
          ({ body }) => Promise.resolve({ format: body?.format ?? 'glb' }),
        ),
      ),
    )

    const response = await app.request('/convert', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { format: 'glb' } })
  })

  it('leaves a route that declares no schema reading its own body', async () => {
    const handler = apiHandler({ public: true }, async ({ request, body }) => {
      expect(body).toBeUndefined()
      return (await request.json()) as object
    })

    const response = await new Hono()
      .post('/echo', adapt(handler))
      .request('/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ untouched: true }),
      })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { untouched: true } })
    expect(handler.openapi).toBeUndefined()
  })

  it('documents the schema it enforces', () => {
    const handler = apiHandler(
      { public: true, body: widgetSchema, openapi: { summary: 'Add widget' } },
      () => Promise.resolve({}),
    )

    expect(handler.openapi?.request?.body?.schema).toBe(widgetSchema)
    expect(handler.openapi?.summary).toBe('Add widget')
  })

  it('overrides an annotation that names a different schema', () => {
    const handler = apiHandler(
      {
        public: true,
        body: widgetSchema,
        openapi: {
          request: {
            body: { schema: z.object({ stale: z.string() }), required: false },
          },
        },
      },
      () => Promise.resolve({}),
    )

    // The runtime schema wins; the flags around it survive.
    expect(handler.openapi?.request?.body?.schema).toBe(widgetSchema)
    expect(handler.openapi?.request?.body?.required).toBe(false)
  })

  it('keeps an annotation that declares itself a superset of the enforced envelope', () => {
    // The two routes whose enforced envelope is deliberately looser than
    // their contract — POST /items and POST /relationships/batch-create —
    // opt out by name so the document keeps the richer shape. Every body
    // this one describes is one `widgetSchema` accepts, which is the
    // condition the flag asserts.
    const documented = z.object({
      name: z.string().min(1),
      count: z.number().int(),
    })
    const handler = apiHandler(
      {
        public: true,
        body: widgetSchema,
        openapi: {
          request: {
            body: {
              schema: documented,
              documentsSupersetOfEnforced: true,
              description: 'Superset',
            },
          },
        },
      },
      () => Promise.resolve({}),
    )

    expect(handler.openapi?.request?.body?.schema).toBe(documented)
    expect(handler.openapi?.request?.body?.description).toBe('Superset')
  })

  it('still enforces the runtime schema for a superset annotation', async () => {
    const app = new Hono().post(
      '/widgets',
      adapt(
        apiHandler(
          {
            public: true,
            body: widgetSchema,
            openapi: {
              request: {
                body: {
                  schema: z.object({ name: z.string() }),
                  documentsSupersetOfEnforced: true,
                },
              },
            },
          },
          ({ body }) => Promise.resolve({ received: body }),
        ),
      ),
    )

    const response = await app.request('/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 3 }),
    })

    expect(response.status).toBe(400)
  })
})

describe('apiHandler access gates', () => {
  const gated = (gate: () => void) =>
    new Hono().post(
      '/widgets/:id',
      adapt(
        apiHandler<{ id: string }, { name: string }>(
          {
            public: true,
            body: z.object({ name: z.string() }),
            access: gate,
          },
          ({ body }) => Promise.resolve({ name: body.name }),
        ),
      ),
    )

  const post = (app: Hono, body?: string) =>
    app.request('/widgets/abc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

  it('runs the gate before the body is parsed', async () => {
    // The invariant, and the whole reason `access` exists: a caller who
    // cannot reach the row must not learn what the body looks like. The body
    // here would fail validation, so a 400 would prove the gate ran second.
    const response = await post(
      gated(() => {
        throw new PermissionDeniedError('widgets', 'update')
      }),
      JSON.stringify({ nonsense: true }),
    )

    expect(response.status).toBe(403)
  })

  it('parses the body for a caller the gate lets through', async () => {
    const response = await post(
      gated(() => undefined),
      JSON.stringify({ nonsense: true }),
    )

    expect(response.status).toBe(400)
  })

  it('gets the route params the gate needs to answer', async () => {
    const seen: Array<string> = []
    const response = await post(
      new Hono().post(
        '/widgets/:id',
        adapt(
          apiHandler<{ id: string }>(
            {
              public: true,
              access: ({ params }) => {
                seen.push(params.id)
              },
            },
            () => Promise.resolve({ ok: true }),
          ),
        ),
      ),
    )

    expect(response.status).toBe(200)
    expect(seen).toEqual(['abc'])
  })

  it('awaits an async gate rather than racing it', async () => {
    const response = await post(
      gated(async () => {
        await Promise.resolve()
        throw new PermissionDeniedError('widgets', 'update')
      }),
      JSON.stringify({ name: 'widget' }),
    )

    expect(response.status).toBe(403)
  })
})

describe('apiHandler public routes', () => {
  it('hands a public route a null user', async () => {
    const app = new Hono().get(
      '/whoami',
      adapt(
        apiHandler({ public: true }, ({ user }) => Promise.resolve({ user })),
      ),
    )

    const response = await app.request('/whoami')

    expect(response.status).toBe(200)
    // Not a fabricated SessionUser with an empty-string id and active: false,
    // which is what a public handler used to receive.
    expect(await response.json()).toEqual({ data: { user: null } })
  })

  it('refuses to let a public route read a user', () => {
    // Never invoked: the assertion is the directive inside it. Reading a field
    // off `user` in a public route must not typecheck, and if it ever starts
    // to, tsc fails on an unused @ts-expect-error — which is what pins the
    // guarantee, since a runtime test could only observe the null.
    const reachesForAUser = () =>
      apiHandler({ public: true }, ({ user }) => {
        // @ts-expect-error - a public route has no user to read
        void user.id
        return Promise.resolve({})
      })

    expect(reachesForAUser).toBeTypeOf('function')
  })
})

describe('apiHandler cross-origin rejection', () => {
  const testDb = new TestDatabase()
  let cookie: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    const user = await insertTestUser(testDb.db)
    const { sessionToken } = await SessionManager.createSession(user.id)
    cookie = `session=${sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const app = () =>
    new Hono().post(
      '/thing',
      adapt(apiHandler({}, () => Promise.resolve({ ok: true }))),
    )

  it('rejects a cross-origin cookie request in the standard envelope', async () => {
    const response = await app().request('/thing', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    })

    expect(response.status).toBe(403)
    const payload = await response.json()
    // Was a bare `{ error: 'Cross-origin request rejected' }` — the one
    // response in the API a client could not read `error.code` from.
    expect(() => errorResponseSchema.parse(payload)).not.toThrow()
    expect((payload as ErrorEnvelope).error.code).toBe(
      ErrorCode.PERMISSION_DENIED,
    )
  })

  it('lets a same-origin cookie request through', async () => {
    const response = await app().request('/thing', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
    })

    expect(response.status).toBe(200)
  })
})

/**
 * The login budget, and what it is spent against (API2-4).
 *
 * Security gate: the limiter used to key on the leftmost `X-Forwarded-For`
 * entry, which is a value the caller writes — so ten attempts a minute was ten
 * attempts *per header the attacker felt like sending*, i.e. no limit at all.
 * The budget only means something if a caller cannot vary its key.
 */
describe('apiHandler login rate limiting', () => {
  const originalEnforce = process.env.RATE_LIMIT_ENFORCE
  const originalDepth = process.env.TRUSTED_PROXY_COUNT

  beforeEach(() => {
    // The gate is `NODE_ENV === 'production' || RATE_LIMIT_ENFORCE === 'true'`.
    // A test process is not production, so it opts in the way a staging
    // deployment running the dev server would.
    process.env.RATE_LIMIT_ENFORCE = 'true'
    delete process.env.TRUSTED_PROXY_COUNT
  })

  afterEach(() => {
    if (originalEnforce === undefined) {
      delete process.env.RATE_LIMIT_ENFORCE
    } else {
      process.env.RATE_LIMIT_ENFORCE = originalEnforce
    }
    if (originalDepth === undefined) {
      delete process.env.TRUSTED_PROXY_COUNT
    } else {
      process.env.TRUSTED_PROXY_COUNT = originalDepth
    }
  })

  /** `RATE_LIMIT_LOGIN_PER_MINUTE`'s default, read once at module load. */
  const LOGIN_BUDGET = 10

  it('spends one budget however the caller varies X-Forwarded-For', async () => {
    const app = new Hono().post(
      '/login',
      adapt(
        apiHandler({ public: true, rateLimit: 'login' }, () =>
          Promise.resolve({ ok: true }),
        ),
      ),
    )
    // Every attempt claims a different origin address. With trust depth 0 they
    // all resolve to the same key, so they draw on the same budget.
    const attempt = (n: number) =>
      app.request('/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': `203.0.113.${n}` },
      })

    const spent = []
    for (let n = 1; n <= LOGIN_BUDGET; n++) {
      spent.push((await attempt(n)).status)
    }
    expect(spent).toEqual(Array<number>(LOGIN_BUDGET).fill(200))

    const rejected = await attempt(LOGIN_BUDGET + 1)

    expect(rejected.status).toBe(429)
    const payload = (await rejected.json()) as ErrorEnvelope
    expect(payload.error.code).toBe(ErrorCode.RATE_LIMITED)
  })
})

/**
 * What the audit trail records as the caller's address (API2-4).
 *
 * Every `auth_events` row used to carry the raw `X-Forwarded-For` header, so
 * an investigation into a permission probe read back whatever address the
 * prober chose to type.
 */
describe('apiHandler auth-event addresses', () => {
  const testDb = new TestDatabase()
  const originalDepth = process.env.TRUSTED_PROXY_COUNT
  const SPOOFED = '192.0.2.66'
  const REAL_CLIENT = '203.0.113.7'
  let userId: string
  let cookie: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    const user = await insertTestUser(testDb.db)
    userId = user.id
    const { sessionToken } = await SessionManager.createSession(user.id)
    cookie = `session=${sessionToken}`
    // One proxy in front: the entry it appended is what it saw, and everything
    // to the left of that is the caller's invention.
    process.env.TRUSTED_PROXY_COUNT = '1'
  })

  afterEach(async () => {
    await testDb.rollback()
    if (originalDepth === undefined) {
      delete process.env.TRUSTED_PROXY_COUNT
    } else {
      process.env.TRUSTED_PROXY_COUNT = originalDepth
    }
  })

  it('records the resolved address rather than the header the caller wrote', async () => {
    // A user with no roles reaching for a permissioned route: the denial is
    // what writes the row.
    const app = new Hono().get(
      '/parts/:id',
      adapt(
        apiHandler<{ id: string }>({ permission: ['parts', 'delete'] }, () =>
          Promise.resolve({ ok: true }),
        ),
      ),
    )

    const response = await app.request('/parts/abc', {
      headers: { cookie, 'x-forwarded-for': `${SPOOFED}, ${REAL_CLIENT}` },
    })
    expect(response.status).toBe(403)

    const rows = await testDb.db
      .select()
      .from(authEvents)
      .where(eq(authEvents.userId, userId))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.eventType).toBe('permission_denied')
    expect(rows[0]?.ipAddress).toBe(REAL_CLIENT)
  })
})
