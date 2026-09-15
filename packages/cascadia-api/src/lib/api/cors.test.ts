// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CORS preflight — the cross-origin access boundary (API2-3).
 *
 * Security gate: the preflight is the only thing a browser asks before it
 * will let a cross-origin request carry credentials, and the answer decides
 * whether an origin reaches the API at all. `apiHandler` used to answer it
 * from inside the wrapper, which route modules never reach with OPTIONS —
 * so every preflight 404'd without a single `Access-Control-*` header and
 * `CORS_ALLOWED_ORIGINS` was inert however it was set. Getting this wrong in
 * the other direction hands an arbitrary origin credentialed access.
 *
 * Invariants:
 *  - the preflight is *reachable* — an app whose routes register concrete
 *    methods only still answers OPTIONS, on any /api/* path
 *  - a listed origin, and the server's own origin, get 204 plus a grant that
 *    echoes the origin and allows credentials
 *  - an unlisted origin gets 204 with no `Access-Control-*` header at all
 *    (fail closed: the browser blocks the real request)
 *  - what the preflight advertises is exactly what the real response carries,
 *    because both are `applySecurityHeaders` over the same request
 *
 * Run: npx vitest run packages/core/src/lib/api/cors.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { applySecurityHeaders, buildPreflightResponse } from './cors'

const HOST = 'http://localhost:3000'
const LISTED = 'https://plm.partner.example'
const UNLISTED = 'https://attacker.example'

/**
 * What `server/index.ts` registers, rebuilt in miniature: the same
 * `app.options('/api/*')` ahead of route groups that — like every real one —
 * register concrete methods only. Composing the real server would drag in the
 * whole route tree and the database for a question about five headers.
 */
function scratchApp() {
  const things = new Hono().get('/:id', (c) => c.json({ data: { ok: true } }))
  const app = new Hono()
  app.options('/api/*', (c) => buildPreflightResponse(c.req.raw))
  app.route('/api/v1/things', things)
  return app
}

/** A browser's preflight: OPTIONS carrying the method it intends to use. */
function preflight(
  app: Hono,
  origin: string | null,
  path = '/api/v1/things/abc',
) {
  const headers: Record<string, string> = {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  }
  if (origin !== null) headers.Origin = origin
  return app.request(`${HOST}${path}`, { method: 'OPTIONS', headers })
}

/** The `Access-Control-*` subset of a response's headers, lowercased. */
function corsHeadersOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('access-control-')) {
      out[key.toLowerCase()] = value
    }
  })
  return out
}

describe('CORS preflight', () => {
  const original = process.env.CORS_ALLOWED_ORIGINS

  beforeEach(() => {
    process.env.CORS_ALLOWED_ORIGINS = `${LISTED}, https://other.example`
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS
    } else {
      process.env.CORS_ALLOWED_ORIGINS = original
    }
  })

  it('grants a listed origin a 204 that echoes it and allows credentials', async () => {
    const response = await preflight(scratchApp(), LISTED)

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(LISTED)
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true',
    )
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'POST',
    )
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain(
      'Content-Type',
    )
  })

  it('gives an unlisted origin a 204 with no Access-Control-* header at all', async () => {
    const response = await preflight(scratchApp(), UNLISTED)

    // Fail closed: 204 is the honest answer to "may I", and the empty grant
    // is what makes the browser refuse to send the real request.
    expect(response.status).toBe(204)
    expect(corsHeadersOf(response)).toEqual({})
  })

  it('grants the server its own origin without any env configuration', async () => {
    delete process.env.CORS_ALLOWED_ORIGINS

    const response = await preflight(scratchApp(), HOST)

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(HOST)
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true',
    )
  })

  it('is reachable although routes register concrete methods only', async () => {
    const app = scratchApp()

    // The regression this whole task exists for: OPTIONS reaching no handler.
    const preflighted = await preflight(app, LISTED)
    expect(preflighted.status).toBe(204)

    // Registering it ahead of the mounts must not shadow the real request.
    const real = await app.request(`${HOST}/api/v1/things/abc`)
    expect(real.status).toBe(200)
  })

  it('answers for a path no route claims, and still lets that path 404', async () => {
    const app = scratchApp()

    // A preflight asks about policy, not about the resource — answering one
    // for a nonexistent path advertises nothing that path can actually do.
    const preflighted = await preflight(app, LISTED, '/api/v1/nonexistent')
    expect(preflighted.status).toBe(204)

    const real = await app.request(`${HOST}/api/v1/nonexistent`)
    expect(real.status).toBe(404)
  })

  it('carries the defense-in-depth security headers', async () => {
    const response = await preflight(scratchApp(), LISTED)

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
  })

  const AGREEMENT_CASES: Array<[string, string | null]> = [
    ['a listed origin', LISTED],
    ['an unlisted origin', UNLISTED],
    ['the server origin', HOST],
    ['no origin at all', null],
  ]

  for (const [label, origin] of AGREEMENT_CASES) {
    it(`advertises to ${label} exactly what the real response carries`, async () => {
      const advertised = corsHeadersOf(await preflight(scratchApp(), origin))

      // The real response for the same request: apiHandler hands back every
      // response — success, error, passthrough — through applySecurityHeaders,
      // so this is the grant the caller would actually be given.
      const headers = new Headers({ 'Access-Control-Request-Method': 'POST' })
      if (origin !== null) headers.set('Origin', origin)
      const request = new Request(`${HOST}/api/v1/things/abc`, { headers })
      const real = applySecurityHeaders(
        new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
        request,
      )

      expect(advertised).toEqual(corsHeadersOf(real))
    })
  }
})
