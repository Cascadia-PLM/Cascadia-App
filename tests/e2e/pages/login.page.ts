/**
 * Login Page Object Model
 *
 * Handles authentication flows for E2E tests.
 */

import { BasePage } from './base.page'
import type { Locator, Page } from '@playwright/test'

export class LoginPage extends BasePage {
  constructor(page: Page) {
    super(page)
  }

  async goto(): Promise<void> {
    await this.page.goto('/login')
  }

  async waitForReady(): Promise<void> {
    await this.form.waitFor({ state: 'visible' })
  }

  // ===== Locators =====

  get form(): Locator {
    return this.page.locator('[data-testid="login-form"]')
  }

  get usernameInput(): Locator {
    return this.page.getByRole('textbox', { name: 'Username' })
  }

  get passwordInput(): Locator {
    return this.page.getByRole('textbox', { name: 'Password' })
  }

  get submitButton(): Locator {
    return this.page.getByRole('button', { name: 'Sign in', exact: true })
  }

  get errorMessage(): Locator {
    return this.page.locator('[data-testid="login-error"]')
  }

  get loadingSpinner(): Locator {
    return this.page
      .locator('[data-testid="login-submit"]')
      .locator('text=Signing in...')
  }

  // ===== Actions =====

  /**
   * Login with credentials
   * Uses pressSequentially for reliable React input handling
   */
  async login(username: string, password: string): Promise<void> {
    await this.usernameInput.click()
    await this.usernameInput.pressSequentially(username, { delay: 30 })

    await this.passwordInput.click()
    await this.passwordInput.pressSequentially(password, { delay: 30 })

    await this.submitButton.click()
  }

  /**
   * Login and wait for redirect to home
   */
  async loginAndWaitForHome(username: string, password: string): Promise<void> {
    await this.login(username, password)
    await this.page.waitForURL('/', {
      timeout: 30000,
      waitUntil: 'domcontentloaded',
    })
  }

  /**
   * Login with invalid credentials and verify error
   */
  async loginWithInvalidCredentials(
    username: string,
    password: string,
  ): Promise<void> {
    await this.login(username, password)
    await this.errorMessage.waitFor({ state: 'visible', timeout: 5000 })
  }
}
