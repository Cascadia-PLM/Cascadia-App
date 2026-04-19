import { getFieldsForType, getRequiredFieldsByType } from './constants'
import type { ColumnMapping, ImportItemType } from './types'

/**
 * Options for applying mappings
 */
export interface ApplyMappingsOptions {
  /** If true, unmapped columns will be collected into an `attributes` object */
  collectUnmappedAsAttributes?: boolean
}

/**
 * Sanitize a column name to be used as an attribute key.
 * - Trims whitespace
 * - Replaces spaces with underscores
 * - Removes non-alphanumeric characters (except underscore and hyphen)
 * - Converts to lowercase
 */
export function sanitizeAttributeKey(columnName: string): string {
  return columnName
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase()
}

/**
 * Get the list of unmapped columns from a set of mappings.
 * Useful for UI to show which columns will become custom attributes.
 */
export function getUnmappedColumns(
  mappings: Array<ColumnMapping>,
): Array<{ sourceColumn: string; attributeKey: string }> {
  return mappings
    .filter((m) => !m.targetField)
    .map((m) => ({
      sourceColumn: m.sourceColumn,
      attributeKey: sanitizeAttributeKey(m.sourceColumn),
    }))
    .filter((m) => m.attributeKey !== '') // Skip columns that sanitize to empty string
}

/**
 * Normalize a header string for comparison
 */
function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/[_\-\s]+/g, ' ') // Normalize separators to spaces
    .replace(/[^a-z0-9 ]/g, '') // Remove special characters
    .trim()
}

/**
 * Calculate similarity score between two strings (0-1)
 * Uses exact match and prefix/suffix matching
 */
function calculateSimilarity(source: string, target: string): number {
  const normalizedSource = normalizeHeader(source)
  const normalizedTarget = normalizeHeader(target)

  // Exact match
  if (normalizedSource === normalizedTarget) {
    return 1.0
  }

  // Source contains target or vice versa
  if (
    normalizedSource.includes(normalizedTarget) ||
    normalizedTarget.includes(normalizedSource)
  ) {
    // Longer match = higher score
    const shorter = Math.min(normalizedSource.length, normalizedTarget.length)
    const longer = Math.max(normalizedSource.length, normalizedTarget.length)
    return 0.7 + (shorter / longer) * 0.2
  }

  // Check if words overlap
  const sourceWords = new Set(normalizedSource.split(' '))
  const targetWords = new Set(normalizedTarget.split(' '))
  const intersection = [...sourceWords].filter((w) => targetWords.has(w))

  if (intersection.length > 0) {
    return (
      0.5 +
      (intersection.length / Math.max(sourceWords.size, targetWords.size)) * 0.3
    )
  }

  return 0
}

/**
 * Auto-detect column mappings based on header names.
 * Optionally accepts fields to use for detection, otherwise searches Part fields + BOM fields.
 */
export function autoDetectMappings(
  headers: Array<string>,
  itemType: ImportItemType = 'Part',
): Array<ColumnMapping> {
  const mappings: Array<ColumnMapping> = []
  const usedFields = new Set<string>()
  const allFields = getFieldsForType(itemType)

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    let bestMatch: { field: string; confidence: number } | null = null

    // Find the best matching field
    for (const fieldConfig of allFields) {
      // Skip if this field is already mapped
      if (usedFields.has(fieldConfig.field)) continue

      let maxScore = 0

      // Check against all aliases
      for (const alias of fieldConfig.aliases) {
        const score = calculateSimilarity(header, alias)
        if (score > maxScore) {
          maxScore = score
        }
      }

      // Also check against the field label
      const labelScore = calculateSimilarity(header, fieldConfig.label)
      if (labelScore > maxScore) {
        maxScore = labelScore
      }

      // Update best match if this is better
      if (maxScore > 0.5 && (!bestMatch || maxScore > bestMatch.confidence)) {
        bestMatch = { field: fieldConfig.field, confidence: maxScore }
      }
    }

    if (bestMatch) {
      mappings.push({
        sourceColumn: header,
        sourceIndex: i,
        targetField: bestMatch.field,
        confidence: bestMatch.confidence,
      })
      usedFields.add(bestMatch.field)
    } else {
      // No match found - mark as unmapped
      mappings.push({
        sourceColumn: header,
        sourceIndex: i,
        targetField: null,
        confidence: 0,
      })
    }
  }

  return mappings
}

