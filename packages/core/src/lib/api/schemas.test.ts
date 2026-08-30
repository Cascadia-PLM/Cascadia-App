// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Per-type update schemas for the generic PUT /items/:id (VAL-4).
 *
 * Three invariants, parameterized over every registered item type:
 *
 *  - every type has a dedicated update schema — the base-fields fallback is
 *    never what a real type resolves to, so a newly registered type fails
 *    here until someone writes its schema (the ratchet)
 *  - a type-invalid value on a known field is rejected, and the rejection
 *    names the field (this is what the route surfaces as 400 + fieldErrors)
 *  - a whole-item read echo parses: the detail pages PUT back exactly what
 *    they read, so anything a read returns must not 400 — unknown keys are
 *    stripped, not rejected
 */

import { describe, expect, it } from 'vitest'
import { baseItemUpdateSchema, itemUpdateSchemaFor } from './schemas'
import { ITEM_TYPE_RESOURCES } from '@/lib/items/item-type-resources'

const ITEM_TYPES = Object.keys(ITEM_TYPE_RESOURCES)

/** One known field per type carrying a type-invalid value. */
const TYPE_INVALID_FIELD: Record<string, Record<string, unknown>> = {
  Part: { leadTimeDays: 'soon' },
  Document: { name: 123 },
  Requirement: { priority: 'urgent-est' },
  Task: { assignee: 'not-a-uuid' },
  ChangeOrder: { riskLevel: 'extreme' },
  TestPlan: { scope: 42 },
  TestCase: { steps: [{ stepNumber: 0, action: '', expectedResult: '' }] },
  WorkInstruction: { estimatedTime: -5 },
  Issue: { severity: 'Catastrophic' },
  Tool: { capabilities: 'many' },
  Software: { softwareType: 'malware' },
  WorkOrder: { quantity: -1 },
  PhysicalPart: { manufacturerPartId: 'not-a-uuid' },
}

describe('itemUpdateSchemaFor', () => {
  it('resolves a dedicated update schema for every registered item type', () => {
    for (const itemType of ITEM_TYPES) {
      // The fallback exists so an unknown string cannot crash the route; a
      // *registered* type resolving to it means someone added an item type
      // without authoring its update schema.
      expect(itemUpdateSchemaFor(itemType), itemType).not.toBe(
        baseItemUpdateSchema,
      )
    }
  })

  it('covers every registered type in this suite', () => {
    // Keeps TYPE_INVALID_FIELD in lockstep with the registry, so the
    // parameterized cases below cannot silently skip a new type.
    expect(Object.keys(TYPE_INVALID_FIELD).sort()).toEqual(ITEM_TYPES.sort())
  })

  it.each(ITEM_TYPES)(
    '%s: rejects a type-invalid field and names it',
    (itemType) => {
      const invalid = TYPE_INVALID_FIELD[itemType]!
      const result = itemUpdateSchemaFor(itemType).safeParse(invalid)
      expect(result.success).toBe(false)
      if (!result.success) {
        const badField = Object.keys(invalid)[0]!
        const paths = result.error.issues.map((i) => String(i.path[0]))
        expect(paths).toContain(badField)
      }
    },
  )

  it.each(ITEM_TYPES)('%s: accepts a whole-item read echo', (itemType) => {
    // The base columns every read returns, plus identity fields the schema
    // must strip rather than reject — the test-plan/test-case detail pages
    // PUT back the entire object a read handed them.
    const echo = {
      id: 'a4b1c9d0-0000-4000-8000-000000000001',
      masterId: 'a4b1c9d0-0000-4000-8000-000000000002',
      itemNumber: 'PN-000123',
      revision: 'A',
      itemType,
      name: 'As read',
      state: 'Draft',
      attributes: { finish: 'anodized' },
      isCurrent: true,
      createdBy: 'a4b1c9d0-0000-4000-8000-000000000003',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
    }
    const result = itemUpdateSchemaFor(itemType).safeParse(echo)
    expect(result.success).toBe(true)
    if (result.success) {
      // Identity fields are stripped, not forwarded to the service.
      expect(result.data).not.toHaveProperty('id')
      expect(result.data).not.toHaveProperty('revision')
      expect(result.data.name).toBe('As read')
    }
  })
})
