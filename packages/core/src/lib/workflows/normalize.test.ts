// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * normalize.ts unit tests
 *
 * The single sanctioned interpreter of legacy workflow-definition shapes
 * (three-gate rule: complex/load-bearing resolution logic). Nothing writes
 * `definitionType` anymore (WI-6.3), so THESE tests carry the coverage for
 * rows written before the unified lifecycle model — the fixtures now state
 * `lifecycleType` explicitly.
 *
 * Run: npx vitest run src/lib/workflows/normalize.test.ts
 */

import { describe, expect, it } from 'vitest'
import {
  isDrivingDefinition,
  resolveLifecycleType,
  resolveStoredLifecycleType,
} from './normalize'

describe('resolveLifecycleType', () => {
  it('trusts an explicit lifecycleType', () => {
    expect(resolveLifecycleType({ lifecycleType: 'Free' })).toBe('Free')
    expect(resolveLifecycleType({ lifecycleType: 'Driven' })).toBe('Driven')
    expect(resolveLifecycleType({ lifecycleType: 'Driving' })).toBe('Driving')
  })

  it('infers from the legacy definitionType when lifecycleType is absent', () => {
    expect(resolveLifecycleType({ definitionType: 'lifecycle' })).toBe('Driven')
    expect(resolveLifecycleType({ definitionType: 'workflow' })).toBe('Driving')
  })

  it('explicit lifecycleType beats a contradicting legacy field', () => {
    expect(
      resolveLifecycleType({
        lifecycleType: 'Free',
        definitionType: 'workflow',
      }),
    ).toBe('Free')
  })

  it('defaults to Free when both are absent or unrecognized', () => {
    expect(resolveLifecycleType({})).toBe('Free')
    expect(resolveLifecycleType({ lifecycleType: 'bogus' })).toBe('Free')
    expect(resolveLifecycleType({ definitionType: 'bogus' })).toBe('Free')
  })
})

describe('isDrivingDefinition', () => {
  it('resolves through the same inference', () => {
    expect(isDrivingDefinition({ lifecycleType: 'Driving' })).toBe(true)
    expect(isDrivingDefinition({ definitionType: 'workflow' })).toBe(true)
    expect(isDrivingDefinition({ definitionType: 'lifecycle' })).toBe(false)
    expect(isDrivingDefinition({})).toBe(false)
  })
})

describe('resolveStoredLifecycleType', () => {
  it('lets the JSONB speak first — the ADD-COLUMN default lied about legacy rows', () => {
    // Legacy row: column backfilled to 'Free' by the column default, JSONB
    // carries the truth via definitionType
    expect(
      resolveStoredLifecycleType('Free', { definitionType: 'workflow' }),
    ).toBe('Driving')
    expect(
      resolveStoredLifecycleType('Free', { definitionType: 'lifecycle' }),
    ).toBe('Driven')
    // Explicit JSONB lifecycleType wins outright
    expect(
      resolveStoredLifecycleType('Free', { lifecycleType: 'Driven' }),
    ).toBe('Driven')
  })

  it('consults the column only when the JSONB is silent', () => {
    expect(resolveStoredLifecycleType('Driven', {})).toBe('Driven')
    expect(resolveStoredLifecycleType('Driving', {})).toBe('Driving')
    expect(resolveStoredLifecycleType(null, {})).toBe('Free')
  })
})
