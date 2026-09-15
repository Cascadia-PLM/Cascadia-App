// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  RateLimiter,
  apiLimiter,
  loginLimiter,
  uploadLimiter,
} from './rate-limit'
import { applySecurityHeaders, getAllowedOrigins } from './cors'
import { resolveClientIp } from './client-ip'
import type { RateLimitConfig } from './rate-limit'
import type { OpenApiMetadata } from './openapi-helpers'
import type { z } from 'zod'
import type { PermissionAction, ResourceType } from '@/lib/auth/permissions'
import type { SessionUser } from '@/lib/auth/session'
import type { AuthMethod } from '@/lib/auth/credentials'
import { resolveCredentials } from '@/lib/auth/credentials'
import { intersectPermissions } from '@/lib/auth/api-key-utils'
import { permissionService } from '@/lib/auth/permission-service'
import { hasPermission } from '@/lib/auth/permissions'
import { db } from '@/lib/db'
import { authEvents } from '@/lib/db/schema/users'
import { ErrorCode } from '@/lib/errors/codes'
import { getRequestId, handleApiError } from '@/lib/errors/handleApiError'
import {
  AppError,
  AuthenticationError,
  RateLimitedError,
  ValidationError,
} from '@/lib/errors'
import { createErrorResponse } from '@/lib/errors/api'

/**
 * Validate the Origin header for state-changing requests (CSRF protection).
 * For non-GET/HEAD/OPTIONS requests, the Origin (or Referer) must match
 * the request's own host or an explicitly allowed origin.
 */
function validateOrigin(request: Request): boolean {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true
  }

  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  const requestUrl = new URL(request.url, 'http://localhost')
  const requestOrigin = requestUrl.origin

  // Determine the claimed origin
  let claimedOrigin: string | null = null
  if (origin) {
    claimedOrigin = origin
  } else if (referer) {
    try {
      claimedOrigin = new URL(referer).origin
    } catch {
      return false
    }
  }

  // If no origin/referer header at all, allow — this happens with
  // same-origin requests from some clients (curl, server-to-server).
  // SameSite=Strict cookies already prevent cross-site cookie attachment.
  if (!claimedOrigin) return true

  // Same-origin is always allowed
  if (claimedOrigin === requestOrigin) return true

  // Check allowed origins from env
  const allowed = getAllowedOrigins()
  if (allowed && allowed.has(claimedOrigin)) return true

  return false
}

interface HandlerOptions<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = unknown,
> {
  /** Permission check: [resource, action]. Omit for auth-only. */
  permission?: [ResourceType, PermissionAction]
  /** Require one authentication method. Omit to accept a session or API key. */
  authMethod?: AuthMethod
  /** Set to true to skip auth entirely (e.g., session check, health). */
  public?: boolean
  /** Rate limit preset or custom config. Defaults to general API limiter. Set 'none' to disable. */
  rateLimit?: 'login' | 'upload' | 'none' | RateLimitConfig
  /**
   * Request-body schema. When set, the body is read, JSON-parsed and validated
   * before the handler runs, and the result arrives as `ctx.body` — so the
   * handler never calls `request.json()` itself, and a body that does not
   * conform never reaches it. A failure is a `ZodError`, which
   * `handleApiError` already turns into the 400 + `fieldErrors` envelope.
   *
   * This is also the documented body: the same schema is written into the
   * route's OpenAPI metadata below, so the spec cannot drift from what runs.
   */
  body?: z.ZodType<TBody>
  /**
   * Query-string schema, the exact counterpart of `body:` above. When set the
   * search params are validated before the handler runs and arrive as
   * `ctx.query`, and the same schema is written into the route's OpenAPI
   * metadata — so the documented contract and the enforced one cannot drift.
   *
   * `parseQuery` has always existed and can be called from inside a handler,
   * which is the whole problem: it is a function you may call, not an option
   * the wrapper acts on, so forgetting it is invisible. The adoption numbers
   * are the argument — `body:` is declared on 281 routes, `parseQuery` on 30,
   * and the gap is ergonomics rather than importance. What the remaining
   * routes do instead is `parseInt(url.searchParams.get('limit') || '50', 10)`,
   * which is how `?limit=abc` put NaN into a LIMIT clause and `?limit=100000`
   * was honoured.
   *
   * Sharper still: `thread.ts` declared a zod query schema with `min(0).max(10)`
   * depths, published those bounds in OpenAPI, and never called `parseQuery` —
   * the document promised a contract nothing enforced. That shape is what this
   * option makes unrepresentable, because declaring the schema *is* enforcing
   * it.
   */
  query?: z.ZodType<TQuery>
  /**
   * Route-level access gate — program membership, design or ECO reach —
   * checked after RBAC and **before the body is read**.
   *
   * RBAC answers "may this role do this verb at all"; this answers "may this
   * user touch this row". The second question needs the route's params, so it
   * used to be the first statement of each handler — which put it *after* the
   * body parse once `body:` existed, and turned a caller with no reach from a
   * 403 into a 400 describing the body they are not allowed to send. Declaring
   * it here makes the ordering structural instead of a convention every author
   * has to remember, and `program-isolation.permissions.test.ts` holds it.
   *
   * Throw to refuse — the `require*Access` helpers in `lib/auth/access` already
   * throw `PermissionDeniedError`, so most gates are a one-line call. Any
   * return value is awaited and discarded: several of those helpers return the
   * scope they resolved, and a handler that needs it calls them again (they
   * are the same query the gate just ran, and correctness beats one round
   * trip here).
   */
  access?: (ctx: {
    request: Request
    params: TParams
    user: SessionUser
    requestId: string
  }) => unknown
  /** Optional OpenAPI metadata; consumed by `adapt()` to attach a describeRoute middleware. */
  openapi?: OpenApiMetadata
}

