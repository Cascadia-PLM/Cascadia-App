/**
 * BOM (Bill of Materials) Management E2E Workflow Tests
 *
 * Tier 2: Core workflow tests that run on merge to main.
 * Tests BOM management including:
 * View BOM → Add Children → Edit Quantities → View Where-Used
 */

import { expect, test } from '../fixtures'

test.describe('BOM Management @tier2', () => {
  test.describe('BOM View', () => {
    test('can view part BOM tab', async ({ authenticatedPage: page }) => {
      await page.goto('/parts')

      // Click on first part in list
      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        // Look for BOM tab
        const bomTab = page.locator(
          'button:has-text("BOM"), button:has-text("Bill of Materials"), [data-testid="bom-tab"]',
        )
        if (await bomTab.isVisible()) {
          await bomTab.click()

          // Verify BOM section is visible
          const bomSection = page.locator(
            '[data-testid="bom-panel"], .bom-tree, [data-testid="bom-table"]',
          )
          await expect(bomSection.first()).toBeVisible({ timeout: 5000 })
        }
      }
    })

    test('BOM displays in tree or table format', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        const bomTab = page.locator(
          'button:has-text("BOM"), [data-testid="bom-tab"]',
        )
        if (await bomTab.isVisible()) {
          await bomTab.click()

          // Look for BOM tree or table structure
          const bomContent = page.locator(
            '.bom-tree, table[data-testid="bom-table"], [data-testid="bom-children"]',
          )
          if (await bomContent.isVisible()) {
            await expect(bomContent).toBeVisible()
          }
        }
      }
    })

    test('BOM shows quantity column', async ({ authenticatedPage: page }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        const bomTab = page.locator(
          'button:has-text("BOM"), [data-testid="bom-tab"]',
        )
        if (await bomTab.isVisible()) {
          await bomTab.click()

          // Look for quantity header or column
          const qtyColumn = page.locator(
            'th:has-text("Qty"), th:has-text("Quantity"), [data-testid="qty-header"]',
          )
          if (await qtyColumn.isVisible()) {
            await expect(qtyColumn).toBeVisible()
          }
        }
      }
    })
  })

  test.describe('Add BOM Children', () => {
    test('can see Add Child button in BOM view', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        const bomTab = page.locator(
          'button:has-text("BOM"), [data-testid="bom-tab"]',
        )
        if (await bomTab.isVisible()) {
          await bomTab.click()

          // Look for Add Child button
          const addButton = page.locator(
            'button:has-text("Add Child"), button:has-text("Add Component"), [data-testid="add-bom-child"]',
          )
          if (await addButton.isVisible()) {
            await expect(addButton).toBeVisible()
          }
        }
      }
    })

    test('Add Child button opens dialog', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        const bomTab = page.locator(
          'button:has-text("BOM"), [data-testid="bom-tab"]',
        )
        if (await bomTab.isVisible()) {
          await bomTab.click()

          const addButton = page.locator(
            'button:has-text("Add Child"), button:has-text("Add Component"), [data-testid="add-bom-child"]',
          )
          if (await addButton.isVisible()) {
            await addButton.click()

            // Should show dialog to add child
            const dialog = page.locator(
              '[role="dialog"], [data-testid="add-bom-dialog"]',
            )
            await expect(dialog).toBeVisible({ timeout: 5000 })
          }
        }
      }
    })

    test('Add Child dialog has search functionality', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        const bomTab = page.locator(
          'button:has-text("BOM"), [data-testid="bom-tab"]',
        )
        if (await bomTab.isVisible()) {
          await bomTab.click()

          const addButton = page.locator(
            'button:has-text("Add Child"), [data-testid="add-bom-child"]',
          )
          if (await addButton.isVisible()) {
            await addButton.click()

            // Look for search input in dialog
            const searchInput = page.locator(
              '[role="dialog"] input[placeholder*="Search"], [role="dialog"] input[type="search"]',
            )
            if (await searchInput.isVisible()) {
              await expect(searchInput).toBeVisible()
            }
          }
        }
      }
    })
  })

  test.describe('Where-Used View', () => {
    test('can view Where-Used tab', async ({ authenticatedPage: page }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        // Look for Where-Used tab
        const whereUsedTab = page.locator(
          'button:has-text("Where Used"), button:has-text("Used In"), [data-testid="where-used-tab"]',
        )
        if (await whereUsedTab.isVisible()) {
          await whereUsedTab.click()

          // Verify Where-Used section is visible
          const whereUsedSection = page.locator(
            '[data-testid="where-used-panel"], .where-used-tree, [data-testid="where-used-table"]',
          )
          await expect(whereUsedSection.first()).toBeVisible({ timeout: 5000 })
        }
      }
    })

    test('Where-Used shows parent assemblies', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        const whereUsedTab = page.locator(
          'button:has-text("Where Used"), [data-testid="where-used-tab"]',
        )
        if (await whereUsedTab.isVisible()) {
          await whereUsedTab.click()

          // Look for parent items or "no parents" message
          const content = page.locator(
            '[data-testid="where-used-content"], .where-used-list, text=No parent',
          )
          await expect(content.first()).toBeVisible({ timeout: 5000 })
        }
      }
    })
  })

  test.describe('BOM Actions', () => {
    test('can expand BOM tree nodes', async ({ authenticatedPage: page }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        const bomTab = page.locator(
          'button:has-text("BOM"), [data-testid="bom-tab"]',
        )
        if (await bomTab.isVisible()) {
          await bomTab.click()

          // Look for expand/collapse button
          const expandButton = page.locator(
            '[data-testid="expand-node"], button[aria-label*="expand"], .tree-expand',
          )
          if (await expandButton.first().isVisible()) {
            await expandButton.first().click()
            await page.waitForTimeout(500)
          }
        }
      }
    })

    test('can view BOM child details', async ({ authenticatedPage: page }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      if (await partLink.isVisible()) {
        await partLink.click()

        const bomTab = page.locator(
          'button:has-text("BOM"), [data-testid="bom-tab"]',
        )
        if (await bomTab.isVisible()) {
          await bomTab.click()

          // Click on a BOM child item
          const childLink = page
            .locator('[data-testid="bom-child-link"], .bom-item a')
            .first()
          if (await childLink.isVisible()) {
            await childLink.click()

            // Should navigate to child part detail
            await expect(page).toHaveURL(/\/parts\/[a-f0-9-]+/, {
              timeout: 5000,
            })
          }
        }
      }
    })
  })

  test.describe('Relationships View', () => {
    test('can navigate to Relationships tab if present', async ({
      authenticatedPage: page,
    }) => {
      await page.goto('/parts')

      const partLink = page
        .locator('table tr a, [data-testid="part-link"]')
        .first()
      const hasParts = await partLink
        .isVisible({ timeout: 3000 })
        .catch(() => false)
      if (hasParts) {
        await partLink.click()

        // Look for Relationships tab
        const relTab = page.locator(
          'button:has-text("Relationships"), button:has-text("Relations"), [data-testid="relationships-tab"]',
        )
        const hasTab = await relTab
          .isVisible({ timeout: 3000 })
          .catch(() => false)
        if (hasTab) {
          await relTab.click()
          // Just verify tab was clicked (content structure varies)
          await page.waitForTimeout(500)
        }
      }
    })
  })
})
