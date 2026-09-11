// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Per-type update schemas for the generic PUT /items/:id (VAL-4).
 *
 * Four invariants, parameterized over every registered item type:
 *
 *  - every type has a dedicated update schema — the base-fields fallback is
 *    never what a real type resolves to, so a newly registered type fails
 *    here until someone writes its schema (the ratchet)
 *  - a type-invalid value on a known field is rejected, and the rejection
 *    names the field (this is what the route surfaces as 400 + fieldErrors)
 *  - a whole-item read echo parses: the detail pages PUT back exactly what
 *    they read, so anything a read returns must not 400 — unknown keys are
 *    stripped, not rejected
 *  - every field that accepts a date accepts both spellings of "no date"
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
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

/**
 * A read echo carries nulls, not only values.
 *
 * The echo case above sends a populated item, which is the easy half: every
 * field it fills is a string the schema was always going to accept. The half
 * that broke in production is an item with an *empty* field — the column is
 * null, the read hands back null, the form echoes null, and a schema written
 * `z.string().optional()` rejects it, because `.optional()` guards `undefined`
 * and says nothing about `null`. Saving an untouched change order 400'd for
 * exactly this reason, on four fields at once, and the same gap was latent in
 * Document, Requirement and Task.
 *
 * So the rule is inverted here: a field must accept null *unless* its column
 * is NOT NULL, and the exemptions are listed one by one with the reason. A new
 * field written without `.nullable()` fails until someone either adds it or
 * writes down why the column cannot be null.
 */
describe('update schemas accept null wherever a read can return one', () => {
  /** Accepted by every type's schema, and none of them can read back null. */
  const UNIVERSAL_EXEMPT: Record<string, string> = {
    // `items.state` is NOT NULL.
    state: 'items.state is NOT NULL',
    // Reads return `{}` for an item with no attributes, never null.
    attributes: 'reads return {} for an item with no attributes',
    // Supplied by the client per-request; no column, so no read returns it.
    commitMessage: 'client-supplied per request, not a column',
  }

  /** Per-type fields whose columns are NOT NULL, with the reason each is exempt. */
  const EXEMPT: Record<string, Record<string, string>> = {
    Part: { trackingMode: 'parts.tracking_mode is NOT NULL with a default' },
    ChangeOrder: { changeType: 'change_orders.change_type is NOT NULL' },
    Issue: {
      designIds:
        'junction-table association, replaced wholesale — not a column',
      affectedItemIds:
        'junction-table association, replaced wholesale — not a column',
    },
    Software: { sourceMode: 'a mode selector on the request, not a column' },
    WorkOrder: {
      quantity: 'work_orders.quantity is NOT NULL',
      quantityCompleted: 'work_orders.quantity_completed is NOT NULL',
      priority: 'work_orders.priority is NOT NULL',
      requiresSignOff: 'work_orders.requires_sign_off is NOT NULL',
      assignedTo: 'jsonb defaulting to [], so a read returns [] not null',
    },
  }

  function exemptFor(itemType: string): Record<string, string> {
    return { ...UNIVERSAL_EXEMPT, ...(EXEMPT[itemType] ?? {}) }
  }

  function shapeOf(itemType: string): Record<string, z.ZodType> {
    const schema = itemUpdateSchemaFor(itemType)
    if (!(schema instanceof z.ZodObject)) return {}
    return schema.shape
  }

  it.each(ITEM_TYPES)('%s: every non-exempt field accepts null', (itemType) => {
    const exempt = exemptFor(itemType)
    const rejecting = Object.entries(shapeOf(itemType))
      .filter(([name]) => !(name in exempt))
      .filter(([, field]) => !field.safeParse(null).success)
      .map(([name]) => name)
    // A field here is either missing `.nullable()` — the bug — or is backed by
    // a NOT NULL column and belongs in EXEMPT with its reason.
    expect(rejecting).toEqual([])
  })

  it.each(ITEM_TYPES)('%s: no exemption is stale', (itemType) => {
    // An exemption that the schema no longer needs is a claim nobody checks;
    // dropping it keeps the list readable as documentation of what is NOT NULL.
    const shape = shapeOf(itemType)
    const stale = Object.keys(exemptFor(itemType))
      .filter((name) => name in shape)
      .filter((name) => shape[name]!.safeParse(null).success)
    expect(stale).toEqual([])
  })

  it.each(ITEM_TYPES)('%s: an all-null read echo parses whole', (itemType) => {
    // The shape the detail pages actually PUT for an item whose optional
    // fields were never filled in.
    const exempt = exemptFor(itemType)
    const echo: Record<string, unknown> = { state: 'Draft' }
    for (const name of Object.keys(shapeOf(itemType))) {
      if (!(name in exempt)) echo[name] = null
    }
    const result = itemUpdateSchemaFor(itemType).safeParse(echo)
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true)
  })
})