/** Augmented function shape returned by `apiHandler()`; carries openapi metadata for `adapt()`. */
export type AnnotatedHandler<TParams = Record<string, string>> = ((args: {
  params: TParams
  request: Request
}) => Promise<Response>) & { openapi?: OpenApiMetadata }

interface HandlerContext<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = unknown,
> {
  request: Request
  params: TParams
  /**
   * The validated request body when the route declares `body:`, and
   * `undefined` (typed `unknown`) when it does not. A route that declares a
   * schema must read the body from here: the wrapper has already consumed the
   * stream, so `request.json()` would find it empty.
   */
  body: TBody
  /**
   * The validated query string when the route declares `query:`, and
   * `undefined` (typed `unknown`) when it does not. Unlike the body, the raw
   * search params are still readable from `request.url` — nothing is consumed —
   * so this is a contract rather than a physical constraint. Declaring the
   * schema is what makes the contract enforced instead of merely documented.
   */
  query: TQuery
  user: SessionUser
  requestId: string
}

type HandlerFn<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = unknown,
> = (ctx: HandlerContext<TParams, TBody, TQuery>) => Promise<object | Response>

/**
 * The context a `public: true` route gets: everything a private one gets,
 * except that `user` is `null` — because there is no authenticated user, and
 * a route that skipped auth has no business reading one.
 */
type PublicHandlerFn<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = unknown,
> = (
  ctx: Omit<HandlerContext<TParams, TBody, TQuery>, 'user'> & { user: null },
) => Promise<object | Response>

/**
 * Is the rate limiter armed in this process?
 *
 * Production always. Anywhere else only on an explicit opt-in, because the E2E
 * suite drives `npm run dev` (playwright.config.ts) and a throttled login would
 * make it flake. That gate is narrower than it looks: both editions' built
 * entrypoints hard-set `NODE_ENV='production'` before importing the app, so the
 * only deployment that lands here unarmed is one running the dev server.
 * `RATE_LIMIT_ENFORCE=true` is for exactly that case — a staging box that wants
 * the login budget enforced without pretending to be production.
 *
 * Read per request rather than captured at module load, so a test can arm it
 * in-process and a config change does not need a rebuild to take effect.
 */
function rateLimitingEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.RATE_LIMIT_ENFORCE === 'true'
  )
}

/**
 * Reclassify errors that are really the caller's fault before they reach
 * handleApiError.
 *
 * A malformed request body surfaces as the SyntaxError that
 * `await request.json()` throws inside a handler. Left alone it matches
 * nothing in handleApiError and falls into the unknown-error branch: a 500
 * logged at CRITICAL for what is nothing more than a bad body. The
 * reclassification lives here rather than in handleApiError so it is scoped to
 * API routes — a JSON.parse failure over data we stored ourselves is a genuine
 * 500 and keeps it. The parser's own message is preserved in context so the
 * warn-level log still says where the body went wrong.
 */
