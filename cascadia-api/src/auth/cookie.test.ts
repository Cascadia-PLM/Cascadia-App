// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The session cookie's Secure flag.
 *
 * Security gate: Secure is what keeps the session token off plain HTTP. The
 * invariants are that a production cookie carries it unless the deployment
 * opts out by name, that anything short of that opt-out fails closed, and that
 * opting out drops Secure alone — never HttpOnly or SameSite.
 *
 * Run: npx vitest run cascadia-api/src/auth/cookie.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildClearSessionCookie, buildSessionCookie } from './cookie'

const attributes = (cookie: string) => cookie.split('; ').slice(1)

describe('session cookie Secure flag', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalCookieSecure = process.env.COOKIE_SECURE

  beforeEach(() => {
    process.env.NODE_ENV = 'production'
    delete process.env.COOKIE_SECURE
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    if (originalCookieSecure === undefined) delete process.env.COOKIE_SECURE
    else process.env.COOKIE_SECURE = originalCookieSecure
  })

  it('is set in production when COOKIE_SECURE is unset or blank', () => {
    expect(attributes(buildSessionCookie('t'))).toContain('Secure')
    expect(attributes(buildClearSessionCookie())).toContain('Secure')
    process.env.COOKIE_SECURE = ''
    expect(attributes(buildSessionCookie('t'))).toContain('Secure')
  })

  it('stays set for any value other than false or 0', () => {
    for (const value of ['true', '1', 'no', 'FALSE', 'off']) {
      process.env.COOKIE_SECURE = value
      expect(attributes(buildSessionCookie('t'))).toContain('Secure')
    }
  })

  it('is dropped by COOKIE_SECURE=false or 0, and nothing else is', () => {
    for (const value of ['false', '0']) {
      process.env.COOKIE_SECURE = value
      for (const cookie of [
        buildSessionCookie('t'),
        buildClearSessionCookie(),
      ]) {
        const attrs = attributes(cookie)
        expect(attrs).not.toContain('Secure')
        expect(attrs).toContain('HttpOnly')
        expect(attrs).toContain('SameSite=Strict')
      }
    }
  })

  it('is not set outside production', () => {
    process.env.NODE_ENV = 'development'
    expect(attributes(buildSessionCookie('t'))).not.toContain('Secure')
  })
})
