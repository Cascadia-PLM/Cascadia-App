// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Every registry a module registers into decides the same question: what
 * happens when two contributions claim one name. The answer used to differ per
 * registry — `registerTool` and `registerPackage` threw, `JobTypeRegistry`
 * overwrote silently, `ApprovalRegistry` and `ReleaseHookRegistry` appended a
 * second entry under the same name — and the silent halves lose configuration
 * nothing else can catch: an overwritten job config takes its timeout, retry
 * delays and routing key with it, and a duplicate release hook fires twice
 * while `registered()` reports it once. Neither is a type error, and neither
 * logs at a level anyone reads.
 *
 * These tests pin the unified policy: a conflict throws, and the harmless case
 * a throw would break — the same object registered again, which is what a
 * re-imported definitions module produces — stays a no-op.
 *
 * The additive registries (`registerSlot`, `registerRoutes`,
 * `registerResourceDependents`) are deliberately excluded: several
 * contributions per key is their contract, so they have no conflict to detect.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { JobHandler, JobTypeConfig } from '@/lib/jobs/types'
import { JobTypeRegistry } from '@/lib/jobs/registry'
import { ApprovalRegistry } from '@/lib/workflows/approval-registry'
import { ReleaseHookRegistry } from '@/lib/services/release-hooks'

/** A type no shipped definition claims — this file never imports `register.ts`. */
const TEST_TYPE = 'test.registries.duplicate-policy'

type Empty = Record<string, never>

function config(label: string): JobTypeConfig<Empty, Empty> {
  return {
    type: TEST_TYPE,
    label,
    routingKey: 'jobs.test.duplicate-policy',
    payloadSchema: z.object({}),
    resultSchema: z.object({}),
    timeout: 1000,
    maxAttempts: 3,
    retryDelays: [1000],
    priority: 'normal',
  }
}

function handler(): JobHandler<Empty, Empty> {
  return {
    type: TEST_TYPE,
    execute: () => Promise.resolve({}),
  }
}

describe('registry duplicate policy', () => {
  afterEach(() => {
    JobTypeRegistry.clear()
    ApprovalRegistry.clear()
    ReleaseHookRegistry.clear()
  })

  describe('JobTypeRegistry', () => {
    it('registers a type that is not yet claimed', () => {
      JobTypeRegistry.register(config('first'))
      expect(JobTypeRegistry.getType(TEST_TYPE)?.label).toBe('first')
    })

    it('is a no-op when handed the identical config object again', () => {
      const first = config('first')
      JobTypeRegistry.register(first)
      expect(() => {
        JobTypeRegistry.register(first)
      }).not.toThrow()
      expect(JobTypeRegistry.getType(TEST_TYPE)?.label).toBe('first')
    })

    it('throws when a different config claims a registered type', () => {
      JobTypeRegistry.register(config('first'))
      expect(() => {
        JobTypeRegistry.register(config('second'))
      }).toThrow(/already registered/)
      // Rejected, not applied: the first config is still the live one.
      expect(JobTypeRegistry.getType(TEST_TYPE)?.label).toBe('first')
    })

    it('is a no-op when handed the identical handler object again', () => {
      JobTypeRegistry.register(config('first'))
      const only = handler()
      JobTypeRegistry.registerHandler(only)
      expect(() => {
        JobTypeRegistry.registerHandler(only)
      }).not.toThrow()
      expect(JobTypeRegistry.getHandler(TEST_TYPE)).toBe(only)
    })

    it('throws when a different handler claims a registered type', () => {
      JobTypeRegistry.register(config('first'))
      const first = handler()
      JobTypeRegistry.registerHandler(first)
      expect(() => {
        JobTypeRegistry.registerHandler(handler())
      }).toThrow(/already has a different handler/)
      expect(JobTypeRegistry.getHandler(TEST_TYPE)).toBe(first)
    })
  })

  describe('ApprovalRegistry', () => {
    it('throws on a duplicate interceptor name', () => {
      ApprovalRegistry.register({ name: 'duplicate-policy-test' })
      expect(() => {
        ApprovalRegistry.register({ name: 'duplicate-policy-test' })
      }).toThrow(/already registered/)
      expect(ApprovalRegistry.registered()).toEqual(['duplicate-policy-test'])
    })

    it('accepts distinct names', () => {
      ApprovalRegistry.register({ name: 'a' })
      ApprovalRegistry.register({ name: 'b' })
      expect(ApprovalRegistry.registered()).toEqual(['a', 'b'])
    })
  })

  describe('ReleaseHookRegistry', () => {
    const noop = () => Promise.resolve()

    it('throws on a duplicate hook name', () => {
      ReleaseHookRegistry.register({
        name: 'duplicate-policy-test',
        afterRelease: noop,
      })
      expect(() => {
        ReleaseHookRegistry.register({
          name: 'duplicate-policy-test',
          afterRelease: noop,
        })
      }).toThrow(/already registered/)
      expect(ReleaseHookRegistry.all()).toHaveLength(1)
    })

    it('accepts distinct names', () => {
      ReleaseHookRegistry.register({ name: 'a', afterRelease: noop })
      ReleaseHookRegistry.register({ name: 'b', afterRelease: noop })
      expect(ReleaseHookRegistry.registered()).toEqual(['a', 'b'])
    })
  })
})
