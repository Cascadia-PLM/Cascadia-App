// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Test Data Helpers
 *
 * Generate unique test data to avoid collisions between tests.
 */

import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/** The fields of a seeded item every caller here actually reads. */
export interface SeededItem {
  id: string
  masterId?: string
  itemNumber: string
  name: string
}

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

/**
 * Seed a Part over the API and return the row.
 *
 * Extracted from physical-traceability.spec.ts, which was the first spec to
 * decide that its prerequisites are seeded rather than found: a journey that
 * opens a list and takes the first row asserts things about whatever else has
 * run, and passes on an empty database having asserted nothing.
 */
export async function seedPart(
  page: Page,
  designId: string,
  data: {
    itemNumber: string
    name: string
    trackingMode?: 'none' | 'lot' | 'serial'
    state?: string
  },
): Promise<SeededItem> {
  const response = await page.request.post('/api/v1/items', {
    data: {
      itemType: 'Part',
      designId,
      revision: 'A',
      partType: 'Manufacture',
      ...data,
    },
  })
  expect(response.ok(), `part seed failed: ${await response.text()}`).toBe(true)
  return (await response.json()).data.item as SeededItem
}

/** Seed a Requirement over the API and return the row. */
export async function seedRequirement(
  page: Page,
  designId: string,
  data: { itemNumber: string; name: string; priority?: string },
): Promise<SeededItem> {
  const response = await page.request.post('/api/v1/items', {
    data: { itemType: 'Requirement', designId, revision: 'A', ...data },
  })
  expect(
    response.ok(),
    `requirement seed failed: ${await response.text()}`,
  ).toBe(true)
  return (await response.json()).data.item as SeededItem
}

/** A BOM edge between two seeded items. */
export async function seedBomEdge(
  page: Page,
  parentId: string,
  childId: string,
  quantity: string,
): Promise<void> {
  const response = await page.request.post(
    `/api/v1/items/${parentId}/relationships`,
    { data: { targetId: childId, relationshipType: 'BOM', quantity } },
  )
  expect(response.ok(), `BOM edge seed failed: ${await response.text()}`).toBe(
    true,
  )
}
