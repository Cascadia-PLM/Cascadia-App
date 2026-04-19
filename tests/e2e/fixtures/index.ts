/**
 * E2E Test Fixtures
 *
 * Provides custom Playwright test fixtures with:
 * - Session injection for authenticated tests
 * - Test data helpers
 * - Page object models
 *
 * @example
 * ```typescript
 * import { test, expect } from '../fixtures'
 *
 * test('authenticated user can view parts', async ({ authenticatedPage }) => {
 *   await authenticatedPage.goto('/parts')
 *   await expect(authenticatedPage.locator('h1')).toHaveText('Parts')
 * })
 * ```
 */

import { test as base, expect } from '@playwright/test'
import { E2E_TEST_CONFIG } from '../config'
import type { Page } from '@playwright/test'

/**
 * Test user types
 */
export type TestUserType = 'admin' | 'standard' | 'approver' | 'viewOnly'

/**
 * Session data for injecting authentication
 */
export interface TestSession {
  sessionId: string
  userId: string
  email: string
  name: string
  organizationId: string
}

/**
 * Extended test fixtures
 */
export interface TestFixtures {
  /** Page with admin user authenticated */
  adminPage: Page
  /** Page with standard user authenticated */
  authenticatedPage: Page
  /** Helper to login as any user type */
  loginAs: (userType: TestUserType) => Promise<void>
  /** Helper to logout */
  logout: () => Promise<void>
  /** Test data creator */
  testData: TestDataHelper
}

/**
 * Worker fixtures (shared across tests in a worker)
 */
export interface WorkerFixtures {
  /** Base URL for the application */
  baseURL: string
}

/**
 * Test data helper for creating test data during E2E tests
 */
export class TestDataHelper {
  constructor(private page: Page) {}

