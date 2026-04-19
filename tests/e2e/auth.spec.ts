/**
 * Authentication E2E Smoke Tests
 *
 * Tier 1: Critical path tests that run on every PR.
 * Tests login flow, session persistence, and protected route access.
 */

import { expect, test } from '@playwright/test'
import { E2E_TEST_CONFIG } from './config'
import type { Page } from '@playwright/test'

/**
 * Helper to login via UI
 * Uses role-based selectors
 */
async function loginViaUI(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  // Wait for form to be ready
  await page.waitForSelector('[data-testid="login-form"]', { state: 'visible' })

  // Use role-based selectors which are more reliable
  const usernameInput = page.getByRole('textbox', { name: 'Username' })
  const passwordInput = page.getByRole('textbox', { name: 'Password' })
  const submitButton = page.getByRole('button', {
    name: 'Sign in',
    exact: true,
  })

  // Fill username
  await usernameInput.click()
  await usernameInput.pressSequentially(username, { delay: 30 })

  // Fill password
  await passwordInput.click()
  await passwordInput.pressSequentially(password, { delay: 30 })

  // Submit
  await submitButton.click()
}

test.describe('Authentication - Smoke Tests @tier1', () => {
  test.describe('Login Flow', () => {
    test('displays login form with all required elements', async ({ page }) => {
      await page.goto('/login')

      // Verify login form is visible with all elements
      await expect(page.locator('[data-testid="login-form"]')).toBeVisible()
      await expect(page.locator('[data-testid="login-username"]')).toBeVisible()
      await expect(page.locator('[data-testid="login-password"]')).toBeVisible()
      await expect(page.locator('[data-testid="login-submit"]')).toBeVisible()
    })

    test('successful login redirects to dashboard', async ({ page }) => {
      await page.goto('/login')
      await loginViaUI(
        page,
        E2E_TEST_CONFIG.adminUser.username,
        E2E_TEST_CONFIG.adminUser.password,
      )

      // Should redirect to dashboard (home page)
      // Note: Login page has an 800ms animation delay before redirect
      await page.waitForURL('/', {
        timeout: 30000,
        waitUntil: 'domcontentloaded',
      })
    })

    test('invalid credentials show error message', async ({ page }) => {
      await page.goto('/login')
      await loginViaUI(page, 'invalid@example.com', 'wrongpassword')

      // Should show error message
      await expect(page.locator('[data-testid="login-error"]')).toBeVisible({
        timeout: 5000,
      })

      // Should stay on login page
      await expect(page).toHaveURL(/.*login.*/)
    })
  })

  test.describe('Session Persistence', () => {
    test('logged in user can refresh page and stay authenticated', async ({
      page,
    }) => {
      // Login first
      await page.goto('/login')
      await loginViaUI(
        page,
        E2E_TEST_CONFIG.adminUser.username,
        E2E_TEST_CONFIG.adminUser.password,
      )
      await page.waitForURL('/', {
        timeout: 30000,
        waitUntil: 'domcontentloaded',
      })

      // Refresh the page
      await page.reload()

      // Should still be on dashboard (not redirected to login)
      await expect(page).toHaveURL('/')
    })
  })

  test.describe('Protected Routes', () => {
    test('unauthenticated user is redirected to login', async ({ page }) => {
      // Try to access protected route directly
      await page.goto('/parts')

      // Should redirect to login
      await expect(page).toHaveURL(/.*login.*/, { timeout: 5000 })
    })

    test('authenticated user can access protected routes', async ({ page }) => {
      // Login first
      await page.goto('/login')
      await loginViaUI(
        page,
        E2E_TEST_CONFIG.adminUser.username,
        E2E_TEST_CONFIG.adminUser.password,
      )
      await page.waitForURL('/', {
        timeout: 30000,
        waitUntil: 'domcontentloaded',
      })

      // Now try to access parts page
      await page.goto('/parts')

      // Should successfully load parts page (not redirect to login)
      await expect(page).toHaveURL('/parts')
    })
  })
})
