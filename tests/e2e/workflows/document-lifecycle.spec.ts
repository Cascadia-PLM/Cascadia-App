// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Document Lifecycle E2E Workflow Tests
 *
 * Core workflow coverage.
 * Tests the complete document lifecycle: Create → Edit → Delete
 */

import { expect, test } from '../fixtures'
import { seedFreshDesign, selectDesignByName } from '../seed'
import type { Page } from '@playwright/test'

/**
 * Helper to fill a form field
 * Uses fill() which is more reliable for React controlled inputs
 */
async function fillField(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  const field = page.locator(selector)
  await field.waitFor({ state: 'visible' })
  await field.fill(value)
}

test.describe('Document Lifecycle Workflow', () => {
  // Store created document ID for cleanup
  let createdDocumentId: string | null = null

  test.afterEach(async ({ authenticatedPage: page }) => {
    // Cleanup: Try to delete the document if it was created
    if (createdDocumentId) {
      try {
        // Delete through the API, not the UI — see the note in
        // part-lifecycle.spec.ts: a visibility-guarded click made cleanup a
        // no-op whenever the page had no Delete button.
        await page.request.delete(`/api/v1/documents/${createdDocumentId}`)
      } catch {
        // Ignore cleanup errors
      }
      createdDocumentId = null
    }
  })

  test('complete document lifecycle: create, view, and verify', async ({
    authenticatedPage: page,
  }) => {
    const design = await seedFreshDesign(page, 'E2E Doc Lifecycle')

    // 1. Navigate to create document page and pick the seeded design
    await page.goto('/documents/new')
    await selectDesignByName(page, design.name)

    // 2. Fill in document details using focus + pressSequentially
    const timestamp = Date.now()
    const itemNumber = `DOC-LIFECYCLE-${timestamp}`
    const docName = 'Lifecycle Test Document'

    await fillField(page, '[data-testid="document-item-number"]', itemNumber)
    await fillField(page, '[data-testid="document-name"]', docName)

    // 3. Submit the form
    await page.click('[data-testid="document-submit"]')

    // 4. Wait for navigation to detail page
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+(\?.*)?$/, {
      timeout: 10000,
    })

    // Extract document ID from URL for cleanup
    const url = page.url()
    createdDocumentId = url.split('/').pop() || null

    // 5. Verify we're on the document detail page with correct data
    // Use first() because the item number appears in both the banner and the heading
    await expect(page.locator(`text=${itemNumber}`).first()).toBeVisible({
      timeout: 5000,
    })
  })

  test('can navigate to create document page from list', async ({
    authenticatedPage: page,
  }) => {
    // Navigate to documents list
    await page.goto('/documents')

    // Click create document button
    await page.click('[data-testid="create-document-button"]')

    // Should navigate to new document page
    await expect(page).toHaveURL(/\/documents\/new/)
  })

  test('create document form displays all required fields', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/documents/new')

    // Verify form is visible
    await expect(page.locator('[data-testid="document-form"]')).toBeVisible()

    // Verify key form fields are present
    await expect(page.locator('[data-testid="design-selector"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="document-item-number"]'),
    ).toBeVisible()
    await expect(page.locator('[data-testid="document-name"]')).toBeVisible()
    await expect(page.locator('[data-testid="document-submit"]')).toBeVisible()
  })

  test('document appears in documents list after creation', async ({
    authenticatedPage: page,
  }) => {
    // 1. Create a document on a seeded design
    const design = await seedFreshDesign(page, 'E2E Doc List')

    await page.goto('/documents/new')
    await selectDesignByName(page, design.name)

    const timestamp = Date.now()
    const itemNumber = `DOC-LIST-${timestamp}`

    await fillField(page, '[data-testid="document-item-number"]', itemNumber)
    await fillField(
      page,
      '[data-testid="document-name"]',
      'Document for List Test',
    )
    await page.click('[data-testid="document-submit"]')

    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+(\?.*)?$/, {
      timeout: 10000,
    })

    const url = page.url()
    createdDocumentId = url.split('/').pop() || null

    // 2. Navigate to documents list
    await page.goto('/documents')

    // 3. Search for the created document (using focus + pressSequentially)
    // The grid's own search box, by accessible name — the old placeholder
    // selector also matched the header's global search bar.
    const searchInput = page.getByRole('textbox', { name: 'Search table' })
    await searchInput.focus()
    await page.waitForTimeout(100)
    await searchInput.pressSequentially(itemNumber, { delay: 30 })
    // Give time for search to filter
    await page.waitForTimeout(500)

    // 4. Verify document appears in the list
    await expect(page.locator(`text=${itemNumber}`)).toBeVisible({
      timeout: 5000,
    })
  })
})
