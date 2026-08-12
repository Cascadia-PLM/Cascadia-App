// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * API key scope tests.
 *
 * Security gate: these functions decide what a key may do. The invariant that
 * matters is *narrowing only* — a key must never let its bearer do something
 * its owner could not, on either axis (permissions or roles), and must never
 * outlive what the instance policy allows.
 *
 * Run: npm run test -- src/lib/auth/api-key-scope.test.ts
 */

import { describe, expect, it } from 'vitest'
import { intersectPermissions, intersectRoles } from './api-key-utils'
import { deriveStatus } from './ApiKeyService'
import {
  DEFAULT_API_KEY_POLICY,
  resolveKeyExpiration,
  validateApiKeyPolicy,
} from './api-key-policy-types'
import type { ApiKeyPolicy } from './api-key-policy-types'

describe('intersectRoles', () => {
  it('returns every owner role when the key is unscoped', () => {
    // null roleScope is how keys created before role scoping existed behave.
    expect(intersectRoles(['Administrator', 'User'], null)).toEqual([
      'Administrator',
      'User',
    ])
  })

  it('never grants a role the owner does not hold', () => {
    // The whole point: a key listing Administrator cannot manufacture it.
    expect(intersectRoles(['User'], ['Administrator', 'User'])).toEqual([
      'User',
    ])
  })

  it('narrows to the intersection when the key lists a subset', () => {
    expect(
      intersectRoles(['Administrator', 'Approver', 'User'], ['Approver']),
    ).toEqual(['Approver'])
  })

  it('yields no roles for an empty scope, whatever the owner holds', () => {
    expect(intersectRoles(['Administrator'], [])).toEqual([])
  })

  it('is empty when the owner holds nothing', () => {
    expect(intersectRoles([], ['Administrator'])).toEqual([])
  })
})

describe('intersectPermissions and intersectRoles are independent axes', () => {
  it('a permission-scoped key still needs role scope to clear a role gate', () => {
    // This is the exact shape of the gap role scoping closes: a key scoped to
    // read-only parts, owned by an admin. Permissions narrow correctly...
    const ownerPermissions = {
      parts: ['create', 'read', 'update', 'delete'],
      system: ['manage'],
    }
    const keyScope = { parts: ['read'] }

    expect(intersectPermissions(ownerPermissions, keyScope)).toEqual({
      parts: ['read'],
    })

    // ...but the role axis is only narrowed by roleScope. Unscoped, the key
    // inherits Administrator; scoped to [], it clears nothing.
    expect(intersectRoles(['Administrator'], null)).toContain('Administrator')
    expect(intersectRoles(['Administrator'], [])).not.toContain('Administrator')
  })
})

describe('resolveKeyExpiration', () => {
  const now = new Date('2026-08-07T00:00:00.000Z')
  const day = 24 * 60 * 60 * 1000

  it('applies the policy default when the caller omits an expiry', () => {
    const result = resolveKeyExpiration(undefined, DEFAULT_API_KEY_POLICY, now)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.expiresAt?.getTime()).toBe(now.getTime() + 90 * day)
  })

  it('rejects an expiry beyond the ceiling rather than clamping it', () => {
    // Silently clamping would hand back a key that outlives nothing the
    // caller asked for; an explicit error keeps the contract honest.
    const requested = new Date(now.getTime() + 800 * day).toISOString()
    const result = resolveKeyExpiration(requested, DEFAULT_API_KEY_POLICY, now)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('365')
  })

  it('accepts an expiry inside the ceiling', () => {
    const requested = new Date(now.getTime() + 30 * day).toISOString()
    const result = resolveKeyExpiration(requested, DEFAULT_API_KEY_POLICY, now)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.expiresAt?.toISOString()).toBe(requested)
  })

  it('rejects an expiry in the past', () => {
    const requested = new Date(now.getTime() - day).toISOString()
    const result = resolveKeyExpiration(requested, DEFAULT_API_KEY_POLICY, now)

    expect(result.ok).toBe(false)
  })

  it('rejects a malformed date', () => {
    const result = resolveKeyExpiration(
      'not-a-date',
      DEFAULT_API_KEY_POLICY,
      now,
    )

    expect(result.ok).toBe(false)
  })

  it('refuses a non-expiring key when the policy requires expiry', () => {
    const policy: ApiKeyPolicy = {
      defaultExpirationDays: null,
      maxExpirationDays: null,
      requireExpiration: true,
    }
    const result = resolveKeyExpiration(undefined, policy, now)

    expect(result.ok).toBe(false)
  })

  it('permits a non-expiring key only when the policy allows it', () => {
    const policy: ApiKeyPolicy = {
      defaultExpirationDays: null,
      maxExpirationDays: null,
      requireExpiration: false,
    }
    const result = resolveKeyExpiration(undefined, policy, now)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.expiresAt).toBeNull()
  })

  it('imposes no ceiling when maxExpirationDays is null', () => {
    const policy: ApiKeyPolicy = {
      defaultExpirationDays: 30,
      maxExpirationDays: null,
      requireExpiration: true,
    }
    const requested = new Date(now.getTime() + 5000 * day).toISOString()
    const result = resolveKeyExpiration(requested, policy, now)

    expect(result.ok).toBe(true)
  })
})

describe('deriveStatus', () => {
  const future = new Date(Date.now() + 86_400_000)
  const past = new Date(Date.now() - 86_400_000)

  it('is active when nothing has happened to the key', () => {
    expect(
      deriveStatus({ expiresAt: future, disabledAt: null, revokedAt: null }),
    ).toBe('active')
  })

  it('is active when the key never expires', () => {
    expect(
      deriveStatus({ expiresAt: null, disabledAt: null, revokedAt: null }),
    ).toBe('active')
  })

  it('reports disabled and expired independently', () => {
    expect(
      deriveStatus({ expiresAt: future, disabledAt: past, revokedAt: null }),
    ).toBe('disabled')
    expect(
      deriveStatus({ expiresAt: past, disabledAt: null, revokedAt: null }),
    ).toBe('expired')
  })

  it('lets revocation win over every other state', () => {
    // A revoked key that also expired and was disabled still reads as
    // revoked — that is the decision someone actually made, and it is the
    // only one of the three that cannot be undone.
    expect(
      deriveStatus({ expiresAt: past, disabledAt: past, revokedAt: past }),
    ).toBe('revoked')
  })

  it('prefers disabled over expired', () => {
    expect(
      deriveStatus({ expiresAt: past, disabledAt: past, revokedAt: null }),
    ).toBe('disabled')
  })
})

describe('validateApiKeyPolicy', () => {
  it('accepts the shipped defaults', () => {
    expect(validateApiKeyPolicy(DEFAULT_API_KEY_POLICY)).toBeNull()
  })

  it('rejects a default longer than the maximum', () => {
    expect(
      validateApiKeyPolicy({
        defaultExpirationDays: 400,
        maxExpirationDays: 365,
        requireExpiration: true,
      }),
    ).toContain('cannot exceed')
  })

  it('rejects non-positive and fractional day counts', () => {
    for (const value of [0, -1, 1.5]) {
      expect(
        validateApiKeyPolicy({
          defaultExpirationDays: value,
          maxExpirationDays: null,
          requireExpiration: true,
        }),
      ).not.toBeNull()
    }
  })

  it('allows null on both day fields', () => {
    expect(
      validateApiKeyPolicy({
        defaultExpirationDays: null,
        maxExpirationDays: null,
        requireExpiration: false,
      }),
    ).toBeNull()
  })
})
