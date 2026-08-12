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
import {
  ITEM_TYPE_RESOURCES,
  getResourceType,
  itemTypeToResource,
} from './item-type-resources'
import { ITEM_TYPE_DEFINITIONS } from './item-type-definitions'

describe('ITEM_TYPE_RESOURCES', () => {
  it('has an explicit mapping for every registered item type', () => {
    for (const def of Object.values(ITEM_TYPE_DEFINITIONS)) {
      expect(
        ITEM_TYPE_RESOURCES[def.name],
        `Item type "${def.name}" has no RBAC resource mapping — add it to ` +
          'ITEM_TYPE_RESOURCES so its permission checks do not fall back to parts',
      ).toBeDefined()
    }
  })

  it('fails closed for unknown types', () => {
    // Create path requires *a* permission rather than skipping the check
    expect(getResourceType('NotARealType')).toBe('parts')
    // Lookup path reports unknown explicitly
    expect(itemTypeToResource('NotARealType')).toBeNull()
  })
})
