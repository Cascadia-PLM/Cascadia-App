// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * API-key wire types shared by the admin UI and `ApiKeyService`, which
 * re-exports them. Dependency-free for the same reason as
 * `api-key-policy-types.ts`.
 */

/**
 * A key's effective state, derived rather than stored — `expired` is a
 * function of the clock, so persisting it would immediately go stale.
 * Precedence matters: a revoked key that has also expired reads as revoked,
 * because revocation is the decision someone made.
 */
export type ApiKeyStatus = 'active' | 'disabled' | 'expired' | 'revoked'