/**
 * A date field has to accept more than a date. "No date" has three spellings
 * on the wire and only one of them is `undefined`: an emptied
 * `<input type="date">` reads back as `''`, and JSON spells a cleared column
 * `null`. `z.coerce.date()` passes both to `new Date()`, which returns an
 * Invalid Date for the first and the Unix epoch for the second — so the field
 * that a user cleared either 400s or silently reads 1970-01-01.
 * `clearableDate()` is the fix; this holds every date field to it.
 *
 * The fields are discovered rather than listed, so a date field added to any
 * type's update schema is covered the day it appears — including one written
 * with a bare `z.coerce.date()`, which is what this is guarding against.
 */
describe('date fields accept every spelling of "no date"', () => {
  /** Fields whose schema parses a `Date` to a `Date` — i.e. date fields. */
  function dateFieldsOf(itemType: string): Array<[string, z.ZodType]> {
    const schema = itemUpdateSchemaFor(itemType)
    if (!(schema instanceof z.ZodObject)) return []
    const shape = schema.shape as Record<string, z.ZodType>
    return Object.entries(shape).filter(([, field]) => {
      const result = field.safeParse(new Date())
      return result.success && result.data instanceof Date
    })
  }

  const found = ITEM_TYPES.flatMap((itemType) =>
    dateFieldsOf(itemType).map(([name]) => `${itemType}.${name}`),
  )

  it('finds the date fields it is meant to check', () => {
    // Guards the discovery above: if introspection stops working, the cases
    // below all vanish and the suite would still pass.
    expect(found).toEqual(
      expect.arrayContaining([
        'Task.dueDate',
        'ChangeOrder.implementationDate',
        'Issue.reportedDate',
        'Issue.resolvedDate',
        'TestCase.lastExecutedAt',
      ]),
    )
  })

  it.each(found)('%s reads an emptied date input as no date', (qualified) => {
    const [itemType, name] = qualified.split('.') as [string, string]
    const field = Object.fromEntries(dateFieldsOf(itemType))[name]!
    expect(field.parse('')).toBeNull()
  })

  it.each(found)('%s reads an explicit null as no date', (qualified) => {
    const [itemType, name] = qualified.split('.') as [string, string]
    const field = Object.fromEntries(dateFieldsOf(itemType))[name]!
    // Not the Unix epoch, which is what `new Date(null)` returns.
    expect(field.parse(null)).toBeNull()
  })

  it.each(found)('%s leaves an omitted field omitted', (qualified) => {
    const [itemType, name] = qualified.split('.') as [string, string]
    const field = Object.fromEntries(dateFieldsOf(itemType))[name]!
    // The distinction that matters: the type handlers write a column only
    // when the key is present, so `undefined` must not become `null`.
    expect(field.parse(undefined)).toBeUndefined()
  })

  it.each(found)('%s still parses a real date', (qualified) => {
    const [itemType, name] = qualified.split('.') as [string, string]
    const field = Object.fromEntries(dateFieldsOf(itemType))[name]!
    expect(field.parse('2026-03-01T00:00:00.000Z')).toEqual(
      new Date('2026-03-01T00:00:00.000Z'),
    )
  })
})
