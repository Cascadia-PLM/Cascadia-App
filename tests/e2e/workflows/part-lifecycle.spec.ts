// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Part Lifecycle E2E Workflow Tests
 *
 * Core workflow coverage.
 * Tests the complete part lifecycle: Create → Edit → Delete
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

test.describe('Part Lifecycle Workflow', () => {
  // Store created part ID for cleanup
  let createdPartId: string | null = null

  test.afterEach(async ({ authenticatedPage: page }) => {
    // Cleanup: Try to delete the part if it was created
    if (createdPartId) {
      try {
        // Delete through the API, not the UI: the old version clicked a
        // Delete button only if it happened to be visible, so cleanup
        // silently did nothing whenever the page was in a state without one.
        await page.request.delete(`/api/v1/parts/${createdPartId}`)
      } catch {
        // Ignore cleanup errors
      }
      createdPartId = null
    }
  })

  test('complete part lifecycle: create, view, and verify', async ({
    authenticatedPage: page,
  }) => {
    const design = await seedFreshDesign(page, 'E2E Part Lifecycle')

    // 1. Navigate to create part page and pick the seeded design
    await page.goto('/parts/new')
    await selectDesignByName(page, design.name)

    // 2. Fill in part details using focus + pressSequentially
    const timestamp = Date.now()
    const itemNumber = `PN-LIFECYCLE-${timestamp}`
    const partName = 'Lifecycle Test Part'

    await fillField(page, '[data-testid="part-item-number"]', itemNumber)
    await fillField(page, '[data-testid="part-name"]', partName)

    // 3. Submit the form
    await page.click('[data-testid="part-submit"]')

    // 4. Wait for navigation to detail page
    await expect(page).toHaveURL(/\/parts\/[a-f0-9-]+(\?.*)?$/, {
      timeout: 10000,
    })

    // Extract part ID from URL for cleanup
    const url = page.url()
    createdPartId = url.split('/').pop() || null

    // 5. Verify we're on the part detail page with correct data
    // Use first() because the item number appears in both the banner and the heading
    await expect(page.locator(`text=${itemNumber}`).first()).toBeVisible({
      timeout: 5000,
    })
  })

  test('can edit an existing part', async ({ authenticatedPage: page }) => {
    const design = await seedFreshDesign(page, 'E2E Part Edit')

    // 1. First create a part on the seeded design
    await page.goto('/parts/new')
    await selectDesignByName(page, design.name)

    const timestamp = Date.now()
    const itemNumber = `PN-EDIT-${timestamp}`

    await fillField(page, '[data-testid="part-item-number"]', itemNumber)
    await fillField(page, '[data-testid="part-name"]', 'Part to Edit')
    await page.click('[data-testid="part-submit"]')

    await expect(page).toHaveURL(/\/parts\/[a-f0-9-]+(\?.*)?$/, {
      timeout: 10000,
    })

    const url = page.url()
    createdPartId = url.split('/').pop() || null

    // 2. Look for edit functionality
    // This could be an edit button or the fields could be editable
    const editButton = page.locator(
      'button:has-text("Edit"), a:has-text("Edit")',
    )

    await editButton.click()

    // 3. Update the part name
    const nameInput = page.locator('[data-testid="part-name"]')
    await nameInput.focus()
    await page.waitForTimeout(100)
    await nameInput.clear()
    await nameInput.pressSequentially('Updated Part Name', { delay: 30 })
    await page.click('[data-testid="part-submit"]')

    // 4. Verify update was successful
    // Use an exact match: the name also appears in the "Revision - • Updated
    // Part Name" subtitle, so a substring match trips Playwright strict mode.
    await expect(
      page.getByText('Updated Part Name', { exact: true }),
    ).toBeVisible({
      timeout: 5000,
    })
  })

  test('part appears in parts list after creation', async ({
    authenticatedPage: page,
  }) => {
    const design = await seedFreshDesign(page, 'E2E Part List')

    // 1. Create a part on the seeded design
    await page.goto('/parts/new')
    await selectDesignByName(page, design.name)

    const timestamp = Date.now()
    const itemNumber = `PN-LIST-${timestamp}`

    await fillField(page, '[data-testid="part-item-number"]', itemNumber)
    await fillField(page, '[data-testid="part-name"]', 'Part for List Test')
    await page.click('[data-testid="part-submit"]')

    await expect(page).toHaveURL(/\/parts\/[a-f0-9-]+(\?.*)?$/, {
      timeout: 10000,
    })

    const url = page.url()
    createdPartId = url.split('/').pop() || null

    // 2. Navigate to parts list
    await page.goto('/parts')

    // 3. Search for the created part (using focus + pressSequentially)
    // The grid's own search box, by accessible name — the old placeholder
    // selector also matched the header's global search bar.
    const searchInput = page.getByRole('textbox', { name: 'Search table' })
    await searchInput.focus()
    await page.waitForTimeout(100)
    await searchInput.pressSequentially(itemNumber, { delay: 30 })
    // Give time for search to filter
    await page.waitForTimeout(500)

    // 4. Verify part appears in the list
    await expect(page.locator(`text=${itemNumber}`)).toBeVisible({
      timeout: 5000,
    })
  })
})
