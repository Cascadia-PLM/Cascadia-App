// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Cross-origin policy, and the response headers that carry it.
 *
 * One module answers "which headers does this request's response carry": the
 * fixed security headers, plus the CORS headers derived from the request's
 * `Origin`. `apiHandler` stamps them onto every real response through
 * `applySecurityHeaders`, and the `/api/*` preflight registered in
 * `server/index.ts` answers with `buildPreflightResponse` — which is that same
 * function over an empty 204. A preflight therefore cannot advertise a policy
 * the matching real response would then fail to honour: they are one code
 * path, not two that have to be kept in step.
 *
 * This lives beside `handler.ts` rather than inside it because the preflight
 * has to be mounted on the server, and mounting it from `handler.ts` would
 * make the route composition root import the request wrapper.
 */

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
 *
 * Read on every call rather than cached at module load: this is deployment
 * configuration, and freezing it at import time would make the policy
 * un-overridable from a test and un-reloadable from a restart-free config
 * change.
 */
export function getAllowedOrigins(): Set<string> | null {
  const raw = process.env.CORS_ALLOWED_ORIGINS
  if (!raw) return null
  return new Set(
    raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )
}

/** The grant an origin gets once the policy has allowed it. */
function allowOrigin(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

/**
 * Build CORS headers for a request. Same-origin only by default;
 * set CORS_ALLOWED_ORIGINS env var to allow specific external origins.
 */
export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  if (!origin) return {}

  const requestUrl = new URL(request.url, 'http://localhost')

  // Same-origin always allowed
  if (origin === requestUrl.origin) return allowOrigin(origin)

  // Check env-configured allowed origins
  const allowed = getAllowedOrigins()
  if (allowed?.has(origin)) return allowOrigin(origin)

  // Origin not allowed — omit CORS headers (browser will block)
  return {}
}

/**
 * Put the security headers, and this request's CORS grant, on a response.
 *
 * Existing headers win: a handler that set one deliberately keeps it.
 */
export function applySecurityHeaders(
  response: Response,
  request?: Request,
): Response {
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

/**
 * Answer a CORS preflight: 204 with whatever grant this origin has earned.
 *
 * `apiHandler` used to carry an `if (request.method === 'OPTIONS')` branch,
 * but route modules register concrete methods only (`app.get`, `app.post`, …),
 * so Hono dispatched OPTIONS to none of them and the branch was unreachable:
 * a browser's preflight 404'd with no `Access-Control-*` headers, and
 * `CORS_ALLOWED_ORIGINS` could never take effect however it was set. The
 * answer therefore has to be mounted on the server itself — see the
 * `app.options('/api/*')` registration in `server/index.ts`.
 *
 * An origin the policy does not allow gets a 204 carrying no
 * `Access-Control-*` headers at all, and the browser blocks the real request.
 * That is the intended fail-closed answer, and it is the same answer
 * `applySecurityHeaders` would have given the real response.
 */
export function buildPreflightResponse(request: Request): Response {
  return applySecurityHeaders(new Response(null, { status: 204 }), request)
}
