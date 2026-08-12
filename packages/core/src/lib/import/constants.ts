// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  getAllFieldsForItemType,
  getAutoGenerateFieldsForType,
  getFieldConfigForType,
  getRequiredFieldsForType,
} from './field-configs'
import { BOM_FIELDS, PART_FIELDS } from './field-configs/part-fields'
import type { ItemFieldConfig } from './field-configs/types'
import type { ImportItemType } from './types'

// Single source of truth for field definitions lives in field-configs/part-fields.ts

// Re-export for backwards compatibility
export type { ItemFieldConfig }

/**
 * @deprecated Use ItemFieldConfig from './field-configs/types' instead
 */
export type PartFieldConfig = ItemFieldConfig

export { PART_FIELDS, BOM_FIELDS }

/**
 * Get all fields (part fields + BOM fields) for column mapping
 * @deprecated Use getAllFieldsForItemType from './field-configs' for type-specific fields
 */
export function getAllFields(): Array<ItemFieldConfig> {
  return [...PART_FIELDS, ...BOM_FIELDS]
}

/**
 * Get all fields for a specific item type (with BOM fields for Parts)
 */
export function getFieldsForType(
  itemType: ImportItemType = 'Part',
): Array<ItemFieldConfig> {
  return getAllFieldsForItemType(itemType)
}

/**
 * Get field config by field name (searches both part and BOM fields)
 * @deprecated Use getFieldConfigForType from './field-configs' for type-specific fields
 */
export function getFieldConfig(field: string): ItemFieldConfig | undefined {
  return getAllFields().find((f) => f.field === field)
}

/**
 * Get field config by field name for a specific item type
 */
export function getFieldByType(
  itemType: ImportItemType,
  field: string,
): ItemFieldConfig | undefined {
  return getFieldConfigForType(itemType, field)
}

/**
 * Get all required fields
 * @deprecated Use getRequiredFieldsForType from './field-configs' for type-specific fields
 */
export function getRequiredFields(): Array<ItemFieldConfig> {
  return PART_FIELDS.filter((f) => f.required)
}

/**
 * Get required fields for a specific item type
 */
export function getRequiredFieldsByType(
  itemType: ImportItemType,
): Array<ItemFieldConfig> {
  return getRequiredFieldsForType(itemType)
}

/**
 * Get all auto-generate fields
 * @deprecated Use getAutoGenerateFieldsForType from './field-configs' for type-specific fields
 */
export function getAutoGenerateFields(): Array<ItemFieldConfig> {
  return PART_FIELDS.filter((f) => f.autoGenerate)
}

/**
 * Get auto-generate fields for a specific item type
 */
export function getAutoGenerateFieldsByType(
  itemType: ImportItemType,
): Array<ItemFieldConfig> {
  return getAutoGenerateFieldsForType(itemType)
}

/**
 * Accepted file extensions
 */
export const ACCEPTED_FILE_TYPES = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    '.xlsx',
  ],
  'application/vnd.ms-excel': ['.xls'],
  'text/csv': ['.csv'],
}

export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls', '.csv']

/**
 * Maximum rows allowed per import.
 *
 * Enforced client-side in `parseFile` (a UX guard) and again server-side in
 * every `/api/v1/import/*` route, which is the real boundary — the parser runs
 * in the browser, so a direct API caller never touches it.
 */
export const MAX_IMPORT_ROWS = 500

/**
 * Maximum BOM relationships allowed alongside a parts import.
 *
 * Ten times the row cap rather than equal to it: one part can appear under
 * many parents, so relationships legitimately outnumber rows. This exists so
 * the array is bounded at all — it was unbounded while `rows` beside it was
 * capped, which made the row cap easy to route around.
 */
export const MAX_IMPORT_RELATIONSHIPS = MAX_IMPORT_ROWS * 10

/**
 * Maximum file size in bytes (10MB)
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024
