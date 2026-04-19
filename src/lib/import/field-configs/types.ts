/**
 * Configuration for an item field that can be imported
 */
export interface ItemFieldConfig {
  /** Internal field name matching the schema */
  field: string
  /** Human-readable label */
  label: string
  /** Whether this field is required for import */
  required: boolean
  /** Whether to auto-generate if not provided */
  autoGenerate?: boolean
  /** Column header aliases for auto-detection (lowercase) */
  aliases: Array<string>
  /** Field type for validation display */
  type: 'string' | 'number' | 'enum' | 'date'
  /** Allowed enum values if type is 'enum' */
  enumValues?: Array<string>
  /** Example value for template */
  example?: string
}

/**
 * Configuration for an import item type
 */
export interface ImportTypeConfig {
  /** The item type identifier */
  itemType: 'Part' | 'Document' | 'Issue'
  /** Fields available for this item type */
  fields: Array<ItemFieldConfig>
  /** Whether this item type requires a design context */
  requiresDesign: boolean
  /** Whether this item type supports BOM relationships */
  supportsBom: boolean
  /** API endpoint for import */
  apiEndpoint: string
  /** Singular label for UI */
  singularLabel: string
  /** Plural label for UI */
  pluralLabel: string
}
