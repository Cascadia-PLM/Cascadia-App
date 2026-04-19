// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import {
  RateLimiter,
  apiLimiter,
  getClientIp,
  loginLimiter,
  uploadLimiter,
} from './rate-limit'
import type { RateLimitConfig } from './rate-limit'
import type { z } from 'zod'
import type { PermissionAction, ResourceType } from '@/lib/auth/permissions'
import type { SessionUser } from '@/lib/auth/session'
import { resolveCredentials } from '@/lib/auth/credentials'
import { intersectPermissions } from '@/lib/auth/api-key-utils'
import { permissionService } from '@/lib/auth/permission-service'
import { hasPermission } from '@/lib/auth/permissions'
import { db } from '@/lib/db'
import { authEvents } from '@/lib/db/schema/users'
import { ErrorCode } from '@/lib/errors/codes'
import { getRequestId, handleApiError } from '@/lib/errors/handleApiError'
import { RateLimitedError } from '@/lib/errors'

/**
 * Security headers applied to all API responses as defense-in-depth.
 * CSP and HSTS are left to the reverse proxy / ingress for proper tuning.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

/**
 * Parse allowed origins from CORS_ALLOWED_ORIGINS env var.
 * Returns null if not set (same-origin only).
 */
function getAllowedOrigins(): Set<string> | null {
  const raw = process.env.CORS_ALLOWED_ORIGINS
  if (!raw) return null
  return new Set(
    raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )
}

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

/**
 * Build CORS headers for a request. Same-origin only by default;
 * set CORS_ALLOWED_ORIGINS env var to allow specific external origins.
 */
function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  if (!origin) return {}

  const requestUrl = new URL(request.url, 'http://localhost')

  // Same-origin always allowed
  if (origin === requestUrl.origin) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    }
  }

  // Check env-configured allowed origins
  const allowed = getAllowedOrigins()
  if (allowed && allowed.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    }
  }

  // Origin not allowed — omit CORS headers (browser will block)
  return {}
}

function applySecurityHeaders(response: Response, request?: Request): Response {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(key)) {
      response.headers.set(key, value)
    }
  }
  if (request) {
    for (const [key, value] of Object.entries(getCorsHeaders(request))) {
      if (!response.headers.has(key)) {
        response.headers.set(key, value)
      }
    }
  }
  return response
}

interface HandlerOptions {
  /** Permission check: [resource, action]. Omit for auth-only. */
  permission?: [ResourceType, PermissionAction]
  /** Set to true to skip auth entirely (e.g., session check, health). */
  public?: boolean
  /** Rate limit preset or custom config. Defaults to general API limiter. Set 'none' to disable. */
  rateLimit?: 'login' | 'upload' | 'none' | RateLimitConfig
}

interface HandlerContext<TParams = Record<string, string>> {
  request: Request
  params: TParams
  user: SessionUser
  requestId: string
}

type HandlerFn<TParams = Record<string, string>> = (
  ctx: HandlerContext<TParams>,
) => Promise<object | Response>

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
 */
export function apiHandler<TParams = Record<string, string>>(
  options: HandlerOptions,
  handler: HandlerFn<TParams>,
) {
  return async ({ params, request }: { params: TParams; request: Request }) => {
    const requestId = getRequestId(request)
    try {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return applySecurityHeaders(
          new Response(null, { status: 204 }),
          request,
        )
      }

      // Rate limiting (IP-based) — disabled outside production to avoid E2E test flakiness
      if (
        options.rateLimit !== 'none' &&
        process.env.NODE_ENV === 'production'
      ) {
        let limiter: RateLimiter
        if (options.rateLimit === 'login') {
          limiter = loginLimiter
        } else if (options.rateLimit === 'upload') {
          limiter = uploadLimiter
        } else if (options.rateLimit && typeof options.rateLimit === 'object') {
          limiter = new RateLimiter(options.rateLimit)
        } else {
          limiter = apiLimiter
        }
        const clientIp = getClientIp(request)
        const result = limiter.check(clientIp)
        if (!result.allowed) {
          throw new RateLimitedError(result.retryAfterSeconds)
        }
      }

      const placeholderUser: SessionUser = {
        id: '',
        email: '',
        active: false,
      }
      let user: SessionUser = placeholderUser

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

        user = credentials.user

        // CSRF: only validate Origin for cookie-authenticated requests.
        // API key/bearer token requests skip CSRF because browsers don't
        // auto-attach Authorization headers on cross-origin requests.
        if (credentials.authMethod === 'session' && !validateOrigin(request)) {
          return applySecurityHeaders(
            new Response(
              JSON.stringify({ error: 'Cross-origin request rejected' }),
              { status: 403, headers: { 'Content-Type': 'application/json' } },
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
                ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
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
                ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
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

      const result = await handler({ request, params, user, requestId })

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
        handleApiError(error, request, requestId),
        request,
      )
    }
  }
}

/**
 * Parse and validate query parameters from a request against a Zod schema.
 * Returns typed, validated params with defaults applied.
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
  const url = new URL(request.url, 'http://localhost')
  const raw: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    raw[key] = value
  })
  return schema.parse(raw)
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
