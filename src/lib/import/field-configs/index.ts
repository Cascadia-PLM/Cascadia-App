// Types
import { BOM_FIELDS, PART_FIELDS } from './part-fields'
import { DOCUMENT_FIELDS } from './document-fields'
import { ISSUE_FIELDS } from './issue-fields'
import type { ImportTypeConfig, ItemFieldConfig } from './types'

export type { ItemFieldConfig, ImportTypeConfig } from './types'

// Field configurations
export { PART_FIELDS, BOM_FIELDS } from './part-fields'
export { DOCUMENT_FIELDS } from './document-fields'
export { ISSUE_FIELDS } from './issue-fields'

/**
 * Registry of all import type configurations
 */
const IMPORT_TYPE_CONFIGS: Record<string, ImportTypeConfig> = {
  Part: {
    itemType: 'Part',
    fields: PART_FIELDS,
    requiresDesign: true,
    supportsBom: true,
    apiEndpoint: '/api/import/parts',
    singularLabel: 'Part',
    pluralLabel: 'Parts',
  },
  Document: {
    itemType: 'Document',
    fields: DOCUMENT_FIELDS,
    requiresDesign: true,
    supportsBom: false,
    apiEndpoint: '/api/import/documents',
    singularLabel: 'Document',
    pluralLabel: 'Documents',
  },
  Issue: {
    itemType: 'Issue',
    fields: ISSUE_FIELDS,
    requiresDesign: false,
    supportsBom: false,
    apiEndpoint: '/api/import/issues',
    singularLabel: 'Issue',
    pluralLabel: 'Issues',
  },
}

/**
 * Get the import configuration for a specific item type
 */
export function getImportConfig(
  itemType: 'Part' | 'Document' | 'Issue',
): ImportTypeConfig {
  return IMPORT_TYPE_CONFIGS[itemType]
}

/**
 * Get the fields for a specific item type
 */
export function getFieldsForItemType(
  itemType: 'Part' | 'Document' | 'Issue',
): Array<ItemFieldConfig> {
  return IMPORT_TYPE_CONFIGS[itemType].fields
}

/**
 * Get all fields for a specific item type (including BOM fields for Parts)
 */
export function getAllFieldsForItemType(
  itemType: 'Part' | 'Document' | 'Issue',
): Array<ItemFieldConfig> {
  const config = IMPORT_TYPE_CONFIGS[itemType]
  if (config.supportsBom) {
    return [...config.fields, ...BOM_FIELDS]
  }
  return config.fields
}

/**
 * Get field config by field name for a specific item type
 */
export function getFieldConfigForType(
  itemType: 'Part' | 'Document' | 'Issue',
  field: string,
): ItemFieldConfig | undefined {
  return getAllFieldsForItemType(itemType).find((f) => f.field === field)
}

/**
 * Get required fields for a specific item type
 */
export function getRequiredFieldsForType(
  itemType: 'Part' | 'Document' | 'Issue',
): Array<ItemFieldConfig> {
  return getFieldsForItemType(itemType).filter((f) => f.required)
}

/**
 * Get auto-generate fields for a specific item type
 */
export function getAutoGenerateFieldsForType(
  itemType: 'Part' | 'Document' | 'Issue',
): Array<ItemFieldConfig> {
  return getFieldsForItemType(itemType).filter((f) => f.autoGenerate)
}
