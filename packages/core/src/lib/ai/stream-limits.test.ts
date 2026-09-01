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
import type { StreamPool } from '@/lib/ai/stream-limits'
import {
  acquireStreamSlot,
  activeStreamCount,
  maxConcurrentStreams,
  releaseStreamSlot,
} from '@/lib/ai/stream-limits'
import { RateLimitedError } from '@/lib/errors'

const USER = 'user-a'
const OTHER = 'user-b'
const POOLS: Array<StreamPool> = ['chat', 'design']

afterEach(() => {
  // Drain whatever a test left held, in either pool.
  for (const id of [USER, OTHER]) {
    for (const pool of POOLS) {
      while (activeStreamCount(id, pool) > 0) releaseStreamSlot(id, pool)
    }
  }
  delete process.env.AI_MAX_CONCURRENT_STREAMS
  delete process.env.AI_MAX_CONCURRENT_DESIGN_STREAMS
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
    // Message match on purpose: this is the sentinel this test injected,
    // and pinning it is how we know the slot was freed by *that* rejection.
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

describe('design stream pool', () => {
  it('is a separate budget from chat — saturating one never blocks the other', () => {
    const chatCap = maxConcurrentStreams('chat')
    const designCap = maxConcurrentStreams('design')

    for (let i = 0; i < chatCap; i++) acquireStreamSlot(USER, 'chat')
    expect(() => acquireStreamSlot(USER, 'chat')).toThrow(RateLimitedError)

    // A chat-saturated user can still open design streams, and vice versa:
    // a ten-minute CAD stage must not cost the user the assistant.
    expect(activeStreamCount(USER, 'design')).toBe(0)
    for (let i = 0; i < designCap; i++) acquireStreamSlot(USER, 'design')
    expect(activeStreamCount(USER, 'design')).toBe(designCap)
    expect(activeStreamCount(USER, 'chat')).toBe(chatCap)

    // Draining the design pool leaves the chat pool exactly as it was.
    for (let i = 0; i < designCap; i++) releaseStreamSlot(USER, 'design')
    expect(activeStreamCount(USER, 'design')).toBe(0)
    expect(activeStreamCount(USER, 'chat')).toBe(chatCap)
  })

  it('allows exactly the cap, rejects the next, and counts per user', () => {
    const cap = maxConcurrentStreams('design')
    for (let i = 0; i < cap; i++) acquireStreamSlot(USER, 'design')
    expect(activeStreamCount(USER, 'design')).toBe(cap)

    // The hole this closes: the engine's per-session database claim bounds
    // one session, so N sessions were N concurrent streams for one user.
    expect(() => acquireStreamSlot(USER, 'design')).toThrow(RateLimitedError)

    acquireStreamSlot(OTHER, 'design')
    expect(activeStreamCount(OTHER, 'design')).toBe(1)
  })

  it('a released design slot is immediately reusable', () => {
    const cap = maxConcurrentStreams('design')
    for (let i = 0; i < cap; i++) acquireStreamSlot(USER, 'design')

    releaseStreamSlot(USER, 'design')
    expect(() => acquireStreamSlot(USER, 'design')).not.toThrow()
    expect(activeStreamCount(USER, 'design')).toBe(cap)
  })

  it('releasing an unheld design slot is a no-op, never a negative count', () => {
    releaseStreamSlot(USER, 'design')
    expect(activeStreamCount(USER, 'design')).toBe(0)
    acquireStreamSlot(USER, 'design')
    expect(activeStreamCount(USER, 'design')).toBe(1)
  })

  it('honors AI_MAX_CONCURRENT_DESIGN_STREAMS without moving the chat cap', () => {
    process.env.AI_MAX_CONCURRENT_DESIGN_STREAMS = '1'
    expect(maxConcurrentStreams('design')).toBe(1)
    expect(maxConcurrentStreams('chat')).toBe(3)

    acquireStreamSlot(USER, 'design')
    expect(() => acquireStreamSlot(USER, 'design')).toThrow(RateLimitedError)

    process.env.AI_MAX_CONCURRENT_DESIGN_STREAMS = 'not-a-number'
    expect(maxConcurrentStreams('design')).toBe(3)
  })

  it('the release-once wrapper frees a design slot exactly once, however the stream ends', async () => {
    // A second stream the same user is still running. A doubled release would
    // hand this one's slot back too — the reason the wrapper exists.
    acquireStreamSlot(USER, 'design')

    // The route's contract: acquire, run the generator, and release once in
    // the stream's finally no matter which exit path it takes.
    const runStream = async (ending: 'error' | 'abort') => {
      acquireStreamSlot(USER, 'design')
      let released = false
      const releaseSlotOnce = () => {
        if (!released) {
          released = true
          releaseStreamSlot(USER, 'design')
        }
      }
      try {
        if (ending === 'error') await Promise.reject(new Error('stage failed'))
        // 'abort': the client disconnected and the event loop broke early.
      } finally {
        releaseSlotOnce()
        // Whatever else already released — the claim's error path, say.
        releaseSlotOnce()
      }
    }

    // Message match on purpose: this is the sentinel this test injected,
    // and pinning it is how we know the slot was freed by *that* rejection.
    await expect(runStream('error')).rejects.toThrow('stage failed')
    expect(activeStreamCount(USER, 'design')).toBe(1)

    await runStream('abort')
    expect(activeStreamCount(USER, 'design')).toBe(1)
  })
})
