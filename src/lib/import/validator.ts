import { importPartRowSchema } from './types'
import { importDocumentRowSchema } from './types/document'
import { importIssueRowSchema } from './types/issue'
import { getFieldByType, getFieldConfig } from './constants'
import type {
  BomRelationship,
  BomValidationResult,
  ImportItemType,
  RowValidationError,
  RowValidationWarning,
  ValidatedRow,
} from './types'
import type { z } from 'zod'

/**
 * Get the validation schema for a specific item type
 */
function getSchemaForType(itemType: ImportItemType): z.ZodTypeAny {
  switch (itemType) {
    case 'Document':
      return importDocumentRowSchema
    case 'Issue':
      return importIssueRowSchema
    case 'Part':
    default:
      return importPartRowSchema
  }
}

/**
 * Normalize and coerce a value to the expected type for a field
 */
function coerceValue(
  field: string,
  value: unknown,
  itemType: ImportItemType = 'Part',
): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  const config = getFieldByType(itemType, field) || getFieldConfig(field)
  if (!config) return value

  const strValue = String(value).trim()

  switch (config.type) {
    case 'number': {
      const num = Number(strValue)
      if (isNaN(num)) return strValue // Return original for error reporting
      return num
    }
    case 'enum': {
      // Try to match enum value case-insensitively
      const lowerValue = strValue.toLowerCase()
      const matched = config.enumValues?.find(
        (ev) => ev.toLowerCase() === lowerValue,
      )
      return matched || strValue
    }
    case 'date': {
      // Return date strings as-is for now, validation happens in schema
      return strValue
    }
    default:
      return strValue
  }
}

/**
 * Validate a single mapped row for a specific item type
 */
function validateRow(
  mappedData: Record<string, unknown>,
  _rowNumber: number,
  itemType: ImportItemType = 'Part',
): {
  errors: Array<RowValidationError>
  warnings: Array<RowValidationWarning>
} {
  const errors: Array<RowValidationError> = []
  const warnings: Array<RowValidationWarning> = []

  // Coerce values to expected types
  const coercedData: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(mappedData)) {
    coercedData[field] = coerceValue(field, value, itemType)
  }

  // Set default revision if not provided (for Parts and Documents)
  if (itemType !== 'Issue' && !coercedData.revision) {
    coercedData.revision = '-'
  }

  // Validate against the appropriate schema
  const schema = getSchemaForType(itemType)
  const result = schema.safeParse(coercedData)

  if (!result.success) {
    for (const issue of result.error.issues) {
      const fieldPath = issue.path.join('.')
      const fieldConfig =
        getFieldByType(itemType, fieldPath) || getFieldConfig(fieldPath)
      errors.push({
        field: fieldConfig?.label || fieldPath,
        message: issue.message,
      })
    }
  }

  // Additional warnings
  if (coercedData.itemNumber) {
    // Warn about potential item number format issues
    const itemNumber = String(coercedData.itemNumber)
    if (!/^[A-Za-z0-9\-_]+$/.test(itemNumber)) {
      warnings.push({
        field:
          itemType === 'Part'
            ? 'Item Number'
            : itemType === 'Document'
              ? 'Document Number'
              : 'Issue Number',
        message: 'Contains special characters that may cause issues',
      })
    }
  }

  // Warn about missing optional but recommended fields
  if (!coercedData.description) {
    warnings.push({
      field: 'Description',
      message: 'No description provided',
    })
  }

  return { errors, warnings }
}

/**
 * Validate all rows and return validated row objects
 */
export function validateRows(
  rows: Array<Record<string, unknown>>,
  rawRows: Array<Record<string, unknown>>,
  itemType: ImportItemType = 'Part',
): Array<ValidatedRow> {
  const validatedRows: Array<ValidatedRow> = []
  const seenItemNumbers = new Map<string, number>() // itemNumber -> rowNumber

  for (let i = 0; i < rows.length; i++) {
    const mappedData = rows[i]
    const rawData = rawRows[i] || {}
    const rowNumber = i + 2 // +2 because row 1 is header, and we're 0-indexed

    // Coerce values
    const coercedData: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(mappedData)) {
      coercedData[field] = coerceValue(field, value, itemType)
    }

    // Set default revision if not provided (for Parts and Documents)
    if (itemType !== 'Issue' && !coercedData.revision) {
      coercedData.revision = '-'
    }

    const { errors, warnings } = validateRow(mappedData, rowNumber, itemType)

    // Check for duplicate item numbers within the file
    if (coercedData.itemNumber) {
      const itemNumber = String(coercedData.itemNumber).toLowerCase()
      const existingRow = seenItemNumbers.get(itemNumber)
      if (existingRow) {
        const fieldLabel =
          itemType === 'Part'
            ? 'Item Number'
            : itemType === 'Document'
              ? 'Document Number'
              : 'Issue Number'
        errors.push({
          field: fieldLabel,
          message: `Duplicate number - also appears in row ${existingRow}`,
        })
      } else {
        seenItemNumbers.set(itemNumber, rowNumber)
      }
    }

    validatedRows.push({
      rowNumber,
      rawData,
      mappedData: coercedData,
      errors,
      warnings,
      isValid: errors.length === 0,
    })
  }

  return validatedRows
}

