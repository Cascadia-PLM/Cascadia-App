// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Shared types and pure logic for the API key expiration policy.
 *
 * This file is intentionally dependency-free (no db / node / error-class
 * imports) so the admin UI can import it without pulling server-only modules
 * into the SPA build. Any settings blob shared between the server and the SPA
 * wants the same split.
 *
 * The policy is instance-wide and stored as a JSON blob under the
 * `api_key_policy` setting. There is no per-user override: an admin who wants
 * a longer-lived key raises the ceiling for everyone, visibly.
 */

export interface ApiKeyPolicy {
  /**
   * Lifetime applied when a key is created without an explicit `expiresAt`.
   * null means "no default" — such a key never expires unless
   * `requireExpiration` forces the caller to supply one.
   */
  defaultExpirationDays: number | null
  /**
   * Hard ceiling on how far out `expiresAt` may be set. null means no ceiling.
   * Requests beyond this are rejected rather than silently clamped, so a
   * script asking for two years does not quietly get one.
   */
  maxExpirationDays: number | null
  /** Reject any key creation that would produce a non-expiring key. */
  requireExpiration: boolean
}

/**
 * Applied when the `api_key_policy` setting has never been written.
 *
 * 90 days is short enough that an abandoned key ages out within a quarter,
 * and the 365-day ceiling keeps "expires eventually" true for every key while
 * still covering a long-lived CI or CAD-connector integration.
 */
export const DEFAULT_API_KEY_POLICY: ApiKeyPolicy = {
  defaultExpirationDays: 90,
  maxExpirationDays: 365,
  requireExpiration: true,
}

/** Upper bound on the configurable values themselves, to keep the UI honest. */
export const MAX_CONFIGURABLE_EXPIRATION_DAYS = 3650

export type ExpirationResolution =
  { ok: true; expiresAt: Date | null } | { ok: false; error: string }

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Resolve the effective expiry for a new key from the caller's request and the
 * instance policy. Pure — callers turn `{ ok: false }` into whatever error
 * type suits their layer.
 *
 * @param requested ISO date string the caller asked for, if any.
 * @param policy    The instance policy.
 * @param now       Injected so tests and the UI preview agree with the server.
 */
export function resolveKeyExpiration(
  requested: string | null | undefined,
  policy: ApiKeyPolicy,
  now: Date = new Date(),
): ExpirationResolution {
  const ceiling =
    policy.maxExpirationDays === null
      ? null
      : new Date(now.getTime() + policy.maxExpirationDays * MS_PER_DAY)

  if (requested) {
    const parsed = new Date(requested)
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'expiresAt must be a valid ISO date' }
    }
    if (parsed.getTime() <= now.getTime()) {
      return { ok: false, error: 'expiresAt must be in the future' }
    }
    if (ceiling && parsed.getTime() > ceiling.getTime()) {
      return {
        ok: false,
        error: `expiresAt may be at most ${String(policy.maxExpirationDays)} days out under the current API key policy`,
      }
    }
    return { ok: true, expiresAt: parsed }
  }

  if (policy.defaultExpirationDays !== null) {
    return {
      ok: true,
      expiresAt: new Date(
        now.getTime() + policy.defaultExpirationDays * MS_PER_DAY,
      ),
    }
  }

  if (policy.requireExpiration) {
    return {
      ok: false,
      error:
        'The API key policy requires an expiration date; supply expiresAt when creating a key',
    }
  }

  return { ok: true, expiresAt: null }
}

/**
 * Validate a policy blob before it is stored. Returns an error string, or null
 * when the policy is coherent.
 */
export function validateApiKeyPolicy(policy: ApiKeyPolicy): string | null {
  for (const [label, value] of [
    ['defaultExpirationDays', policy.defaultExpirationDays],
    ['maxExpirationDays', policy.maxExpirationDays],
  ] as const) {
    if (value === null) continue
    if (!Number.isInteger(value) || value < 1) {
      return `${label} must be a positive whole number of days, or null`
    }
    if (value > MAX_CONFIGURABLE_EXPIRATION_DAYS) {
      return `${label} may be at most ${String(MAX_CONFIGURABLE_EXPIRATION_DAYS)} days`
    }
  }

  if (
    policy.defaultExpirationDays !== null &&
    policy.maxExpirationDays !== null &&
    policy.defaultExpirationDays > policy.maxExpirationDays
  ) {
    return 'defaultExpirationDays cannot exceed maxExpirationDays'
  }

  // A policy that demands expiry but offers no default and no ceiling is
  // satisfiable, but one that demands expiry with no default forces every
  // caller to pass expiresAt explicitly — worth allowing, so no check here.

  return null
}