/**
 * Apply column mappings to transform raw rows into mapped data.
 * Optionally collects unmapped columns as custom attributes.
 */
export function applyMappings(
  rows: Array<Record<string, unknown>>,
  mappings: Array<ColumnMapping>,
  options?: ApplyMappingsOptions,
): Array<Record<string, unknown>> {
  const collectUnmappedAsAttributes =
    options?.collectUnmappedAsAttributes ?? false

  // Create a lookup from source column to target field
  const columnToField: Record<string, string> = {}
  for (const mapping of mappings) {
    if (mapping.targetField) {
      columnToField[mapping.sourceColumn] = mapping.targetField
    }
  }

  return rows.map((row) => {
    const mappedRow: Record<string, unknown> = {}
    const attributes: Record<string, unknown> = {}

    for (const [sourceColumn, value] of Object.entries(row)) {
      const targetField = columnToField[sourceColumn]
      if (targetField && value !== undefined && value !== '') {
        mappedRow[targetField] = value
      } else if (
        collectUnmappedAsAttributes &&
        value !== undefined &&
        value !== ''
      ) {
        // Collect unmapped columns as attributes (convert to string for schema compatibility)
        const attrKey = sanitizeAttributeKey(sourceColumn)
        if (attrKey) {
          attributes[attrKey] = String(value)
        }
      }
    }

    // Add attributes to mapped row if any were collected
    if (collectUnmappedAsAttributes && Object.keys(attributes).length > 0) {
      mappedRow.attributes = attributes
    }

    return mappedRow
  })
}

/**
 * Update a single mapping (for manual override)
 */
export function updateMapping(
  mappings: Array<ColumnMapping>,
  sourceIndex: number,
  newTargetField: string | null,
): Array<ColumnMapping> {
  // First, check if the new target field is already used by another mapping
  if (newTargetField) {
    const existingMapping = mappings.find(
      (m) => m.targetField === newTargetField && m.sourceIndex !== sourceIndex,
    )
    if (existingMapping) {
      // Clear the existing mapping
      const existingIndex = mappings.findIndex(
        (m) => m.sourceIndex === existingMapping.sourceIndex,
      )
      mappings = mappings.map((m, i) =>
        i === existingIndex ? { ...m, targetField: null, confidence: 0 } : m,
      )
    }
  }

  // Update the target mapping
  return mappings.map((m) =>
    m.sourceIndex === sourceIndex
      ? {
          ...m,
          targetField: newTargetField,
          confidence: newTargetField ? 1.0 : 0,
        }
      : m,
  )
}

/**
 * Get all mapped fields from the mappings
 */
export function getMappedFields(mappings: Array<ColumnMapping>): Array<string> {
  return mappings
    .filter((m) => m.targetField !== null)
    .map((m) => m.targetField as string)
}

/**
 * Check if required fields are mapped for a specific item type
 */
export function checkRequiredFieldsMapped(
  mappings: Array<ColumnMapping>,
  itemType: ImportItemType = 'Part',
): {
  allMapped: boolean
  missingFields: Array<string>
} {
  const mappedFields = new Set(getMappedFields(mappings))
  const missingFields: Array<string> = []
  const requiredFields = getRequiredFieldsByType(itemType)

  for (const field of requiredFields) {
    if (!field.autoGenerate && !mappedFields.has(field.field)) {
      missingFields.push(field.label)
    }
  }

  return {
    allMapped: missingFields.length === 0,
    missingFields,
  }
}