/**
 * Get summary statistics from validated rows
 */
export function getValidationSummary(validatedRows: Array<ValidatedRow>): {
  totalRows: number
  validRows: number
  invalidRows: number
  warningRows: number
  errorsByField: Record<string, number>
} {
  const errorsByField: Record<string, number> = {}

  let validRows = 0
  let invalidRows = 0
  let warningRows = 0

  for (const row of validatedRows) {
    if (row.isValid) {
      validRows++
    } else {
      invalidRows++
    }

    if (row.warnings.length > 0) {
      warningRows++
    }

    for (const error of row.errors) {
      errorsByField[error.field] = (errorsByField[error.field] || 0) + 1
    }
  }

  return {
    totalRows: validatedRows.length,
    validRows,
    invalidRows,
    warningRows,
    errorsByField,
  }
}

/**
 * Filter validated rows to only include valid ones
 */
export function getValidRows(
  validatedRows: Array<ValidatedRow>,
): Array<ValidatedRow> {
  return validatedRows.filter((row) => row.isValid)
}

/**
 * Filter validated rows to only include invalid ones
 */
export function getInvalidRows(
  validatedRows: Array<ValidatedRow>,
): Array<ValidatedRow> {
  return validatedRows.filter((row) => !row.isValid)
}

/**
 * Check if all required fields have at least one non-empty value across rows.
 * Note: Required fields are already checked per-row in validateRow.
 * This function is a placeholder for potential aggregate checks.
 */
export function checkRequiredFieldsPresent(
  _validatedRows: Array<ValidatedRow>,
): { allPresent: boolean; missingFields: Array<string> } {
  // Required fields are checked per-row in validateRow
  // This function could be used for aggregate checks if needed
  return { allPresent: true, missingFields: [] }
}

/**
 * Validate BOM structure for circular references and external parent warnings
 */
export function validateBomStructure(
  relationships: Array<BomRelationship>,
): BomValidationResult {
  const errors: BomValidationResult['errors'] = []
  const warnings: BomValidationResult['warnings'] = []

  if (relationships.length === 0) {
    return { errors, warnings }
  }

  // Build adjacency list for cycle detection
  const parentToChildren = new Map<string, Array<string>>()
  for (const rel of relationships) {
    const parentKey = rel.parentItemNumber.toLowerCase()
    const childKey = rel.childItemNumber.toLowerCase()
    if (!parentToChildren.has(parentKey)) {
      parentToChildren.set(parentKey, [])
    }
    parentToChildren.get(parentKey)!.push(childKey)
  }

  // Detect circular references using DFS
  const visited = new Set<string>()
  const recursionStack = new Set<string>()
  const cycleNodes = new Set<string>()

  function detectCycle(node: string, path: Array<string>): boolean {
    visited.add(node)
    recursionStack.add(node)

    const children = parentToChildren.get(node) || []
    for (const child of children) {
      if (!visited.has(child)) {
        if (detectCycle(child, [...path, child])) {
          cycleNodes.add(node)
          return true
        }
      } else if (recursionStack.has(child)) {
        // Found a cycle
        cycleNodes.add(node)
        cycleNodes.add(child)
        return true
      }
    }

    recursionStack.delete(node)
    return false
  }

  // Run cycle detection from all parent nodes
  for (const parent of parentToChildren.keys()) {
    if (!visited.has(parent)) {
      detectCycle(parent, [parent])
    }
  }

  // Report circular reference errors
  if (cycleNodes.size > 0) {
    errors.push({
      type: 'circular_reference',
      message: `Circular references detected involving: ${[...cycleNodes].join(', ')}`,
    })
  }

  // Check for external parents (not in the import file)
  const externalParents = relationships
    .filter((r) => r.parentRowIndex === -1)
    .map((r) => r.parentItemNumber)
  const uniqueExternalParents = [...new Set(externalParents)]

  if (uniqueExternalParents.length > 0) {
    warnings.push({
      type: 'external_parent',
      message: `${uniqueExternalParents.length} parent(s) not found in file and will be looked up in existing items`,
      itemNumbers: uniqueExternalParents,
    })
  }

  // Check for self-references
  const selfReferences = relationships.filter(
    (r) => r.parentItemNumber.toLowerCase() === r.childItemNumber.toLowerCase(),
  )
  if (selfReferences.length > 0) {
    for (const rel of selfReferences) {
      errors.push({
        type: 'self_reference',
        message: `Item cannot be its own parent`,
        itemNumber: rel.childItemNumber,
      })
    }
  }

  return { errors, warnings }
}
