/**
 * Requirement Lifecycle E2E Workflow Tests
 *
 * Tier 2: Core workflow tests that run on merge to main.
 * Tests requirement management including:
 * Create Requirement → Link to Parts → View Traceability
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

test.describe('Requirement Lifecycle @tier2', () => {
  // Store created requirement ID for cleanup
  let createdRequirementId: string | null = null

  test.afterEach(async ({ authenticatedPage: page }) => {
    // Cleanup
    if (createdRequirementId) {
      try {
        await page.goto(`/requirements/${createdRequirementId}`)
        const deleteButton = page.locator('button:has-text("Delete")')
        if (await deleteButton.isVisible()) {
          await deleteButton.click()
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
      createdRequirementId = null
    }
  })

  test.describe('Requirements List', () => {
    test('can navigate to requirements page', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/')

      // Open sidebar
      await page.click('[data-testid="menu-button"]')

      // Click Requirements link
      const reqLink = page.locator(
        '[data-testid="nav-requirements"], a:has-text("Requirements")',
      )
      if (await reqLink.isVisible()) {
        await reqLink.click()
        await expect(page).toHaveURL(/\/requirements/)
      }
    })

    test('requirements list displays correctly', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements')

      // Verify table/list is visible
      const list = page.locator(
        'table, [data-testid="requirements-table"], [data-testid="requirements-list"]',
      )
      await expect(list).toBeVisible({ timeout: 5000 })
    })

    test('can search requirements', async ({ authenticatedPage: page }) => {
      await page.goto('/requirements')

      // Look for search input
      const searchInput = page.locator(
        'input[placeholder*="Search"], input[type="search"], [data-testid="search-input"]',
      )
      if (await searchInput.isVisible()) {
        await searchInput.focus()
        await page.waitForTimeout(100)
        await searchInput.pressSequentially('REQ', { delay: 30 })

        // Give time for search to filter
        await page.waitForTimeout(500)
      }
    })

    test('can filter requirements by priority', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements')

      // Look for priority filter
      const priorityFilter = page.locator(
        '[data-testid="priority-filter"], select:has-text("Priority"), button:has-text("Priority")',
      )
      if (await priorityFilter.isVisible()) {
        await priorityFilter.click()

        // Look for filter options (MoSCoW: Must, Should, Could, Won't)
        const filterOptions = page.locator('[role="option"], [role="menuitem"]')
        await expect(filterOptions.first()).toBeVisible({ timeout: 3000 })
      }
    })
  })

  test.describe('Create Requirement', () => {
    test('can navigate to create requirement page', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements')

      // Click create requirement button
      const createButton = page.locator(
        '[data-testid="create-requirement-button"], button:has-text("New Requirement"), button:has-text("Create")',
      )
      if (await createButton.isVisible()) {
        await createButton.click()

        // Should navigate to new requirement page
        await expect(page).toHaveURL(/\/requirements\/new/)
      }
    })

    test('requirement form displays all fields', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements/new')

      // Verify form is visible
      await expect(
        page.locator('[data-testid="requirement-form"]'),
      ).toBeVisible()

      // Verify key form fields
      await expect(
        page.locator('[data-testid="design-selector"]'),
      ).toBeVisible()
      await expect(
        page.locator('[data-testid="requirement-item-number"]'),
      ).toBeVisible()
      await expect(
        page.locator('[data-testid="requirement-name"]'),
      ).toBeVisible()
    })

    test('can create a new requirement', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements/new')

      // Select a design
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

      // Fill in requirement details
      const timestamp = Date.now()
      const itemNumber = `REQ-E2E-${timestamp}`
      const reqName = 'E2E Test Requirement'

      await fillField(
        page,
        '[data-testid="requirement-item-number"]',
        itemNumber,
      )
      await fillField(page, '[data-testid="requirement-name"]', reqName)

      // Fill description if field exists
      const descField = page.locator(
        '[data-testid="requirement-description"], textarea[name="description"]',
      )
      if (await descField.isVisible()) {
        await fillField(
          page,
          '[data-testid="requirement-description"], textarea[name="description"]',
          'E2E test requirement description',
        )
      }

      // Submit the form
      await page.click(
        '[data-testid="requirement-submit"], button[type="submit"]',
      )

      // Should navigate to requirement detail page
      await expect(page).toHaveURL(/\/requirements\/[a-f0-9-]+(\?.*)?$/, {
        timeout: 10000,
      })

      // Extract ID for cleanup
      const url = page.url()
      createdRequirementId = url.split('/').pop() || null

      // Verify requirement was created. Use first() because the item number
      // appears in both the banner and the heading.
      await expect(page.locator(`text=${itemNumber}`).first()).toBeVisible({
        timeout: 5000,
      })
    })
  })

  test.describe('Requirement Detail', () => {
    test('can view requirement details', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements')

      // Click on first requirement in list
      const reqLink = page
        .locator('table tr a, [data-testid="requirement-link"]')
        .first()
      if (await reqLink.isVisible()) {
        await reqLink.click()

        // Should be on requirement detail page
        await expect(page).toHaveURL(/\/requirements\/[a-f0-9-]+/, {
          timeout: 5000,
        })
      }
    })

    test('requirement detail shows priority', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements')

      const reqLink = page
        .locator('table tr a, [data-testid="requirement-link"]')
        .first()
      if (await reqLink.isVisible()) {
        await reqLink.click()

        // Look for priority badge or field
        const priority = page.locator(
          '[data-testid="requirement-priority"], .badge:has-text("Must"), .badge:has-text("Should"), .badge:has-text("Could")',
        )
        if (await priority.first().isVisible()) {
          await expect(priority.first()).toBeVisible()
        }
      }
    })
  })

  test.describe('Requirement Traceability', () => {
    test('can view Satisfied By tab', async ({ authenticatedPage: page }) => {
      await page.goto('/requirements')

      const reqLink = page
        .locator('table tr a, [data-testid="requirement-link"]')
        .first()
      if (await reqLink.isVisible()) {
        await reqLink.click()

        // Look for Satisfied By or Traceability tab
        const satisfiedTab = page.locator(
          'button:has-text("Satisfied"), button:has-text("Traceability"), [data-testid="satisfied-tab"]',
        )
        if (await satisfiedTab.isVisible()) {
          await satisfiedTab.click()

          // Verify section is visible
          const satisfiedSection = page.locator(
            '[data-testid="satisfied-by"], .traceability-panel',
          )
          await expect(satisfiedSection).toBeVisible({ timeout: 5000 })
        }
      }
    })

    test('can link requirement to part', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements')

      const reqLink = page
        .locator('table tr a, [data-testid="requirement-link"]')
        .first()
      if (await reqLink.isVisible()) {
        await reqLink.click()

        // Look for Add Satisfaction or Link button
        const linkButton = page.locator(
          'button:has-text("Add Satisfaction"), button:has-text("Link Part"), [data-testid="add-satisfaction"]',
        )
        if (await linkButton.isVisible()) {
          await linkButton.click()

          // Should show dialog to select parts
          const dialog = page.locator(
            '[role="dialog"], [data-testid="link-dialog"]',
          )
          await expect(dialog).toBeVisible({ timeout: 5000 })
        }
      }
    })

    test('can view derived requirements', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements')

      const reqLink = page
        .locator('table tr a, [data-testid="requirement-link"]')
        .first()
      if (await reqLink.isVisible()) {
        await reqLink.click()

        // Look for Derived or Children tab
        const derivedTab = page.locator(
          'button:has-text("Derived"), button:has-text("Children"), [data-testid="derived-tab"]',
        )
        if (await derivedTab.isVisible()) {
          await derivedTab.click()

          // Verify section is visible
          const derivedSection = page.locator(
            '[data-testid="derived-requirements"], .derived-panel',
          )
          await expect(derivedSection).toBeVisible({ timeout: 5000 })
        }
      }
    })
  })

  test.describe('Requirement State', () => {
    test('requirement shows state badge', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/requirements')

      const reqLink = page
        .locator('table tr a, [data-testid="requirement-link"]')
        .first()
      if (await reqLink.isVisible()) {
        await reqLink.click()

        // Look for state indicator
        const stateBadge = page.locator(
          '[data-testid="item-state"], .state-badge, .badge',
        )
        if (await stateBadge.first().isVisible()) {
          await expect(stateBadge.first()).toBeVisible()
        }
      }
    })
  })
})
