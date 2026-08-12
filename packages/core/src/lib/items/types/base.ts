// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import type { ComponentType } from 'react'

// Base item interface matching database schema
export interface BaseItem {
  id?: string
  masterId?: string
  designId?: string // Required for Part, Document, Requirement; optional for Task
  itemNumber?: string // Optional - auto-generated if not provided
  revision: string
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
  attributes?: Record<string, string>
  usageOf?: string // If set, this is a usage referencing a definition (SysML v2 pattern)
}

/**
 * An item as returned by a read path.
 *
 * BaseItem marks these fields optional because it doubles as the shape you pass
 * to create(), where they are not known yet. Every field overridden here is a
 * NOT NULL column on the `items` table, so a row that came back from the
 * database always has it - read paths return this instead and callers stop
 * guarding against states that cannot occur. (revision and itemType are already
 * required on BaseItem, so they don't need repeating.)
 */
export type PersistedItem = BaseItem & {
  id: string
  masterId: string
  itemNumber: string
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
  revision: z.string().min(1).max(10),
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
  attributes: z.record(z.string(), z.string()).optional(),
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
  defaultState: string
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
