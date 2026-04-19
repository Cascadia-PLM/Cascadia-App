/**
 * Create Item E2E Smoke Tests
 *
 * Tier 1: Critical path tests that run on every PR.
 * Tests that the create part flow works end-to-end.
 */

import { expect, test } from './fixtures'
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

test.describe('Create Item - Smoke Tests @tier1', () => {
  test.describe('Create Part Page', () => {
    test('can navigate to create part page', async ({
      authenticatedPage: page,
    }) => {
      // Navigate to parts list
      await page.goto('/parts')

      // Click create part button
      await page.click('[data-testid="create-part-button"]')

      // Should navigate to new part page
      await expect(page).toHaveURL(/\/parts\/new/)
    })

    test('create part form displays all required fields', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts/new')

      // Verify form is visible
      await expect(page.locator('[data-testid="part-form"]')).toBeVisible()

      // Verify key form fields are present
      await expect(
        page.locator('[data-testid="design-selector"]'),
      ).toBeVisible()
      await expect(
        page.locator('[data-testid="part-item-number"]'),
      ).toBeVisible()
      await expect(page.locator('[data-testid="part-name"]')).toBeVisible()
      await expect(page.locator('[data-testid="part-submit"]')).toBeVisible()
    })

    test('can fill in part form fields', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts/new')

      // Fill in the basic fields using focus + pressSequentially
      const timestamp = Date.now()
      await fillField(
        page,
        '[data-testid="part-item-number"]',
        `PN-E2E-${timestamp}`,
      )
      await fillField(page, '[data-testid="part-name"]', 'E2E Test Part')

      // Verify fields contain the values
      await expect(
        page.locator('[data-testid="part-item-number"]'),
      ).toHaveValue(`PN-E2E-${timestamp}`)
      await expect(page.locator('[data-testid="part-name"]')).toHaveValue(
        'E2E Test Part',
      )
    })
  })

  test.describe('Create Part Flow', () => {
    test('can create a new part when design is available', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts/new')

      // Check if there are designs available
      const designSelector = page.locator('[data-testid="design-selector"]')
      await designSelector.click()

      // Look for design options (excluding "No Design")
      const designOptions = page
        .locator('[role="option"]')
        .filter({ hasNotText: 'No Design' })
      const designCount = await designOptions.count()

      if (designCount === 0) {
        // Skip test if no designs available - this is expected in fresh databases
        test.skip()
        return
      }

      // Select the first available design
      await designOptions.first().click()

      // Fill in required fields using focus + pressSequentially
      const timestamp = Date.now()
      await fillField(
        page,
        '[data-testid="part-item-number"]',
        `PN-SMOKE-${timestamp}`,
      )
      await fillField(page, '[data-testid="part-name"]', 'Smoke Test Part')

      // Submit the form
      await page.click('[data-testid="part-submit"]')

      // Should navigate to the created part's detail page
      await expect(page).toHaveURL(/\/parts\/[a-f0-9-]+(\?.*)?$/, {
        timeout: 10000,
      })
    })
  })
})
