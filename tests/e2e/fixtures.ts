/**
 * Playwright Test Fixtures
 *
 * Provides custom fixtures for E2E tests, including authenticated page sessions.
 * Uses session storage caching to speed up tests by reusing login state.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base } from '@playwright/test'
import { E2E_TEST_CONFIG } from './config'
import type { BrowserContext, Page } from '@playwright/test'

/**
 * Path to cached authentication state
 * Uses process.cwd() for ESM compatibility (tests run from project root)
 */
const AUTH_STATE_PATH = path.join(process.cwd(), 'playwright/.auth/user.json')

/**
 * Custom fixtures type definition
 */
type CustomFixtures = {
  authenticatedPage: Page
  authenticatedContext: BrowserContext
}

/**
 * Ensure auth directory exists
 */
function ensureAuthDir() {
  const authDir = path.dirname(AUTH_STATE_PATH)
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true })
  }
}

/**
 * Check if cached auth state exists and is recent (less than 1 hour old)
 */
function hasFreshAuthState(): boolean {
  if (!fs.existsSync(AUTH_STATE_PATH)) {
    return false
  }
  const stats = fs.statSync(AUTH_STATE_PATH)
  const ageMs = Date.now() - stats.mtimeMs
  const oneHourMs = 60 * 60 * 1000
  return ageMs < oneHourMs
}

/**
 * Helper to login via UI
 * Uses role-based selectors and pressSequentially for reliable React input handling
 */
async function loginViaUI(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto('/login')

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

  // Submit and wait for redirect
  await submitButton.click()

  // Wait for redirect to home page (successful login)
  // Note: Login page has an 800ms animation delay before redirect
  await page.waitForURL('/', { timeout: 30000, waitUntil: 'domcontentloaded' })
}

/**
 * Extended test with custom fixtures
 */
export const test = base.extend<CustomFixtures>({
  /**
   * Authenticated browser context fixture
   *
   * Creates a context with cached auth state if available, otherwise logs in fresh.
   * Saves auth state for future tests.
   */
  authenticatedContext: async ({ browser }, use) => {
    ensureAuthDir()

    let context: BrowserContext

    // Try to use cached auth state
    if (hasFreshAuthState()) {
      context = await browser.newContext({
        storageState: AUTH_STATE_PATH,
      })

      // Disable product tour in E2E tests
      await context.addInitScript(() => {
        localStorage.setItem('cascadia-e2e-test', 'true')
      })

      // Verify the session is still valid. Wait for networkidle so the
      // client-side auth check (GET /api/auth/session) and any
      // redirect-to-login have finished before we inspect the URL.
      const page = await context.newPage()
      await page.goto('/', { waitUntil: 'networkidle' })

      if (page.url().includes('/login')) {
        // Session expired, need to re-login
        await page.close()
        await context.close()

        // Create fresh context and login
        context = await browser.newContext()

        // Disable product tour in E2E tests
        await context.addInitScript(() => {
          localStorage.setItem('cascadia-e2e-test', 'true')
        })

        const freshPage = await context.newPage()
        await loginViaUI(
          freshPage,
          E2E_TEST_CONFIG.adminUser.username,
          E2E_TEST_CONFIG.adminUser.password,
        )
        // Save the new auth state
        await context.storageState({ path: AUTH_STATE_PATH })
        await freshPage.close()
      } else {
        // Session valid, close the verification page
        await page.close()
      }
    } else {
      // No cached state, login fresh
      context = await browser.newContext()

      // Disable product tour in E2E tests
      await context.addInitScript(() => {
        localStorage.setItem('cascadia-e2e-test', 'true')
      })

      const page = await context.newPage()
      await loginViaUI(
        page,
        E2E_TEST_CONFIG.adminUser.username,
        E2E_TEST_CONFIG.adminUser.password,
      )
      // Save auth state for future tests
      await context.storageState({ path: AUTH_STATE_PATH })
      await page.close()
    }

    await use(context)

    // Cleanup: close context after test
    await context.close()
  },

  /**
   * Authenticated page fixture
   *
   * Provides a page that is already logged in as the admin user.
   * Use this for tests that require authentication.
   */
  authenticatedPage: async ({ authenticatedContext }, use) => {
    const page = await authenticatedContext.newPage()

    // Navigate to home to ensure we're authenticated
    await page.goto('/')

    // Provide the authenticated page to the test
    await use(page)

    // Cleanup: close the page after test
    await page.close()
  },
})

/**
 * Re-export expect from base for convenience
 */
export { expect } from '@playwright/test'

/**
 * Test tags for tiered execution
 *
 * Usage:
 *   test('my test @tier1', async ({ page }) => { ... })
 *
 * Run specific tier:
 *   npx playwright test --grep @tier1
 *   npx playwright test --grep "@tier1|@tier2"
 */
export const TIERS = {
  SMOKE: '@tier1', // Run on every PR (~17 tests, ~1 min)
  CORE: '@tier2', // Run on merge to main (~35 tests, ~5 min)
  FULL: '@tier3', // Run nightly (~72 tests, ~10 min)
} as const