function asClientError(error: unknown): unknown {
  if (error instanceof SyntaxError) {
    return new ValidationError('Malformed JSON in request body', undefined, {
      parseError: error.message,
    })
  }
  return error
}

/**
 * Read a request body as JSON for schema validation.
 *
 * `text()` rather than `json()` so an absent body is `undefined` rather than a
 * parse failure: a schema that accepts it (`.optional()`, the shape
 * `POST /files/:id/convert` needs) then runs on its defaults, and one that
 * does not rejects with the same 400 as any other missing field. A body that
 * is present but malformed still throws `SyntaxError`, which `asClientError`
 * reclassifies.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text()
  if (raw === '') return undefined
  return JSON.parse(raw)
}

/**
 * Make the schema that runs be the schema that is documented.
 *
 * The runtime schema wins over anything the annotation declares, keeping the
 * flags around it (`description`, `mediaType`, `required`) — so a route cannot
 * validate one shape and advertise another, which is the state
 * `PUT /parts/:id` was in: an annotation naming `partUpdateSchema` over a
 * handler that took whatever it was sent.
 *
 * The one exception is opt-in and named: an annotation flagged
 * `documentsSupersetOfEnforced` survives verbatim, for the routes whose
 * enforced envelope is deliberately looser than their real contract — see the
 * flag's own doc comment for what that costs. Two routes use it; every other
 * annotation is still overwritten.
 */
function documentBody(
  openapi: OpenApiMetadata,
  body: z.ZodType | undefined,
): OpenApiMetadata {
  if (!body) return openapi
  if (openapi.request?.body?.documentsSupersetOfEnforced) return openapi
  return {
    ...openapi,
    request: {
      ...openapi.request,
      body: { ...openapi.request?.body, schema: body },
    },
  }
}

/**
 * The `documentBody` of query strings: the schema the route enforces is the
 * schema the document publishes.
 *
 * No `documentsSupersetOfEnforced` escape hatch here, deliberately. That flag
 * exists for bodies whose enforced envelope is a deliberate union the route
 * resolves per item type; a query string has no such shape, and the defect this
 * replaces was a route publishing bounds it did not enforce. Adding the opt-out
 * would reintroduce exactly that.
 */
function documentQuery(
  openapi: OpenApiMetadata,
  query: z.ZodType | undefined,
): OpenApiMetadata {
  if (!query) return openapi
  return {
    ...openapi,
    request: { ...openapi.request, query },
  }
}

/**
 * A request's search params as a plain record, for schema parsing.
 *
 * Shared by the `query:` option and `parseQuery` so the two cannot disagree
 * about what "the query string" means — repeated keys collapse to the last
 * occurrence in both, and a schema wanting arrays has to say so itself.
 */
function searchParamsOf(request: Request): Record<string, string> {
  const url = new URL(request.url, 'http://localhost')
  const raw: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    raw[key] = value
  })
  return raw
}

/**
 * Wraps an API handler with auth, error handling, and response serialization.
 *
 * Return an object to auto-serialize as JSON with `{ data: ... }` envelope.
 * Return a Response directly for streaming or custom responses.
 *
 * @example
 * ```typescript
 * GET: apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
 *   const part = await ItemService.findById(params.id)
 *   if (!part) throw new NotFoundError('Part', params.id)
 *   return { part }
 * })
 * ```
 *
 * @example Validating the request body
 * ```typescript
 * PUT: apiHandler<{ id: string }, PartUpdate>(
 *   { permission: ['parts', 'update'], body: partUpdateSchema },
 *   async ({ params, body, user }) => ItemService.update(params.id, body, user.id),
 * )
 * ```
 * Naming `TParams` switches off inference for the rest, so a route with both
 * params and a body names both type arguments; a route with only a body
 * (`apiHandler({ body: schema }, ...)`) has `TBody` inferred from the schema.
 */
export function apiHandler<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = unknown,
>(
  options: HandlerOptions<TParams, TBody, TQuery> & { public: true },
  handler: PublicHandlerFn<TParams, TBody, TQuery>,
): AnnotatedHandler<TParams>
export function apiHandler<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = unknown,
>(
  options: HandlerOptions<TParams, TBody, TQuery>,
  handler: HandlerFn<TParams, TBody, TQuery>,
): AnnotatedHandler<TParams>
export function apiHandler<
  TParams = Record<string, string>,
  TBody = unknown,
  TQuery = unknown,
