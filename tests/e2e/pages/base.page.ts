/**
 * Base Page Object Model
 *
 * Provides common functionality for all page objects.
 */

import type { Locator, Page } from '@playwright/test'

export abstract class BasePage {
  constructor(protected page: Page) {}

  /**
   * Navigate to this page's URL
   */
  abstract goto(): Promise<void>

  /**
   * Wait for page to be ready (override in subclasses)
   */
  async waitForReady(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
  }

  /**
   * Get the sidebar navigation
   */
  get sidebar(): Locator {
    return this.page.locator('[data-testid="main-nav"]')
  }

  /**
   * Get the menu button (hamburger)
   */
  get menuButton(): Locator {
    return this.page.locator('[data-testid="menu-button"]')
  }

  /**
   * Open the sidebar navigation
   */
  async openSidebar(): Promise<void> {
    const isVisible = await this.sidebar.isVisible()
    if (!isVisible) {
      await this.menuButton.click()
      await this.sidebar.waitFor({ state: 'visible' })
    }
  }

  /**
   * Navigate using sidebar
   */
  async navigateTo(testId: string): Promise<void> {
    await this.openSidebar()
    await this.page.click(`[data-testid="${testId}"]`)
  }

  /**
   * Fill a form field reliably (works with React controlled inputs)
   */
  async fillField(locator: Locator, value: string): Promise<void> {
    await locator.click()
    await locator.fill(value)
  }

  /**
   * Fill a form field using pressSequentially (for problematic inputs)
   */
  async typeField(locator: Locator, value: string, delay = 30): Promise<void> {
    await locator.click()
    await locator.pressSequentially(value, { delay })
  }

  /**
   * Select an option from a dropdown/combobox
   */
  async selectOption(
    triggerLocator: Locator,
    optionText: string,
  ): Promise<void> {
    await triggerLocator.click()
    await this.page.locator(`[role="option"]:has-text("${optionText}")`).click()
  }

  /**
   * Get table rows
   */
  getTableRows(): Locator {
    return this.page.locator('table tbody tr')
  }

  /**
   * Click the first link in a table
   */
  async clickFirstTableLink(): Promise<void> {
    await this.page.locator('table tbody tr a').first().click()
  }
}
