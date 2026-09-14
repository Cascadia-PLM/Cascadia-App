// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Every registry a module registers into decides the same question: what
 * happens when two contributions claim one name. The answer used to differ per
 * registry — `registerTool` and `registerPackage` threw, `JobTypeRegistry`
 * overwrote silently, and `ApprovalRegistry` appended a second entry under the
 * same name — and the silent halves lose configuration nothing else can catch:
 * an overwritten job config takes its timeout, retry delays and routing key
 * with it. Not a type error, and not logged at a level anyone reads.
 *
 * `ReleaseHookRegistry` was covered here too until the Odoo connector moved off
 * it. It now has **zero registrants in both editions**, so there is nothing left
 * for a duplicate policy to protect; the registry is deprecated and removed a
 * wave later, and this block went with its last registrant rather than testing a
 * seam nothing uses.
 *
 * These tests pin the unified policy: a conflict throws, and the harmless case
 * a throw would break — the same object registered again, which is what a
 * re-imported definitions module produces — stays a no-op.
 *
 * The additive registries (`registerSlot`, `registerRoutes`,
 * `registerResourceDependents`) are deliberately excluded: several
 * contributions per key is their contract, so they have no conflict to detect.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { JobHandler, JobTypeConfig } from '@/lib/jobs/types'
import type { ConsumedExtension } from '@/lib/extensions'
import type { DomainEventDefinition } from '@/lib/events'
import { JobTypeRegistry } from '@/lib/jobs/registry'
import { ApprovalRegistry } from '@/lib/lifecycles/approval-registry'
import { EventTypeRegistry, defineDomainEvent } from '@/lib/events'
import { ExtensionRegistry, defineExtension } from '@/lib/extensions'

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
    ExtensionRegistry.clear()
    EventTypeRegistry.clear()
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

  describe('ExtensionRegistry', () => {
    // One definition per test, not one per call: `defineDomainEvent` registers,
    // and a second object under the same type is itself a conflict — which is
    // the policy the block above already pins.
    let definition: DomainEventDefinition<{ marker: string }>
    beforeEach(() => {
      definition = defineDomainEvent({
        type: TEST_TYPE,
        schemaVersion: 1,
        description: 'Test-only definition for the duplicate policy',
        payloadSchema: z.object({ marker: z.string() }),
      })
    })

    const extension = (id: string): ConsumedExtension<{ marker: string }> => ({
      id,
      phase: 'consumed',
      on: definition,
      handler: () => Promise.resolve(),
    })

    it('throws on a duplicate extension id', () => {
      defineExtension(extension('duplicate-policy-test'))
      expect(() => {
        defineExtension(extension('duplicate-policy-test'))
      }).toThrow(/already registered/)
      expect(ExtensionRegistry.list()).toHaveLength(1)
    })

    it('treats the identical object again as a no-op', () => {
      const only = extension('duplicate-policy-test')
      defineExtension(only)
      defineExtension(only)
      expect(ExtensionRegistry.list()).toEqual([only])
    })

    it('accepts distinct ids', () => {
      defineExtension(extension('a'))
      defineExtension(extension('b'))
      expect(ExtensionRegistry.list().map((e) => e.id)).toEqual(['a', 'b'])
    })

    // The half the consumer registry it replaces did not have. A subscription
    // naming a type that had been renamed did not fail there — it advanced its
    // cursor past every event forever and reported itself idle.
    it('refuses a subscription to an event type no definition claims', () => {
      expect(() => {
        defineExtension({
          id: 'names-a-type-that-does-not-exist',
          phase: 'consumed',
          on: {
            type: 'test.registries.never-registered',
            schemaVersion: 1,
            description: 'Never passed to defineDomainEvent',
            payloadSchema: z.object({}),
          },
          handler: () => Promise.resolve(),
        })
      }).toThrow(/unknown event type/)
      expect(ExtensionRegistry.list()).toHaveLength(0)
    })
  })
})
