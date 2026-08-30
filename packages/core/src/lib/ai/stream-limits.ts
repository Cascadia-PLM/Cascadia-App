// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Per-user concurrent AI stream cap.
 *
 * A chat stream holds an LLM connection open for however long the model
 * takes; nothing stopped one user opening dozens at once and monopolising
 * the provider budget and server connections. The cap is a small in-memory
 * counter — streams live and die inside one app process, so process-local
 * accounting is the honest scope. In a multi-instance deployment the cap is
 * per instance, which still bounds the damage and needs no shared state.
 *
 * Design sessions are not counted here: they are already single-streamed
 * per session by the design engine's database claim.
 */

import { RateLimitedError } from '@/lib/errors'

const DEFAULT_MAX_CONCURRENT_STREAMS = 3

const activeStreams = new Map<string, number>()

/** The cap (env `AI_MAX_CONCURRENT_STREAMS`, default 3). */
export function maxConcurrentStreams(): number {
  const parsed = Number(process.env.AI_MAX_CONCURRENT_STREAMS)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_CONCURRENT_STREAMS
}

/**
 * Take one stream slot for the user, throwing 429 at the cap. Every
 * successful acquire must be paired with exactly one `releaseStreamSlot`,
 * however the stream ends — the chat route releases in the stream's
 * `finally`.
 */
export function acquireStreamSlot(userId: string): void {
  const current = activeStreams.get(userId) ?? 0
  if (current >= maxConcurrentStreams()) {
    throw new RateLimitedError(undefined, {
      operation: 'ai.chat.stream',
      userId,
      activeStreams: current,
      maxConcurrentStreams: maxConcurrentStreams(),
    })
  }
  activeStreams.set(userId, current + 1)
}

/** Release one slot; releasing an unheld slot is a harmless no-op. */
export function releaseStreamSlot(userId: string): void {
  const current = activeStreams.get(userId) ?? 0
  if (current <= 1) {
    activeStreams.delete(userId)
  } else {
    activeStreams.set(userId, current - 1)
  }
}

/** Current count for the user (test visibility). */
export function activeStreamCount(userId: string): number {
  return activeStreams.get(userId) ?? 0
}
