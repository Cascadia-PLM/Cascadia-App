// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Dead-letter depth warning invariants
 *
 * The dead-letter queue has no consumer and no bound, so its depth is the
 * only warning an operator gets before a broker fills its disk with jobs
 * nothing will ever run. The number itself is plumbing — `/health` reads a
 * cached value and no gate of the three-gate rule applies to a reported
 * field. What is worth pinning is the decision around it: the warning is
 * edge-triggered, so it must fire on the crossing, stay quiet while the
 * condition persists (these checks run every 30 seconds forever), and re-arm
 * once the queue is drained.
 *
 * Nothing here talks to a broker: `RabbitMQClient.getQueueDepth` — the
 * passive `checkQueue` wrapper — is stubbed, the way the retry-sweep suite
 * stubs `publish`. No database either, so this file needs no TestDatabase.
 *
 * Run: npx vitest run packages/core/src/lib/jobs/dead-letter-depth.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RabbitMQClient } from '@/lib/jobs/rabbitmq/client'
import {
  checkDeadLetterDepth,
  deadLetterDepth,
  resetDeadLetterDepthState,
} from '@/lib/jobs/scheduler'
import { workerLogger } from '@/lib/logging/logger'

const WARN_DEPTH = 100

describe('dead-letter depth', () => {
  beforeEach(() => {
    // The cache and the warn latch are module state, so a test that left the
    // queue "full" would silence the next one's crossing.
    resetDeadLetterDepthState()
    // Only the warnings are read here; the drained-again line is `info`, and
    // silencing it keeps the run's output to the assertions.
    vi.spyOn(workerLogger, 'info').mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetDeadLetterDepthState()
  })

  /** What the broker answers a passive declare with, for this test. */
  function stubDepth(depth: number | null) {
    return vi.spyOn(RabbitMQClient, 'getQueueDepth').mockResolvedValue(depth)
  }

  function stubWarn() {
    return vi.spyOn(workerLogger, 'warn').mockReturnValue(undefined)
  }

  /**
   * The logged warnings that carry a depth. Pino's signature is overloaded,
   * so a spy's call tuples type loosely; the first argument is the context
   * object the dead-letter warning carries.
   */
  function depthWarnings(calls: Array<Array<unknown>>) {
    return calls.filter(([context]) => {
      if (typeof context !== 'object' || context === null) return false
      return typeof (context as { depth?: unknown }).depth === 'number'
    })
  }

  it('warns on the crossing and then stays quiet while the queue stays full', async () => {
    stubDepth(WARN_DEPTH + 1)
    const warn = stubWarn()

    expect(await checkDeadLetterDepth(WARN_DEPTH)).toBe(WARN_DEPTH + 1)
    expect(await checkDeadLetterDepth(WARN_DEPTH)).toBe(WARN_DEPTH + 1)
    expect(await checkDeadLetterDepth(WARN_DEPTH)).toBe(WARN_DEPTH + 1)

    // A queue nobody drains stays over the threshold forever, so the check
    // count is unbounded — the warning must not be.
    expect(depthWarnings(warn.mock.calls)).toHaveLength(1)
  })

  it('never warns at or below the threshold', async () => {
    stubDepth(WARN_DEPTH)
    const warn = stubWarn()

    expect(await checkDeadLetterDepth(WARN_DEPTH)).toBe(WARN_DEPTH)

    expect(depthWarnings(warn.mock.calls)).toHaveLength(0)
  })

  it('re-arms once the queue is drained, so a second fill warns again', async () => {
    const depth = stubDepth(WARN_DEPTH + 1)
    const warn = stubWarn()

    await checkDeadLetterDepth(WARN_DEPTH)
    depth.mockResolvedValue(0)
    await checkDeadLetterDepth(WARN_DEPTH)
    depth.mockResolvedValue(WARN_DEPTH + 1)
    await checkDeadLetterDepth(WARN_DEPTH)

    expect(depthWarnings(warn.mock.calls)).toHaveLength(2)
  })

  it('reports the depth as unknown when the broker cannot answer, without throwing', async () => {
    stubDepth(null)
    const warn = stubWarn()

    // `getQueueDepth` answers an unreachable broker with null rather than an
    // error, so a health poll during a broker outage reports "unknown".
    await expect(checkDeadLetterDepth(WARN_DEPTH)).resolves.toBeNull()
    expect(deadLetterDepth()).toBeNull()
    expect(depthWarnings(warn.mock.calls)).toHaveLength(0)
  })

  it('serves the health field from the cache rather than a broker call per poll', async () => {
    const depth = stubDepth(7)
    stubWarn()

    await checkDeadLetterDepth(WARN_DEPTH)

    // Orchestrators poll /health every few seconds; a passive declare per
    // poll would be broker chatter for a number that barely moves.
    expect(deadLetterDepth()).toBe(7)
    expect(deadLetterDepth()).toBe(7)
    expect(depth).toHaveBeenCalledTimes(1)
  })
})
