// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { SHA256 } from '@oslojs/crypto/sha2'
import { encodeHexLowerCase } from '@oslojs/encoding'

const API_KEY_PREFIX = 'csc_'

/**
 * Generate a new API key.
 * Format: csc_ + 40 hex characters (160 bits of entropy).
 * The prefix makes leaked keys grep-able in logs.
 */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return `${API_KEY_PREFIX}${encodeHexLowerCase(bytes)}`
}

/**
 * Hash an API key for storage using SHA-256.
 * Only the hash is stored in the database — the raw key
 * is returned to the user once at creation time.
 */
export function hashApiKey(rawKey: string): string {
  const encoder = new TextEncoder()
  const data = encoder.encode(rawKey)
  const hasher = new SHA256()
  hasher.update(data)
  return encodeHexLowerCase(hasher.digest())
}

/**
 * Extract the prefix from an API key for identification.
 * Returns the first 12 characters (e.g., "csc_abc12345").
 */
export function getKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, 12)
}

/**
 * Compute effective permissions by intersecting user role permissions
 * with API key scope. Keys can only narrow access, never widen it.
 *
 * If keyScope is null, the user's full permissions are returned.
 */
export function intersectPermissions(
  userPermissions: Record<string, Array<string>>,
  keyScope: Record<string, Array<string>> | null,
): Record<string, Array<string>> {
  if (!keyScope) return userPermissions

  const result: Record<string, Array<string>> = {}

  for (const [resource, keyActions] of Object.entries(keyScope)) {
    const userActions = userPermissions[resource]
    if (!userActions) continue

    // Intersection: only actions present in both
    const effectiveActions = keyActions.filter(
      (action) =>
        userActions.includes(action) || userActions.includes('manage'),
    )

    if (effectiveActions.length > 0) {
      result[resource] = effectiveActions
    }
  }

  return result
}

/**
 * Compute the effective roles a request may exercise by intersecting the
 * owner's actual roles with the API key's role scope. Keys can only narrow
 * access, never widen it.
 *
 * If keyRoles is null, the user's full role set is returned.
 *
 * This is the role-axis counterpart to `intersectPermissions`. It exists
 * because `requireRole` checks role *membership*, which a permission map
 * cannot express: a key scoped to `{ parts: ['read'] }` would otherwise
 * still satisfy `requireRole('Administrator')` for an admin owner.
 */
export function intersectRoles(
  userRoles: Array<string>,
  keyRoles: Array<string> | null,
): Array<string> {
  if (!keyRoles) return userRoles

  return userRoles.filter((role) => keyRoles.includes(role))
}
