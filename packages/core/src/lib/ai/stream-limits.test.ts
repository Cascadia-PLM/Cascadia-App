// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Concurrent AI stream cap (AI-2)
 *
 * Security/limits gate: the slot counter is what stops one user holding an
 * unbounded number of LLM streams open. Pure unit — the counter is process
 * memory by design (streams live and die in one app process).
 *
 * Run: npx vitest run packages/core/src/lib/ai/stream-limits.test.ts
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireStreamSlot,
  activeStreamCount,
  maxConcurrentStreams,
  releaseStreamSlot,
} from '@/lib/ai/stream-limits'
import { RateLimitedError } from '@/lib/errors'

const USER = 'user-a'
const OTHER = 'user-b'

afterEach(() => {
  // Drain whatever a test left held.
  for (const id of [USER, OTHER]) {
    while (activeStreamCount(id) > 0) releaseStreamSlot(id)
  }
  delete process.env.AI_MAX_CONCURRENT_STREAMS
})

describe('stream slot cap', () => {
  it('allows exactly the cap, rejects the next, and counts per user', () => {
    const cap = maxConcurrentStreams()
    for (let i = 0; i < cap; i++) acquireStreamSlot(USER)
    expect(activeStreamCount(USER)).toBe(cap)

    expect(() => acquireStreamSlot(USER)).toThrow(RateLimitedError)

    // Another user is unaffected by the first user's saturation.
    acquireStreamSlot(OTHER)
    expect(activeStreamCount(OTHER)).toBe(1)
  })

  it('a released slot is immediately reusable', () => {
    const cap = maxConcurrentStreams()
    for (let i = 0; i < cap; i++) acquireStreamSlot(USER)

    releaseStreamSlot(USER)
    expect(() => acquireStreamSlot(USER)).not.toThrow()
    expect(activeStreamCount(USER)).toBe(cap)
  })

  it('a stream that throws mid-flight still frees its slot via the finally pairing', async () => {
    // The route's contract: acquire, run the generator, release in finally.
    const run = async () => {
      acquireStreamSlot(USER)
      try {
        await Promise.reject(new Error('provider blew up'))
      } finally {
        releaseStreamSlot(USER)
      }
    }
    await expect(run()).rejects.toThrow('provider blew up')
    expect(activeStreamCount(USER)).toBe(0)
  })

  it('honors AI_MAX_CONCURRENT_STREAMS and ignores invalid values', () => {
    process.env.AI_MAX_CONCURRENT_STREAMS = '1'
    acquireStreamSlot(USER)
    expect(() => acquireStreamSlot(USER)).toThrow(RateLimitedError)

    process.env.AI_MAX_CONCURRENT_STREAMS = 'not-a-number'
    expect(maxConcurrentStreams()).toBe(3)
  })

  it('releasing an unheld slot is a no-op, never a negative count', () => {
    releaseStreamSlot(USER)
    expect(activeStreamCount(USER)).toBe(0)
    acquireStreamSlot(USER)
    expect(activeStreamCount(USER)).toBe(1)
  })
})
