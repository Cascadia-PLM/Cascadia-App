// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Activity recording for API keys.
 *
 * Every rejection at the key auth boundary is recorded. Successes are
 * *sampled* — at most one row per key per `SUCCESS_SAMPLE_WINDOW_MS` per
 * process — because a CI or CAD-connector key drives thousands of requests a
 * day and an exhaustive log would cost far more than the questions it answers
 * ("is this key still in use, from where, doing roughly what?"). `lastUsedAt`
 * on the key itself remains exact.
 *
 * Writes are fire-and-forget: activity recording must never fail or slow a
 * request that has already authenticated.
 */

import { db } from '../db'
import { apiKeyEvents } from '../db/schema/api-keys'
import { UNKNOWN_CLIENT_IP, resolveClientIp } from '../api/client-ip'
import type { ApiKeyEventOutcome } from '../db/schema/api-keys'
import { authLogger } from '@/lib/logging/logger'

const SUCCESS_SAMPLE_WINDOW_MS = 60_000

/**
 * Last sampled success per key, in-process. A Map is right here for the same
 * reason `PermissionService` uses one: this is a cost optimisation, not a
 * correctness mechanism, so per-process state and its cold-start double-write
 * are both fine.
 */
const lastSampledSuccess = new Map<string, number>()

/** Bound the map so a long-lived process with many keys cannot grow forever. */
const MAX_TRACKED_KEYS = 10_000

export interface KeyEventContext {
  method?: string
  path?: string
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Derive the recordable context from a request without retaining the request.
 * Query strings are dropped — they routinely carry filter values, and this
 * table is read by anyone with `system:manage`.
 */
export function eventContextFromRequest(request: Request): KeyEventContext {
  let path: string | undefined
  try {
    path = new URL(request.url).pathname
  } catch {
    path = undefined
  }

  // This column is nullable, and "we could not tell" is what NULL means here —
  // so an unresolvable address stays NULL rather than becoming the literal
  // 'unknown' the not-null audit tables have to use.
  const clientIp = resolveClientIp(request)

  return {
    method: request.method,
    path,
    ipAddress: clientIp === UNKNOWN_CLIENT_IP ? null : clientIp,
    userAgent: request.headers.get('user-agent'),
  }
}

export function recordKeyEvent(
  keyId: string,
  outcome: ApiKeyEventOutcome,
  context: KeyEventContext,
): void {
  if (outcome === 'success') {
    const now = Date.now()
    const last = lastSampledSuccess.get(keyId)
    if (last !== undefined && now - last < SUCCESS_SAMPLE_WINDOW_MS) return

    if (lastSampledSuccess.size >= MAX_TRACKED_KEYS) {
      lastSampledSuccess.clear()
    }
    lastSampledSuccess.set(keyId, now)
  }

  void db
    .insert(apiKeyEvents)
    .values({
      keyId,
      outcome,
      method: context.method ?? null,
      path: context.path ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    })
    .catch((err: unknown) => {
      authLogger.error(
        { err, keyId, outcome },
        'Failed to record API key event',
      )
    })
}

/** Test seam: forget the sampling window so successes record immediately. */
export function resetKeyEventSampling(): void {
  lastSampledSuccess.clear()
}