>(
  options: HandlerOptions<TParams, TBody, TQuery>,
  handler:
    HandlerFn<TParams, TBody, TQuery> | PublicHandlerFn<TParams, TBody, TQuery>,
): AnnotatedHandler<TParams> {
  // Built once per route, not per request. A limiter constructed inside the
  // handler starts every request with an empty window — it can never reject —
  // and its cleanup interval keeps each instance alive, so a custom config
  // leaked one timer per request while limiting nothing.
  const customLimiter =
    options.rateLimit && typeof options.rateLimit === 'object'
      ? new RateLimiter(options.rateLimit)
      : null

  const wrapped: AnnotatedHandler<TParams> = async ({ params, request }) => {
    const requestId = getRequestId(request)
    try {
      // CORS preflight is not handled here: route modules register concrete
      // methods only, so Hono never dispatches OPTIONS to a wrapped handler.
      // The reachable answer is `app.options('/api/*')` in server/index.ts,
      // built by buildPreflightResponse from the same getCorsHeaders that
      // applySecurityHeaders uses below.

      // Rate limiting, keyed on the address the deployment vouches for rather
      // than on whatever the caller wrote in X-Forwarded-For — see
      // lib/api/client-ip. Off outside production unless RATE_LIMIT_ENFORCE
      // says otherwise; see rateLimitingEnabled.
      if (options.rateLimit !== 'none' && rateLimitingEnabled()) {
        let limiter: RateLimiter
        if (options.rateLimit === 'login') {
          limiter = loginLimiter
        } else if (options.rateLimit === 'upload') {
          limiter = uploadLimiter
        } else if (customLimiter) {
          limiter = customLimiter
        } else {
          limiter = apiLimiter
        }
        const clientIp = resolveClientIp(request)
        const result = limiter.check(clientIp)
        if (!result.allowed) {
          throw new RateLimitedError(result.retryAfterSeconds)
        }
      }

      // A public route has no user, and now says so. This was a fabricated
      // SessionUser with an empty-string id and active: false — a value that
      // satisfies `user.id` silently, so a public handler reaching for one
      // would have written rows owned by '' rather than failing to compile.
      let user: SessionUser | null = null

      if (!options.public) {
        // Unified credential resolution: session cookie or API key
        const credentials = await resolveCredentials(request)

        if (!credentials) {
          throw new Response(
            JSON.stringify({
              error: {
                code: ErrorCode.AUTH_REQUIRED,
                message: 'Authentication required',
                timestamp: new Date().toISOString(),
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }

        if (
          options.authMethod &&
          credentials.authMethod !== options.authMethod
        ) {
          const requiredMethod =
            options.authMethod === 'session' ? 'Session' : 'API key'
          throw new AuthenticationError(
            `${requiredMethod} authentication required`,
          )
        }

        user = credentials.user

        // CSRF: only validate Origin for cookie-authenticated requests.
        // API key/bearer token requests skip CSRF because browsers don't
        // auto-attach Authorization headers on cross-origin requests.
        if (credentials.authMethod === 'session' && !validateOrigin(request)) {
          // Built like every other error rather than hand-rolled: this was
          // the one response in the API whose body was a bare string, so a
          // client reading `error.code` — which is every client, and what the
          // document promises — got `undefined` for the one rejection it is
          // most likely to hit while a proxy is misconfigured.
          return applySecurityHeaders(
            createErrorResponse(
              new AppError(
                ErrorCode.PERMISSION_DENIED,
                'Cross-origin request rejected',
                { context: { requestId } },
              ),
              requestId,
            ),
            request,
          )
        }

        // Permission check
        if (options.permission) {
          const [resource, action] = options.permission

          if (credentials.scope) {
            // API key with scope narrowing: intersect key scope with user roles
            const userPermissions = await permissionService.getUserPermissions(
              user.id,
            )
            const effective = intersectPermissions(
              userPermissions,
              credentials.scope,
            )

            if (!hasPermission(effective, resource, action)) {
              await db.insert(authEvents).values({
                userId: user.id,
                eventType: 'permission_denied',
                ipAddress: resolveClientIp(request),
                metadata: {
                  resource,
                  action,
                  authMethod: credentials.authMethod,
                  keyId: credentials.keyId,
                },
              })
              throw new Response(
                JSON.stringify({
                  error: {
                    code: ErrorCode.PERMISSION_DENIED,
                    message: `You do not have permission to ${action} ${resource}`,
                    timestamp: new Date().toISOString(),
                  },
                }),
                {
                  status: 403,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            }
          } else {
            // Session or full-scope API key: check user role permissions directly
            const allowed = await permissionService.canUser(
              user.id,
              action,
              resource,
            )
            if (!allowed) {
              await db.insert(authEvents).values({
                userId: user.id,
                eventType: 'permission_denied',
                ipAddress: resolveClientIp(request),
                metadata: {
                  resource,
                  action,
                  authMethod: credentials.authMethod,
                },
              })
              throw new Response(
                JSON.stringify({
                  error: {
                    code: ErrorCode.PERMISSION_DENIED,
                    message: `You do not have permission to ${action} ${resource}`,
                    timestamp: new Date().toISOString(),
                  },
                }),
                {
                  status: 403,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            }
          }
        }
      }
      // Public routes skip CSRF — no authenticated session to hijack.

      // Row-level reach, before the body is touched: a caller with no reach
      // must not learn the shape of the body from a 400. See `access` above.
      if (options.access) {
        await options.access({
          request,
          params,
          user: user as SessionUser,
          requestId,
        })
      }

      // After auth, permission and access, so a caller who cannot reach the
      // route cannot use the shape of a 400 to learn what it accepts, and
      // before the handler, so nothing downstream sees an unvalidated body.
      const body = options.body
        ? options.body.parse(await readJsonBody(request))
        : (undefined as TBody)

      // Same position as the body, for the same reason: a caller who cannot
      // reach the route must not learn its bounds from a 400.
      const query = options.query
        ? options.query.parse(searchParamsOf(request))
        : (undefined as TQuery)

      const result = await (handler as HandlerFn<TParams, TBody, TQuery>)({
        request,
        params,
        body,
        query,
        // Assigned above for every non-public route — that branch either sets
        // it from resolved credentials or throws — and null for a public one,
        // which is what the public overload tells its handler.
        user: user as SessionUser,
        requestId,
      })

      // If the handler returned a raw Response, pass it through
      if (result instanceof Response)
        return applySecurityHeaders(result, request)

      // Otherwise, serialize as JSON with standard envelope
      return applySecurityHeaders(
        new Response(JSON.stringify({ data: result }), {
          headers: { 'Content-Type': 'application/json' },
        }),
        request,
      )
    } catch (error) {
      return applySecurityHeaders(
        handleApiError(asClientError(error), request, requestId),
        request,
      )
    }
  }
  // A route with a body schema documents it even without any other openapi
  // metadata — enforcement without documentation is the inverse of the drift
  // documentBody exists to prevent.
  if (options.openapi || options.body || options.query)
    wrapped.openapi = documentQuery(
      documentBody(options.openapi ?? {}, options.body),
      options.query,
    )
  return wrapped
}

/**
 * Parse and validate query parameters from a request against a Zod schema.
 *
 * Prefer the `query:` handler option. This is the same parse, but as a call the
 * author has to remember rather than a declaration the wrapper acts on, and it
 * writes nothing into the OpenAPI document — so a route using it can publish
 * bounds it does not enforce, which is the defect `query:` exists to remove.
 * Kept for the cases the option cannot serve: a handler that parses the query
 * more than once, or against a schema chosen at request time.
 *
 * @example
 * ```typescript
 * const query = parseQuery(request, paginationSchema)
 * // query.limit is number (default 50), query.offset is number (default 0)
 * ```
 */
export function parseQuery<T extends z.ZodType>(
  request: Request,
  schema: T,
): z.infer<T> {
  return schema.parse(searchParamsOf(request))
}

/**
 * Return a 201 Created JSON response with standard `{ data }` envelope.
 */
export function created(data: object): Response {
  return applySecurityHeaders(
    new Response(JSON.stringify({ data }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

/**
 * Return a JSON response with a custom status code and `{ data }` envelope.
 * Useful for multi-status (207) batch responses.
 */
export function jsonResponse(data: object, status = 200): Response {
  return applySecurityHeaders(
    new Response(JSON.stringify({ data }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

export type { HandlerOptions, HandlerContext, HandlerFn }
