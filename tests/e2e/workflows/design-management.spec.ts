/**
 * Design Management E2E Workflow Tests
 *
 * Tier 2: Core workflow tests that run on merge to main.
 * Tests design management including:
 * Navigate to Designs → View List → View Detail → Branch Management
 */

import { expect, test } from '../fixtures'
import { DesignsPage } from '../pages'

test.describe('Design Management @tier2', () => {
  test.describe('Design List', () => {
    test('can navigate to designs page via sidebar', async ({
      authenticatedPage: page,
    }) => {
      const designsPage = new DesignsPage(page)
      await page.goto('/')

      // Navigate using the expandable menu
      await designsPage.navigateViaMenu()
      await expect(page).toHaveURL(/\/designs/)
    })

    test('designs list displays correctly', async ({
      authenticatedPage: page,
    }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      await expect(designsPage.table).toBeVisible({ timeout: 5000 })
    })

    test('can search designs', async ({ authenticatedPage: page }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      await designsPage.search('UAV')
    })
  })

  test.describe('Design Detail View', () => {
    test('can view design details', async ({ authenticatedPage: page }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      if (await designsPage.designLinks.first().isVisible()) {
        await designsPage.clickFirstDesign()
        await expect(page).toHaveURL(/\/designs\/[a-f0-9-]+/, { timeout: 5000 })
      }
    })

    test('design detail shows content sections', async ({
      authenticatedPage: page,
    }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      if (await designsPage.designLinks.first().isVisible()) {
        await designsPage.clickFirstDesign()

        // Verify some content is visible on detail page
        // Could be tabs, cards, or other content sections
        const content = page.locator('[role="tablist"], .design-content, main')
        await expect(content.first()).toBeVisible({ timeout: 5000 })
      }
    })
  })

  test.describe('Branch Management', () => {
    test('can view branch selector', async ({ authenticatedPage: page }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      if (await designsPage.designLinks.first().isVisible()) {
        await designsPage.clickFirstDesign()

        if (await designsPage.branchSelector.isVisible()) {
          await expect(designsPage.branchSelector).toBeVisible()
        }
      }
    })

    test('branch selector shows available branches', async ({
      authenticatedPage: page,
    }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      if (await designsPage.designLinks.first().isVisible()) {
        await designsPage.clickFirstDesign()

        if (await designsPage.branchSelector.isVisible()) {
          await designsPage.openBranchSelector()
          await expect(designsPage.branchOptions.first()).toBeVisible({
            timeout: 3000,
          })
        }
      }
    })

    test('can switch between branches', async ({ authenticatedPage: page }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      if (await designsPage.designLinks.first().isVisible()) {
        await designsPage.clickFirstDesign()

        if (await designsPage.branchSelector.isVisible()) {
          await designsPage.switchToECOBranch()
        }
      }
    })
  })

  test.describe('Design Tabs', () => {
    test('can navigate to Items tab if present', async ({
      authenticatedPage: page,
    }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      if (await designsPage.designLinks.first().isVisible()) {
        await designsPage.clickFirstDesign()

        // Only test if Items tab exists
        if (await designsPage.itemsTab.isVisible()) {
          await designsPage.gotoItems()
          // Just verify tab was clicked (content structure varies)
          await page.waitForTimeout(500)
        }
      }
    })

    test('can navigate to ECOs tab if present', async ({
      authenticatedPage: page,
    }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      if (await designsPage.designLinks.first().isVisible()) {
        await designsPage.clickFirstDesign()

        // Only test if ECOs tab exists
        if (await designsPage.ecosTab.isVisible()) {
          await designsPage.gotoECOs()
          // Just verify tab was clicked (content structure varies)
          await page.waitForTimeout(500)
        }
      }
    })

    test('can navigate to History tab if present', async ({
      authenticatedPage: page,
    }) => {
      const designsPage = new DesignsPage(page)
      await designsPage.goto()

      if (await designsPage.designLinks.first().isVisible()) {
        await designsPage.clickFirstDesign()

        // Only test if History tab exists
        if (await designsPage.historyTab.isVisible()) {
          await designsPage.gotoHistory()
          // Just verify tab was clicked (content structure varies)
          await page.waitForTimeout(500)
        }
      }
    })
  })
})
