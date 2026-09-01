// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import type { ComponentType } from 'react'

/**
 * A JSON document value - what a `jsonb` column can actually hold.
 *
 * `items.attributes` is `jsonb` with a GIN index over it, and `baseItemSchema`
 * below is the contract in front of it. The two used to disagree: the column
 * took arbitrary JSON while the schema narrowed it to `Record<string, string>`,
 * and every create validates against the schema. So each writer with structure
 * to store hit the wall independently and worked around it differently -
 * design-engine materialization `JSON.stringify`-ed its snapshots, the CSV
 * importer coerced with `String()`, and the SysML import route cast past the
 * schema and got a 400 at runtime for any element carrying a non-string
 * property. The column is authoritative; the schema now matches it.
 *
 * This names the runtime contract; it is deliberately NOT the type of
 * `BaseItem.attributes` (see the note there), and it is a poor fit for
 * anything assembled out of typed rows - an `interface` has no implicit index
 * signature, so it is not assignable here however JSON-shaped its values are.
 * Reach for it where a value is built from scalars, as `import/mapper.ts`
 * does; elsewhere `unknown` is the type that matches the column.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | { [key: string]: JsonValue }

function isJsonValue(value: unknown): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    // NaN and +/-Infinity have no JSON encoding. `JSON.stringify` turns them
    // into `null` on the way to Postgres, which would land in the column as a
    // value nobody wrote.
    case 'number':
      return Number.isFinite(value)
    case 'object': {
      if (Array.isArray(value)) return value.every(isJsonValue)
      // Plain objects only. A Date, Map, Set or class instance is 'object'
      // too, and `JSON.stringify` reshapes each one on the way to Postgres
      // without complaining - a Date into a string through its `toJSON`, a
      // Map into `{}` - so the column ends up holding something nobody wrote.
      // A caller that means to store a timestamp should format it (see
      // `toAttributeValue` in lib/import/mapper.ts).
      const proto: unknown = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return false
      return Object.values(value).every(isJsonValue)
    }
    // undefined, function, symbol, bigint: `JSON.stringify` drops the key,
    // reshapes it, or throws.
    default:
      return false
  }
}

/**
 * Validates that a value is a JSON document, without narrowing its type.
 *
 * Hand-written rather than the obvious `z.lazy` union over `JsonValue`: a
 * recursive type here propagates into `BaseItem.attributes`, which the
 * thirteen item type schemas `.extend()` and several hundred assignments
 * check against. Measured, that exhausts a 10 GB `tsc` heap - so the static
 * type stays flat and the JSON-ness is enforced at runtime instead. `unknown`
 * is the honest static type for arbitrary JSON anyway: it forces every reader
 * to narrow before use, which is the point.
 */
export const jsonValueSchema: z.ZodType<unknown> = z.custom<unknown>(
  isJsonValue,
  {
    message:
      'Expected a JSON value (string, finite number, boolean, null, array, or object)',
  },
)

// Base item interface matching database schema
export interface BaseItem {
  id?: string
  masterId?: string
  designId?: string // Required for Part, Document, Requirement; optional for Task
  itemNumber?: string // Optional - auto-generated if not provided
  revision?: string // Optional - server-assigned if not provided
  itemType: string
  name?: string
  state?: string
  isCurrent?: boolean
  createdAt?: Date
  createdBy?: string
  modifiedAt?: Date
  modifiedBy?: string
  lockedBy?: string | null
  lockedAt?: Date | null
  // Arbitrary JSON - the `attributes` jsonb column verbatim. Typed `unknown`
  // rather than a recursive JSON value type on purpose; see `jsonValueSchema`.
  attributes?: Record<string, unknown>
  usageOf?: string // If set, this is a usage referencing a definition (SysML v2 pattern)
}

/**
 * An item as returned by a read path.
 *
 * BaseItem marks these fields optional because it doubles as the shape you pass
 * to create(), where they are not known yet. Every field overridden here is a
 * NOT NULL column on the `items` table, so a row that came back from the
 * database always has it - read paths return this instead and callers stop
 * guarding against states that cannot occur. (itemType is already required on
 * BaseItem, so it doesn't need repeating.)
 */
export type PersistedItem = BaseItem & {
  id: string
  masterId: string
  itemNumber: string
  revision: string
  state: string
  createdAt: Date
  createdBy: string
  modifiedAt: Date
  modifiedBy: string
}

