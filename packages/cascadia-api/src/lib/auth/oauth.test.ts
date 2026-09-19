// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Google sign-in domain restriction.
 *
 * Security gate: this check is the only thing between a successful Google
 * sign-in and an auto-provisioned account. The invariants are that an
 * unconfigured restriction admits everyone (the GitHub posture), and a
 * configured one admits only accounts Google itself places in a listed
 * Workspace — never on the strength of the email address alone.
 *
 * Run: npm run test -- src/lib/auth/oauth.test.ts
 */

import { afterEach, describe, expect, it } from 'vitest'
import { getAllowedGoogleDomains, isGoogleAccountPermitted } from './oauth'

describe('isGoogleAccountPermitted', () => {
  it('admits any account when no domains are configured', () => {
    expect(isGoogleAccountPermitted('example.com', [])).toBe(true)
    expect(isGoogleAccountPermitted(undefined, [])).toBe(true)
  })

  it('admits an account whose hd is on the list', () => {
    expect(isGoogleAccountPermitted('example.com', ['example.com'])).toBe(true)
    expect(
      isGoogleAccountPermitted('example.org', ['example.com', 'example.org']),
    ).toBe(true)
  })

  it('rejects an account whose hd is not on the list', () => {
    expect(isGoogleAccountPermitted('other.com', ['example.com'])).toBe(false)
  })

  it('rejects a personal account, which carries no hd', () => {
    // A consumer account with an alias at the domain would arrive this way.
    expect(isGoogleAccountPermitted(undefined, ['example.com'])).toBe(false)
    expect(isGoogleAccountPermitted('', ['example.com'])).toBe(false)
  })

  it('matches case-insensitively', () => {
    expect(isGoogleAccountPermitted('Example.COM', ['example.com'])).toBe(true)
  })
})

describe('getAllowedGoogleDomains', () => {
  const original = process.env.GOOGLE_ALLOWED_DOMAINS

  afterEach(() => {
    if (original === undefined) delete process.env.GOOGLE_ALLOWED_DOMAINS
    else process.env.GOOGLE_ALLOWED_DOMAINS = original
  })

  it('is empty when unset or blank', () => {
    delete process.env.GOOGLE_ALLOWED_DOMAINS
    expect(getAllowedGoogleDomains()).toEqual([])
    process.env.GOOGLE_ALLOWED_DOMAINS = ' , '
    expect(getAllowedGoogleDomains()).toEqual([])
  })

  it('splits on commas, trims, and lowercases', () => {
    process.env.GOOGLE_ALLOWED_DOMAINS = ' Example.com, example.org ,'
    expect(getAllowedGoogleDomains()).toEqual(['example.com', 'example.org'])
  })
})
