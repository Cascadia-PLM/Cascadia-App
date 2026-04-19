/**
 * Navigation E2E Smoke Tests
 *
 * Tier 1: Critical path tests that run on every PR.
 * Tests that authenticated users can navigate to main routes.
 */

import { expect, test } from './fixtures'

test.describe('Navigation - Smoke Tests @tier1', () => {
  test('can open sidebar navigation', async ({ authenticatedPage: page }) => {
    await page.goto('/')

    // Click menu button to open sidebar
    await page.click('[data-testid="menu-button"]')

    // Verify navigation sidebar is visible
    await expect(page.locator('[data-testid="main-nav"]')).toBeVisible()
  })

  test('can navigate to Parts page', async ({ authenticatedPage: page }) => {
    await page.goto('/')

    // Open sidebar
    await page.click('[data-testid="menu-button"]')

    // Click Parts link
    await page.click('[data-testid="nav-parts"]')

    // Verify we're on the parts page
    await expect(page).toHaveURL('/parts')
  })

  test('can navigate to Documents page', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/')

    // Open sidebar
    await page.click('[data-testid="menu-button"]')

    // Click Documents link
    await page.click('[data-testid="nav-documents"]')

    // Verify we're on the documents page
    await expect(page).toHaveURL('/documents')
  })

  test('can navigate to Dashboard from any page', async ({
    authenticatedPage: page,
  }) => {
    // Start on parts page
    await page.goto('/parts')

    // Open sidebar
    await page.click('[data-testid="menu-button"]')

    // Click Dashboard link
    await page.click('[data-testid="nav-dashboard"]')

    // Verify we're on the dashboard
    await expect(page).toHaveURL('/')
  })

  test('all main navigation links are present', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/')

    // Open sidebar
    await page.click('[data-testid="menu-button"]')

    // Verify key navigation elements are present
    await expect(page.locator('[data-testid="nav-dashboard"]')).toBeVisible()
    await expect(page.locator('[data-testid="nav-parts"]')).toBeVisible()
    await expect(page.locator('[data-testid="nav-documents"]')).toBeVisible()
  })
})
