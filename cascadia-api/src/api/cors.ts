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
 *
 * It also decides what "same origin" means. `requestOrigin` is this server's
 * own origin as the browser sees it, and `validateOrigin` in `handler.ts`
 * compares against the same function, so the CSRF check and the CORS grant
 * cannot disagree about which origin is this one. A proxy fix applied to one
 * and not the other would have the browser send a write the server then
 * refuses, or grant an origin the write check turns away.
 */

import { trustedProxyCount } from './client-ip'

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
 * The scheme the deployment's proxy says the browser used, or `null` when
 * there is no answer worth believing.
 *
 * `X-Forwarded-Proto` is a request header, so a caller can send one: it is
 * exactly as forgeable as `X-Forwarded-For`. It is therefore read only when
 * `TRUSTED_PROXY_COUNT` declares a proxy in front (see `./client-ip`). A
 * deployment that has not declared one ignores it and keeps the scheme of its
 * own connection, which is all it had before this header was read.
 *
 * The rightmost entry is taken because the proxy this process talks to wrote
 * it. Anything to its left arrived from further out, which is where the
 * client is. That is also why it is the rightmost entry and not, as with
 * `X-Forwarded-For`, the one `TRUSTED_PROXY_COUNT` hops from the right: nginx's
 * `proxy_set_header`, Caddy and Traefik all *set* this header rather than
 * append to it, so a chain of any depth normally delivers a single entry,
 * written by the innermost hop, and indexing by depth would read past it.
 *
 * Only `http` and `https` are accepted. Anything else is ignored rather than
 * interpolated, because the result becomes part of the origin a CSRF check
 * compares against: `https://evil.example/` spliced in front of a host parses
 * as the origin `https://evil.example`.
 */
function forwardedScheme(request: Request): 'http' | 'https' | null {
  if (trustedProxyCount() === 0) return null

  const header = request.headers.get('x-forwarded-proto')
  if (header === null) return null

  // lastIndexOf is -1 for a single entry, so the slice takes the whole value.
  const scheme = header
    .slice(header.lastIndexOf(',') + 1)
    .trim()
    .toLowerCase()
  return scheme === 'http' || scheme === 'https' ? scheme : null
}

/**
 * The origin this request was addressed to: what a same-origin browser puts
 * in `Origin`, and the one origin both the CSRF check and the CORS grant treat
 * as this server's own.
 *
 * `request.url` alone is not that. `@hono/node-server` rebuilds it from the
 * `Host` header and the scheme of the socket the request arrived on, and a
 * TLS-terminating reverse proxy speaks plain HTTP to the app. Behind one, the
 * browser sends `Origin: https://plm.example.com` while `request.url` says
 * `http://plm.example.com`; the two differ by scheme alone, and every
 * cookie-authenticated write was refused as cross-origin. Only writes: safe
 * methods skip the check and login is a public route, so the deployment
 * looked healthy right up to its first save.
 *
 * The scheme comes from `X-Forwarded-Proto` when a trusted proxy supplied one
 * (`forwardedScheme`). The host still comes from `Host`, so the proxy must
 * pass it through unchanged, as nginx does with `proxy_set_header Host $host`
 * and Caddy does by default. `X-Forwarded-Host` is deliberately not read: the
 * host is the part of an origin that names the site, the common proxies can
 * all preserve `Host`, and believing a second header for it would widen what
 * `TRUSTED_PROXY_COUNT` vouches for with no deployment needing it.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url, 'http://localhost')
  const scheme = forwardedScheme(request)
  if (scheme === null) return url.origin
  // Rebuilt through URL rather than concatenated, so a default port drops out
  // the way a browser writes it: `host:443` under https is plain `host`.
  return new URL(`${scheme}://${url.host}`).origin
}

/**
 * Build CORS headers for a request. Same-origin only by default;
 * set CORS_ALLOWED_ORIGINS env var to allow specific external origins.
 */
export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  if (!origin) return {}

  // Same-origin always allowed
  if (origin === requestOrigin(request)) return allowOrigin(origin)

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
