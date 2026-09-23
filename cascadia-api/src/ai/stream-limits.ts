// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Per-user concurrent AI stream cap.
 *
 * A stream holds an LLM connection open for however long the model takes;
 * nothing stopped one user opening dozens at once and monopolising the
 * provider budget and server connections. The cap is a small in-memory
 * counter — streams live and die inside one app process, so process-local
 * accounting is the honest scope. In a multi-instance deployment the cap is
 * per instance, which still bounds the damage and needs no shared state.
 *
 * Two pools are counted separately, and deliberately so:
 *
 * - `chat` — the AI chat route's streams.
 * - `design` — the design engine's SSE stage streams. The engine's database
 *   claim single-streams a SESSION, not a user, so one user opening N design
 *   sessions held N concurrent drafting streams however low the chat cap was.
 *
 * They do not share a budget because a design stage stream can run for ten
 * minutes inside one CAD generation, and a user with a few of those running
 * must not be locked out of asking the assistant a question.
 */

import { RateLimitedError } from '@/lib/errors'

/** Which budget a stream is counted against. */
export type StreamPool = 'chat' | 'design'

interface PoolConfig {
  /** Environment variable that overrides this pool's cap. */
  envVar: string
  defaultMax: number
  /** What the 429's error context calls the operation that was refused. */
  operation: string
}

const POOLS: Record<StreamPool, PoolConfig> = {
  chat: {
    envVar: 'AI_MAX_CONCURRENT_STREAMS',
    defaultMax: 3,
    operation: 'ai.chat.stream',
  },
  design: {
    envVar: 'AI_MAX_CONCURRENT_DESIGN_STREAMS',
    defaultMax: 3,
    operation: 'design.stream',
  },
}

/** Counts keyed `<pool>:<userId>`, so the two pools never see each other. */
const activeStreams = new Map<string, number>()

function slotKey(userId: string, pool: StreamPool): string {
  return `${pool}:${userId}`
}

/**
 * The cap for a pool (env `AI_MAX_CONCURRENT_STREAMS` for chat,
 * `AI_MAX_CONCURRENT_DESIGN_STREAMS` for design; both default 3).
 */
export function maxConcurrentStreams(pool: StreamPool = 'chat'): number {
  const config = POOLS[pool]
  const parsed = Number(process.env[config.envVar])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : config.defaultMax
}

/**
 * Take one stream slot for the user in the given pool, throwing 429 at the
 * cap. Every successful acquire must be paired with exactly one
 * `releaseStreamSlot` for the same pool, however the stream ends — both
 * routes release in the stream's `finally`.
 */
export function acquireStreamSlot(
  userId: string,
  pool: StreamPool = 'chat',
): void {
  const max = maxConcurrentStreams(pool)
  const key = slotKey(userId, pool)
  const current = activeStreams.get(key) ?? 0
  if (current >= max) {
    throw new RateLimitedError(undefined, {
      operation: POOLS[pool].operation,
      userId,
      activeStreams: current,
      maxConcurrentStreams: max,
    })
  }
  activeStreams.set(key, current + 1)
}

/** Release one slot; releasing an unheld slot is a harmless no-op. */
export function releaseStreamSlot(
  userId: string,
  pool: StreamPool = 'chat',
): void {
  const key = slotKey(userId, pool)
  const current = activeStreams.get(key) ?? 0
  if (current <= 1) {
    activeStreams.delete(key)
  } else {
    activeStreams.set(key, current - 1)
  }
}

/** Current count for the user in a pool (test visibility). */
export function activeStreamCount(
  userId: string,
  pool: StreamPool = 'chat',
): number {
  return activeStreams.get(slotKey(userId, pool)) ?? 0
}