// Base Zod schema for validation
export const baseItemSchema = z.object({
  id: z.string().uuid().optional(),
  masterId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(), // Nullable at DB level. Part, Document, Requirement override to required. Task and Issue leave optional/omitted.
  // Optional - auto-generated if not provided. A blank/whitespace-only string
  // (what an untouched form field submits) is coerced to `undefined` so the
  // service auto-generates instead of failing `.min(1)` validation. This makes
  // "leave blank to auto-generate" work uniformly for every item type, on both
  // the client (zodValidator) and the server (schema.parse).
  itemNumber: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).max(100).optional(),
  ),
  // Optional - server-assigned if not provided. A brand-new item has no
  // revision to state: an ECO-controlled type is given one by the release that
  // assigns it, and nothing else is ever assigned one at all. Requiring the
  // field made every client invent a value, and the conventional guess ('A')
  // is indistinguishable from a real released revision A - so the first
  // release read it as one and revised the item to B. `ItemService.create`
  // resolves the value instead; see its `resolveInitialRevision`. Blank input
  // is coerced to `undefined` for the same reason as `itemNumber` above.
  revision: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).max(10).optional(),
  ),
  itemType: z.string().min(1).max(50),
  name: z.string().max(500).optional(),
  state: z.string().max(50).optional(),
  isCurrent: z.boolean().optional(),
  createdAt: z.date().optional(),
  createdBy: z.string().uuid().optional(),
  modifiedAt: z.date().optional(),
  modifiedBy: z.string().uuid().optional(),
  lockedBy: z.string().uuid().nullable().optional(),
  lockedAt: z.date().nullable().optional(),
  // Free-form metadata, stored as-is in the `attributes` jsonb column. Any
  // JSON document is valid here - see `JsonValue` above for why the schema
  // matches the column rather than narrowing it.
  attributes: z.record(z.string(), jsonValueSchema).optional(),
  usageOf: z.string().uuid().optional(), // Reference to definition item (SysML v2 pattern)
})

// State configuration
export interface StateConfig {
  id: string
  name: string
  color?: string
  description?: string
}

// Relationship configuration
export interface RelationshipConfig {
  type: string
  label: string
  targetTypes: Array<string>
  allowMultiple: boolean
}

// Form component props
export interface ItemFormProps<T = any> {
  item?: T
  onSubmit: (data: T) => void | Promise<void>
  onCancel?: () => void
  disabled?: boolean
}

// Table component props
export interface ItemTableProps<T = any> {
  items: Array<T>
  onEdit?: (item: T) => void
  onDelete?: (item: T) => void
  onSelect?: (item: T) => void
}

// Detail component props
export interface ItemDetailProps<T = any> {
  item: T
  onEdit?: () => void
  onDelete?: () => void
}

// Item type configuration
export interface ItemTypeConfig<T = any> {
  name: string
  label: string
  pluralLabel: string
  icon: string
  table: string
  schema: z.ZodSchema<T>
  /**
   * @deprecated Use lifecycleDefinitionId instead.
   * States are now managed through lifecycle definitions in workflow_definitions table.
   * This field is kept for backward compatibility and as a fallback when no lifecycle is assigned.
   */
  states: Array<StateConfig>
  /**
   * Links this item type to a lifecycle definition (from workflow_definitions table).
   * When set, the lifecycle controls which states are valid and how items transition.
   * Multiple item types can share the same lifecycle definition.
   */
  lifecycleDefinitionId?: string
  relationships: Array<RelationshipConfig>
  components: {
    form: ComponentType<ItemFormProps<T>>
    table: ComponentType<ItemTableProps<T>>
    detail: ComponentType<ItemDetailProps<T>>
  }
  permissions: {
    create: Array<string>
    read: Array<string>
    update: Array<string>
    delete: Array<string>
  }
  searchableFields: Array<string>
  displayField: string
}

// Common states used across item types
export const commonStates: Array<StateConfig> = [
  {
    id: 'Draft',
    name: 'Draft',
    color: 'gray',
    description: 'Item is being created or edited',
  },
  {
    id: 'InReview',
    name: 'In Review',
    color: 'blue',
    description: 'Item is under review',
  },
  {
    id: 'Approved',
    name: 'Approved',
    color: 'green',
    description: 'Item has been approved',
  },
  {
    id: 'Released',
    name: 'Released',
    color: 'green',
    description: 'Item is released for use',
  },
  {
    id: 'Obsolete',
    name: 'Obsolete',
    color: 'red',
    description: 'Item is no longer used',
  },
]
