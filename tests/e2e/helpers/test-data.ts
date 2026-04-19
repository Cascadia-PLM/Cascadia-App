/**
 * Test Data Helpers
 *
 * Generate unique test data to avoid collisions between tests.
 */

/**
 * Generate a unique item number with prefix
 */
export function uniqueItemNumber(prefix: string): string {
  return `${prefix}-${Date.now()}`
}

/**
 * Generate a unique ECO number
 */
export function uniqueECONumber(): string {
  return uniqueItemNumber('ECO-E2E')
}

/**
 * Generate a unique part number
 */
export function uniquePartNumber(): string {
  return uniqueItemNumber('PN-E2E')
}

/**
 * Generate a unique document number
 */
export function uniqueDocNumber(): string {
  return uniqueItemNumber('DOC-E2E')
}

/**
 * Generate a unique requirement number
 */
export function uniqueReqNumber(): string {
  return uniqueItemNumber('REQ-E2E')
}

/**
 * Standard test item names
 */
export const TEST_NAMES = {
  PART: 'E2E Test Part',
  DOCUMENT: 'E2E Test Document',
  REQUIREMENT: 'E2E Test Requirement',
  ECO: 'E2E Test Change Order',
} as const
