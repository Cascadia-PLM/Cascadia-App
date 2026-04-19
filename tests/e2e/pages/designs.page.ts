/**
 * Designs Page Object Model
 *
 * Handles designs list, detail, and branch management.
 */

import { BasePage } from './base.page'
import type { Locator, Page } from '@playwright/test'

export class DesignsPage extends BasePage {
  constructor(page: Page) {
    super(page)
  }

  async goto(): Promise<void> {
    await this.page.goto('/designs')
  }

  /**
   * Navigate to designs using the expandable sidebar menu
   */
  async navigateViaMenu(): Promise<void> {
    await this.openSidebar()
    // Click the expand button first
    const expandBtn = this.page.locator('[data-testid="nav-designs-expand"]')
    if (await expandBtn.isVisible()) {
      await expandBtn.click()
      // Wait for submenu to appear and click All Designs
      await this.page.locator('[data-testid="nav-designs"]').click()
    }
  }

  async waitForReady(): Promise<void> {
    await this.table.waitFor({ state: 'visible', timeout: 10000 })
  }

  // ===== List Page Locators =====

  get table(): Locator {
    return this.page.locator(
      'table, [data-testid="designs-table"], [data-testid="designs-list"]',
    )
  }

  get designLinks(): Locator {
    return this.page.locator(
      'table tr a, [data-testid="design-link"], .design-card a',
    )
  }

  get searchInput(): Locator {
    return this.page.locator(
      'input[placeholder*="Search"], input[type="search"], [data-testid="search-input"]',
    )
  }

  // ===== Detail Page Locators =====

  get tabs(): Locator {
    return this.page.locator(
      '[role="tablist"], .tabs, [data-testid="design-tabs"]',
    )
  }

  get itemsTab(): Locator {
    return this.page.locator(
      'button:has-text("Items"), [data-testid="items-tab"]',
    )
  }

  get ecosTab(): Locator {
    return this.page.locator(
      'button:has-text("ECOs"), button:has-text("Change Orders"), [data-testid="ecos-tab"]',
    )
  }

  get baselinesTab(): Locator {
    return this.page.locator(
      'button:has-text("Baselines"), button:has-text("Tags"), [data-testid="baselines-tab"]',
    )
  }

  get historyTab(): Locator {
    return this.page.locator(
      'button:has-text("History"), [data-testid="history-tab"]',
    )
  }

  // ===== Branch Management Locators =====

  get branchSelector(): Locator {
    return this.page.locator(
      '[data-testid="branch-selector"], .branch-selector, button:has-text("main")',
    )
  }

  get branchOptions(): Locator {
    return this.page.locator('[role="option"], [data-testid="branch-option"]')
  }

  get ecoBranchOptions(): Locator {
    return this.page.locator(
      '[role="option"]:has-text("eco"), [role="option"]:has-text("ECO")',
    )
  }

  // ===== Actions =====

  /**
   * Search for designs
   */
  async search(query: string): Promise<void> {
    if (await this.searchInput.isVisible()) {
      await this.searchInput.focus()
      await this.searchInput.pressSequentially(query, { delay: 30 })
      await this.page.waitForTimeout(500)
    }
  }

  /**
   * Click on first design in the list
   */
  async clickFirstDesign(): Promise<void> {
    await this.designLinks.first().click()
    await this.page.waitForURL(/\/designs\/[a-f0-9-]+/, { timeout: 5000 })
  }

  /**
   * Navigate to Items tab
   */
  async gotoItems(): Promise<void> {
    if (await this.itemsTab.isVisible()) {
      await this.itemsTab.click()
    }
  }

  /**
   * Navigate to ECOs tab
   */
  async gotoECOs(): Promise<void> {
    if (await this.ecosTab.isVisible()) {
      await this.ecosTab.click()
    }
  }

  /**
   * Navigate to Baselines tab
   */
  async gotoBaselines(): Promise<void> {
    if (await this.baselinesTab.isVisible()) {
      await this.baselinesTab.click()
    }
  }

  /**
   * Navigate to History tab
   */
  async gotoHistory(): Promise<void> {
    if (await this.historyTab.isVisible()) {
      await this.historyTab.click()
    }
  }

  /**
   * Open branch selector dropdown
   */
  async openBranchSelector(): Promise<void> {
    if (await this.branchSelector.isVisible()) {
      await this.branchSelector.click()
    }
  }

  /**
   * Switch to an ECO branch
   * @returns true if an ECO branch was available and selected
   */
  async switchToECOBranch(): Promise<boolean> {
    await this.openBranchSelector()
    const ecoBranch = this.ecoBranchOptions.first()
    if (await ecoBranch.isVisible()) {
      await ecoBranch.click()
      await this.page.waitForTimeout(500)
      return true
    }
    await this.page.keyboard.press('Escape')
    return false
  }
}