  /**
   * Create a test part via the UI
   */
  async createPart(data: {
    itemNumber: string
    name: string
    description?: string
  }): Promise<string> {
    await this.page.goto('/parts')
    await this.page.click('button:has-text("New Part")')

    await this.page.fill('input[name="itemNumber"]', data.itemNumber)
    await this.page.fill('input[name="name"]', data.name)

    if (data.description) {
      await this.page.fill('textarea[name="description"]', data.description)
    }

    await this.page.click('button[type="submit"]')

    // Wait for navigation to the created part
    await this.page.waitForURL(/\/parts\//)

    // Extract the ID from the URL
    const url = this.page.url()
    const id = url.split('/').pop() || ''

    return id
  }

  /**
   * Create a test document via the UI
   */
  async createDocument(data: {
    itemNumber: string
    name: string
    description?: string
  }): Promise<string> {
    await this.page.goto('/documents')
    await this.page.click('button:has-text("New Document")')

    await this.page.fill('input[name="itemNumber"]', data.itemNumber)
    await this.page.fill('input[name="name"]', data.name)

    if (data.description) {
      await this.page.fill('textarea[name="description"]', data.description)
    }

    await this.page.click('button[type="submit"]')

    await this.page.waitForURL(/\/documents\//)

    const url = this.page.url()
    const id = url.split('/').pop() || ''

    return id
  }

  /**
   * Create a test change order via the UI
   */
  async createChangeOrder(data: {
    itemNumber: string
    name: string
    changeType: 'ECO' | 'ECN' | 'ECR'
    reasonForChange?: string
  }): Promise<string> {
    await this.page.goto('/change-orders')
    await this.page.click('button:has-text("New Change Order")')

    await this.page.fill('input[name="itemNumber"]', data.itemNumber)
    await this.page.fill('input[name="name"]', data.name)
    await this.page.selectOption('select[name="changeType"]', data.changeType)

    if (data.reasonForChange) {
      await this.page.fill(
        'textarea[name="reasonForChange"]',
        data.reasonForChange,
      )
    }

    await this.page.click('button[type="submit"]')

    await this.page.waitForURL(/\/change-orders\//)

    const url = this.page.url()
    const id = url.split('/').pop() || ''

    return id
  }

  /**
   * Delete test data by navigating to item and clicking delete
   */
  async deleteItem(
    type: 'parts' | 'documents' | 'change-orders',
    id: string,
  ): Promise<void> {
    await this.page.goto(`/${type}/${id}`)

    // Click delete button (may need confirmation)
    await this.page.click('button:has-text("Delete")')

    // Confirm deletion if dialog appears
    const confirmButton = this.page.locator('button:has-text("Confirm Delete")')
    if (await confirmButton.isVisible()) {
      await confirmButton.click()
    }

    // Wait for redirect to list
    await this.page.waitForURL(new RegExp(`/${type}$`))
  }
}

/**
 * Login via UI
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

  // Wait for successful login (redirects away from login page)
  // Note: Login page has an 800ms animation delay before redirect
  await page.waitForURL((url) => !url.pathname.includes('/login'), {
    timeout: 30000,
  })
}

/**
 * Extended test function with custom fixtures
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Admin page fixture - pre-authenticated as admin
  adminPage: async ({ browser }, use) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    // Login via UI using the default admin account
    try {
      await loginViaUI(
        page,
        E2E_TEST_CONFIG.adminUser.username,
        E2E_TEST_CONFIG.adminUser.password,
      )
    } catch {
      // If admin user doesn't exist, tests will fail appropriately
      console.warn('Failed to login as admin user - ensure database is seeded')
    }

    await use(page)

    await context.close()
  },

  // Authenticated page fixture - pre-authenticated as standard user
  // Falls back to admin if standard user doesn't exist
  authenticatedPage: async ({ browser }, use) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    // Try standard user first, fall back to admin
    try {
      await loginViaUI(
        page,
        E2E_TEST_CONFIG.standardUser.username,
        E2E_TEST_CONFIG.standardUser.password,
      )
    } catch {
      // Fall back to admin user
      try {
        await loginViaUI(
          page,
          E2E_TEST_CONFIG.adminUser.username,
          E2E_TEST_CONFIG.adminUser.password,
        )
      } catch {
        console.warn('Failed to login - ensure database is seeded')
      }
    }

    await use(page)

    await context.close()
  },

  // Login helper
  loginAs: async ({ page }, use) => {
    const loginAs = async (userType: TestUserType) => {
      const users: Record<
        TestUserType,
        { username: string; password: string }
      > = {
        admin: E2E_TEST_CONFIG.adminUser,
        standard: E2E_TEST_CONFIG.standardUser,
        approver: {
          username: 'approver@cascadia.local',
          password: 'Cascadia',
        },
        viewOnly: {
          username: 'viewer@cascadia.local',
          password: 'Cascadia',
        },
      }

      const user = users[userType]
      await loginViaUI(page, user.username, user.password)
    }

    await use(loginAs)
  },

  // Logout helper
  logout: async ({ page }, use) => {
    const logout = async () => {
      await page.goto('/api/auth/logout', { waitUntil: 'networkidle' })
    }

    await use(logout)
  },

  // Test data helper
  testData: async ({ page }, use) => {
    const helper = new TestDataHelper(page)
    await use(helper)
  },
})

/**
 * Re-export expect for convenience
 */
export { expect }

/**
 * Page Object Models for common pages
 */
export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/login')
  }

  async login(username: string, password: string) {
    await this.page.fill('[data-testid="login-username"]', username)
    await this.page.fill('[data-testid="login-password"]', password)
    await this.page.click('[data-testid="login-submit"]')
  }

  async expectError() {
    await expect(this.page.locator('[data-testid="login-error"]')).toBeVisible()
  }

  async expectFormVisible() {
    await expect(this.page.locator('[data-testid="login-form"]')).toBeVisible()
  }
}

export class PartsPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/parts')
  }

  async expectPartInList(itemNumber: string) {
    await expect(this.page.locator(`text=${itemNumber}`)).toBeVisible()
  }

  async clickNewPart() {
    await this.page.click('button:has-text("New Part")')
  }

  async searchParts(query: string) {
    await this.page.fill('input[placeholder*="Search"]', query)
  }
}

export class ChangeOrderPage {
  constructor(private page: Page) {}

  async goto(id?: string) {
    if (id) {
      await this.page.goto(`/change-orders/${id}`)
    } else {
      await this.page.goto('/change-orders')
    }
  }

  async expectState(state: string) {
    await expect(
      this.page.locator('[data-testid="item-state"], .badge'),
    ).toContainText(state)
  }

  async submitForApproval() {
    await this.page.click('button:has-text("Submit")')
  }

  async approve() {
    await this.page.click('button:has-text("Approve")')
  }

  async reject(reason?: string) {
    await this.page.click('button:has-text("Reject")')
    if (reason) {
      await this.page.fill('textarea[name="rejectionReason"]', reason)
      await this.page.click('button:has-text("Confirm Rejection")')
    }
  }
}
