// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Session cookie builders with conditional Secure flag.
 *
 * In production, cookies include the Secure flag to ensure
 * they are only sent over HTTPS connections — see `secureCookies()`.
 */

interface CookieOptions {
  name: string
  value: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  maxAge?: number
}

function buildCookie(options: CookieOptions): string {
  const parts = [`${options.name}=${options.value}`]
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  return parts.join('; ')
}

/**
 * Whether cookies carry the Secure flag: in production, unless
 * `COOKIE_SECURE=false` (or `0`) turns it off.
 *
 * A browser discards a Secure cookie set over plain HTTP on any host but
 * localhost, so a deployment served that way — a demo opened by its LAN
 * address, an intranet install with no TLS — answers sign-in with 200, the
 * browser stores nothing, and the next page lands back on /login. Such a
 * deployment has to opt out; one served over HTTPS never should.
 *
 * A variable of its own, because `NODE_ENV` cannot be changed on a built
 * image: the server bundle inlines it at build time (scripts/build-app.mjs)
 * and the production entry sets it before the app loads. Read per call rather
 * than at module load, so a test can flip it in-process.
 */
export function secureCookies(): boolean {
  const raw = process.env.COOKIE_SECURE
  if (raw === 'false' || raw === '0') return false
  return process.env.NODE_ENV === 'production'
}

export function buildSessionCookie(token: string): string {
  return buildCookie({
    name: 'session',
    value: token,
    path: '/',
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'Strict',
    maxAge: 28800,
  })
}

export function buildClearSessionCookie(): string {
  return buildCookie({
    name: 'session',
    value: '',
    path: '/',
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'Strict',
    maxAge: 0,
  })
}
