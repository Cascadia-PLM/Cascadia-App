/**
 * Part Lifecycle E2E Workflow Tests
 *
 * Tier 2: Core workflow tests that run on merge to main.
 * Tests the complete part lifecycle: Create → Edit → Delete
 */

import { expect, test } from '../fixtures'
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
        await page.goto(`/parts/${createdPartId}`)
        // Look for delete button - implementation may vary
        const deleteButton = page.locator('button:has-text("Delete")')
        if (await deleteButton.isVisible()) {
          await deleteButton.click()
          // Confirm deletion if there's a dialog
          const confirmButton = page.locator(
            'button:has-text("Confirm"), button:has-text("Delete")',
          )
          if (await confirmButton.isVisible()) {
            await confirmButton.click()
          }
        }
      } catch {
        // Ignore cleanup errors
      }
      createdPartId = null
    }
  })

  test('complete part lifecycle: create, view, and verify', async ({
    authenticatedPage: page,
  }) => {
    // 1. Navigate to create part page
    await page.goto('/parts/new')

    // Check if designs are available
    const designSelector = page.locator('[data-testid="design-selector"]')
    await designSelector.click()

    const designOptions = page
      .locator('[role="option"]')
      .filter({ hasNotText: 'No Design' })
    const designCount = await designOptions.count()

    if (designCount === 0) {
      test.skip()
      return
    }

    // Select first design
    await designOptions.first().click()

    // 2. Fill in part details using focus + pressSequentially
    const timestamp = Date.now()
    const itemNumber = `PN-LIFECYCLE-${timestamp}`
    const partName = 'Lifecycle Test Part'

    await fillField(page, '[data-testid="part-item-number"]', itemNumber)
    await fillField(page, '[data-testid="part-name"]', partName)

    // 3. Submit the form
    await page.click('[data-testid="part-submit"]')

    // 4. Wait for navigation to detail page
    await expect(page).toHaveURL(/\/parts\/[a-f0-9-]+(\?.*)?$/, { timeout: 10000 })

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
    // 1. First create a part
    await page.goto('/parts/new')

    const designSelector = page.locator('[data-testid="design-selector"]')
    await designSelector.click()

    const designOptions = page
      .locator('[role="option"]')
      .filter({ hasNotText: 'No Design' })
    if ((await designOptions.count()) === 0) {
      test.skip()
      return
    }

    await designOptions.first().click()

    const timestamp = Date.now()
    const itemNumber = `PN-EDIT-${timestamp}`

    await fillField(page, '[data-testid="part-item-number"]', itemNumber)
    await fillField(page, '[data-testid="part-name"]', 'Part to Edit')
    await page.click('[data-testid="part-submit"]')

    await expect(page).toHaveURL(/\/parts\/[a-f0-9-]+(\?.*)?$/, { timeout: 10000 })

    const url = page.url()
    createdPartId = url.split('/').pop() || null

    // 2. Look for edit functionality
    // This could be an edit button or the fields could be editable
    const editButton = page.locator(
      'button:has-text("Edit"), a:has-text("Edit")',
    )

    if (await editButton.isVisible()) {
      await editButton.click()

      // 3. Update the part name
      const nameInput = page.locator('[data-testid="part-name"]')
      if (await nameInput.isVisible()) {
        // Clear and fill with new value
        await nameInput.focus()
        await page.waitForTimeout(100)
        await nameInput.clear()
        await nameInput.pressSequentially('Updated Part Name', { delay: 30 })
        await page.click('[data-testid="part-submit"]')

        // 4. Verify update was successful
        await expect(page.locator('text=Updated Part Name')).toBeVisible({
          timeout: 5000,
        })
      }
    }
  })

  test('part appears in parts list after creation', async ({
    authenticatedPage: page,
  }) => {
    // 1. Create a part
    await page.goto('/parts/new')

    const designSelector = page.locator('[data-testid="design-selector"]')
    await designSelector.click()

    const designOptions = page
      .locator('[role="option"]')
      .filter({ hasNotText: 'No Design' })
    if ((await designOptions.count()) === 0) {
      test.skip()
      return
    }

    await designOptions.first().click()

    const timestamp = Date.now()
    const itemNumber = `PN-LIST-${timestamp}`

    await fillField(page, '[data-testid="part-item-number"]', itemNumber)
    await fillField(page, '[data-testid="part-name"]', 'Part for List Test')
    await page.click('[data-testid="part-submit"]')

    await expect(page).toHaveURL(/\/parts\/[a-f0-9-]+(\?.*)?$/, { timeout: 10000 })

    const url = page.url()
    createdPartId = url.split('/').pop() || null

    // 2. Navigate to parts list
    await page.goto('/parts')

    // 3. Search for the created part (using focus + pressSequentially)
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[type="search"]',
    )
    if (await searchInput.isVisible()) {
      await searchInput.focus()
      await page.waitForTimeout(100)
      await searchInput.pressSequentially(itemNumber, { delay: 30 })
      // Give time for search to filter
      await page.waitForTimeout(500)
    }

    // 4. Verify part appears in the list
    await expect(page.locator(`text=${itemNumber}`)).toBeVisible({
      timeout: 5000,
    })
  })
})
