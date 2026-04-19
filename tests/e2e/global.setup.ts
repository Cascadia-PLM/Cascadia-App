/**
 * Global Setup for Playwright E2E Tests
 *
 * Runs once before all E2E tests to:
 * - Verify application is accessible
 * - Verify login page loads correctly
 *
 * Prerequisites (run before tests):
 *   npm run db:reset:seed  # Reset and seed database
 *   npm run dev            # Start dev server
 *
 * Or use the full command:
 *   npm run test:e2e:full
 */

import { expect, test as setup } from '@playwright/test'

setup('global setup', async ({ page }) => {
  console.log('')
  console.log('═'.repeat(60))
  console.log('  E2E GLOBAL SETUP')
  console.log('═'.repeat(60))
  console.log('')

  // Step 1: Verify the app is accessible
  console.log('Step 1: Verifying application is accessible...')

  try {
    await page.goto('/')

    // Should redirect to login if not authenticated
    await expect(page).toHaveURL(/.*login.*/)

    console.log('  ✓ Application is accessible and redirecting to login')
  } catch (error) {
    console.error('  ✗ Failed to access application:', error)
    console.error('')
    console.error('  Make sure the dev server is running: npm run dev')
    throw error
  }

  // Step 2: Verify login page loads correctly
  console.log('Step 2: Verifying login page loads...')

  try {
    await page.goto('/login')
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible({
      timeout: 10000,
    })
    console.log('  ✓ Login page loads correctly')
  } catch (error) {
    console.error('  ✗ Login page failed to load:', error)
    throw error
  }

  console.log('')
  console.log('═'.repeat(60))
  console.log('  E2E GLOBAL SETUP COMPLETE')
  console.log('═'.repeat(60))
  console.log('')
})
