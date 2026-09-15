// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * normalize.ts: the one reading of an input's lifecycle type.
 *
 * Complex-algorithm gate, if only just: every kind-dependent branch in the
 * engine (terminal instances, required finalKind, the release orchestration)
 * hangs off this answer. The legacy `definitionType` inference and the
 * JSONB-first stored read are gone with migration 0006 (remediation plan
 * CM-26): a stored row's kind is its column, and this helper only decides
 * what an input that may leave the kind unsaid means.
 *
 * Run: npx vitest run packages/core/src/lib/lifecycles/normalize.test.ts
 */

import { describe, expect, it } from 'vitest'
import { isDrivingDefinition, resolveLifecycleType } from './normalize'

describe('resolveLifecycleType', () => {
  it('trusts an explicit lifecycleType', () => {
    expect(resolveLifecycleType({ lifecycleType: 'Free' })).toBe('Free')
    expect(resolveLifecycleType({ lifecycleType: 'Driven' })).toBe('Driven')
    expect(resolveLifecycleType({ lifecycleType: 'Driving' })).toBe('Driving')
  })

  it('defaults to Free when the kind is absent or unrecognized', () => {
    expect(resolveLifecycleType({})).toBe('Free')
    expect(resolveLifecycleType({ lifecycleType: null })).toBe('Free')
    expect(resolveLifecycleType({ lifecycleType: 'bogus' })).toBe('Free')
  })

  it('no longer infers from the retired definitionType key', () => {
    expect(
      resolveLifecycleType({ definitionType: 'workflow' } as {
        lifecycleType?: string
      }),
    ).toBe('Free')
  })
})

describe('isDrivingDefinition', () => {
  it('is true for Driving and nothing else', () => {
    expect(isDrivingDefinition({ lifecycleType: 'Driving' })).toBe(true)
    expect(isDrivingDefinition({ lifecycleType: 'Driven' })).toBe(false)
    expect(isDrivingDefinition({ lifecycleType: 'Free' })).toBe(false)
    expect(isDrivingDefinition({})).toBe(false)
  })
})
