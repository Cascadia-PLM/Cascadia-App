import type {
  BomDetectionResult,
  BomRelationship,
  ColumnMapping,
  ValidatedRow,
} from './types'

/**
 * Detect BOM format based on mapped columns
 */
export function detectBomFormat(
  mappings: Array<ColumnMapping>,
): BomDetectionResult {
  const mappedFields = new Set(
    mappings.filter((m) => m.targetField).map((m) => m.targetField),
  )

  const hasLevel = mappedFields.has('level')
  const hasParent = mappedFields.has('parentItemNumber')
  const hasQuantity = mappedFields.has('quantity')

  // Determine format and confidence
  let format: BomDetectionResult['format'] = 'flat'
  let confidence = 1.0

  if (hasLevel && hasParent) {
    // Both columns present - prefer level-based but lower confidence
    format = 'level-based'
    confidence = 0.7
  } else if (hasLevel) {
    format = 'level-based'
    confidence = hasQuantity ? 0.95 : 0.85
  } else if (hasParent) {
    format = 'parent-child'
    confidence = hasQuantity ? 0.95 : 0.85
  } else {
    format = 'flat'
    confidence = 1.0
  }

  return {
    format,
    hasLevel,
    hasParent,
    hasQuantity,
    confidence,
  }
}

/**
 * Extract BOM relationships from validated rows based on detected format
 */
export function extractBomRelationships(
  validatedRows: Array<ValidatedRow>,
  format: BomDetectionResult,
): Array<BomRelationship> {
  if (format.format === 'flat') {
    return []
  }

  // Only process valid rows with item numbers
  const validRowsWithItemNumber = validatedRows.filter(
    (row) => row.isValid && row.mappedData.itemNumber,
  )

  if (format.format === 'level-based') {
    return extractLevelBasedRelationships(validRowsWithItemNumber)
  } else {
    return extractParentChildRelationships(
      validRowsWithItemNumber,
      validatedRows,
    )
  }
}

/**
 * Extract relationships from level-based (indented) BOM format
 *
 * Algorithm:
 * 1. Maintain a stack of { level, itemNumber, rowIndex }
 * 2. For each row:
 *    - Pop items from stack until current level > top of stack level
 *    - Top of stack (if exists) is the parent
 *    - Push current item onto stack
 */
function extractLevelBasedRelationships(
  validRows: Array<ValidatedRow>,
): Array<BomRelationship> {
  const relationships: Array<BomRelationship> = []
  const stack: Array<{ level: number; itemNumber: string; rowIndex: number }> =
    []

  for (let i = 0; i < validRows.length; i++) {
    const row = validRows[i]
    const level = Number(row.mappedData.level) || 0
    const itemNumber = String(row.mappedData.itemNumber)
    const quantity = Number(row.mappedData.quantity) || 1
    const findNumber =
      row.mappedData.findNumber !== undefined
        ? Number(row.mappedData.findNumber)
        : undefined
    const referenceDesignator =
      row.mappedData.referenceDesignator !== undefined
        ? String(row.mappedData.referenceDesignator)
        : undefined

    // Pop items from stack until we find a parent (level < current level)
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop()
    }

    // If stack has items, top is the parent
    if (stack.length > 0) {
      const parent = stack[stack.length - 1]
      relationships.push({
        parentRowIndex: parent.rowIndex,
        childRowIndex: i,
        parentItemNumber: parent.itemNumber,
        childItemNumber: itemNumber,
        quantity,
        findNumber,
        referenceDesignator,
      })
    }

    // Push current item onto stack
    stack.push({ level, itemNumber, rowIndex: i })
  }

  return relationships
}

/**
 * Extract relationships from parent-child column format
 *
 * Algorithm:
 * 1. Build itemNumber -> rowIndex map from all valid rows
 * 2. For each row with parentItemNumber:
 *    - Lookup parent row index (or -1 if external)
 *    - Create relationship
 */
function extractParentChildRelationships(
  validRows: Array<ValidatedRow>,
  _allValidatedRows: Array<ValidatedRow>,
): Array<BomRelationship> {
  const relationships: Array<BomRelationship> = []

  // Build map of itemNumber -> rowIndex for all valid rows
  const itemNumberToRowIndex = new Map<string, number>()
  for (let i = 0; i < validRows.length; i++) {
    const itemNumber = String(validRows[i].mappedData.itemNumber).toLowerCase()
    itemNumberToRowIndex.set(itemNumber, i)
  }

  for (let i = 0; i < validRows.length; i++) {
    const row = validRows[i]
    const parentItemNumber = row.mappedData.parentItemNumber

    // Skip rows without parent reference
    if (!parentItemNumber) {
      continue
    }

    const parentItemNumberStr = String(parentItemNumber)
    const parentItemNumberLower = parentItemNumberStr.toLowerCase()
    const childItemNumber = String(row.mappedData.itemNumber)
    const quantity = Number(row.mappedData.quantity) || 1
    const findNumber =
      row.mappedData.findNumber !== undefined
        ? Number(row.mappedData.findNumber)
        : undefined
    const referenceDesignator =
      row.mappedData.referenceDesignator !== undefined
        ? String(row.mappedData.referenceDesignator)
        : undefined

    // Find parent row index
    const parentRowIndex = itemNumberToRowIndex.get(parentItemNumberLower) ?? -1

    relationships.push({
      parentRowIndex,
      childRowIndex: i,
      parentItemNumber: parentItemNumberStr,
      childItemNumber,
      quantity,
      findNumber,
      referenceDesignator,
    })
  }

  return relationships
}

/**
 * Get a summary of BOM relationships for display
 */
export function getBomSummary(relationships: Array<BomRelationship>): {
  totalRelationships: number
  externalParentCount: number
  uniqueParents: number
  uniqueChildren: number
} {
  const externalParentCount = relationships.filter(
    (r) => r.parentRowIndex === -1,
  ).length
  const uniqueParents = new Set(
    relationships.map((r) => r.parentItemNumber.toLowerCase()),
  ).size
  const uniqueChildren = new Set(
    relationships.map((r) => r.childItemNumber.toLowerCase()),
  ).size

  return {
    totalRelationships: relationships.length,
    externalParentCount,
    uniqueParents,
    uniqueChildren,
  }
}
