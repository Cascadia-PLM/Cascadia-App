// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Authentication E2E Smoke Tests
 *
 * Critical-path smoke tests.
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

/*
 * These tests are about signing in, so they need a browser that has not.
 * Every other spec inherits the signed-in state the setup project saves; this
 * file opts out of it.
 */
test.use({ storageState: { cookies: [], origins: [] } })

/*
 * Discarding the saved state also discards the `cascadia-e2e-test` localStorage
 * key that state carries, and that key is what suppresses the first-run setup
 * wizard: an admin whose instance has no `system.setup_completed` setting — a
 * seeded E2E database — is redirected from any page to /setup by the root
 * route's beforeLoad. The redirect fires once `GET /auth/session` resolves, so
 * a test that signs in and then reloads was racing that fetch and landing on
 * /setup often enough to redden a run that had nothing to do with auth.
 *
 * An init script rather than a `page.evaluate` after navigation: it runs before
 * the app's scripts on every navigation *and* every reload, which is exactly
 * the case that was failing.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cascadia-e2e-test', 'true')
  })
})

test.describe('Authentication - Smoke Tests', () => {
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
