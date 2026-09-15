// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Item type → RBAC resource map — security-gate test
 *
 * Every registered item type must have an *explicit* resource mapping.
 * This is exactly the drift that historically skipped permission checks:
 * the map used to live as two copies in the items route, and Tool,
 * TestPlan, TestCase, and WorkOrder mutations fell through the gap. The
 * AI chatbot and MCP tool surfaces now also derive their item-type
 * coverage from ITEM_TYPE_DEFINITIONS, so a new type missing from this
 * map would silently fall back to the parts permission.
 *
 * Run: npx vitest run src/lib/items/item-type-resources.test.ts
 */

import { describe, expect, it } from 'vitest'
import { ITEM_TYPE_RESOURCES, getResourceType } from './item-type-resources'
import { ITEM_TYPE_DEFINITIONS } from './item-type-definitions'

describe('ITEM_TYPE_RESOURCES', () => {
  it('has a mapping for every registered item type', () => {
    // Derived from the definitions now, so this cannot drift the way the
    // hand-kept map could. It stays as the assertion that the derivation is
    // total — a definition whose `resource` went missing would not compile,
    // but a map built from the wrong field would still typecheck.
    for (const def of Object.values(ITEM_TYPE_DEFINITIONS)) {
      expect(ITEM_TYPE_RESOURCES[def.name]).toBe(def.resource)
    }
    expect(Object.keys(ITEM_TYPE_RESOURCES)).toHaveLength(
      Object.keys(ITEM_TYPE_DEFINITIONS).length,
    )
  })

  it('fails closed for unknown types', () => {
    // Requires *a* permission rather than skipping the check. This is the
    // only lookup: the null-returning sibling, whose eight callers guarded
    // with `if (resource)` and skipped the check when it answered null, is
    // gone.
    expect(getResourceType('NotARealType')).toBe('parts')
  })
})
