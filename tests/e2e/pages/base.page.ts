// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
   * Expand the sidebar navigation, and require that it ends up expanded.
   *
   * The old version asked whether `main-nav` was visible — which it always
   * is, since collapsing changes the sidebar's width and padding, never its
   * presence — so it never clicked anything, and callers that needed the
   * expanded nav got whatever state the app happened to be in. That matters:
   * `SidebarSection` renders its `data-testid` button ONLY when expanded;
   * collapsed, it is a plain icon link with no test id at all.
   *
   * The hamburger's accessible name is the honest signal for the current
   * state, and the closing wait is the assertion — nothing here can leave a
   * caller on a collapsed sidebar without failing.
   */
  async openSidebar(): Promise<void> {
    await this.sidebar.waitFor({ state: 'visible' })
    await this.page
      .getByRole('button', { name: 'Expand menu' })
      .click({ timeout: 2000 })
      .catch(() => {
        // Already expanded — there is no "Expand menu" button to click.
      })
    await this.page
      .getByRole('button', { name: 'Collapse menu' })
      .waitFor({ state: 'visible', timeout: 5000 })
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
