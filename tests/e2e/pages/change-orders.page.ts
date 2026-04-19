/**
 * Change Orders (ECO) Page Object Model
 *
 * Handles ECO list, create, and workflow transitions.
 */

import { BasePage } from './base.page'
import type { Locator, Page } from '@playwright/test'

export class ChangeOrdersPage extends BasePage {
  constructor(page: Page) {
    super(page)
  }

  async goto(): Promise<void> {
    await this.page.goto('/change-orders')
  }

  async gotoNew(): Promise<void> {
    await this.page.goto('/change-orders/new')
  }

  async waitForReady(): Promise<void> {
    await this.table.or(this.form).waitFor({ state: 'visible', timeout: 10000 })
  }

  // ===== List Page Locators =====

  get table(): Locator {
    return this.page.locator(
      'table, [data-testid="change-orders-table"], [data-testid="change-orders-list"]',
    )
  }

  get ecoLinks(): Locator {
    return this.page.locator('table tr a, [data-testid="eco-link"]')
  }

  get createButton(): Locator {
    return this.page.locator(
      '[data-testid="create-eco-button"], button:has-text("New"), button:has-text("Create")',
    )
  }

  get searchInput(): Locator {
    return this.page.locator(
      'input[placeholder*="Search"], input[type="search"], [data-testid="search-input"]',
    )
  }

  get stateFilter(): Locator {
    return this.page.locator(
      '[data-testid="state-filter"], select:has-text("State"), button:has-text("Filter")',
    )
  }

  get draftBadges(): Locator {
    return this.page.locator(
      '.badge:has-text("Draft"), [data-testid="state-badge"]:has-text("Draft")',
    )
  }

  get draftRows(): Locator {
    return this.page.locator('tr:has(.badge:has-text("Draft"))')
  }

  // ===== Form Locators =====

  get form(): Locator {
    return this.page.locator('[data-testid="change-order-form"]')
  }

  get nameInput(): Locator {
    return this.page.locator('[data-testid="change-order-name"]')
  }

  get submitButton(): Locator {
    return this.page.locator('[data-testid="change-order-submit"]')
  }

  // ===== Detail Page Locators =====

  get workflowStatus(): Locator {
    return this.page.locator(
      '[data-testid="workflow-status"], .workflow-status, [data-testid="item-state"]',
    )
  }

  get workflowActions(): Locator {
    return this.page.locator(
      '[data-testid="workflow-actions"], button:has-text("Submit"), button:has-text("Promote")',
    )
  }

  get promoteButton(): Locator {
    return this.page.locator(
      'button:has-text("Submit"), [data-testid="submit-eco"]',
    )
  }

  get affectedItemsTab(): Locator {
    return this.page.locator(
      'button:has-text("Affected"), [data-testid="affected-items-tab"]',
    )
  }

  get addAffectedItemButton(): Locator {
    return this.page.locator(
      'button:has-text("Add Item"), button:has-text("Add Affected"), [data-testid="add-affected-item"]',
    )
  }

  // ===== Actions =====

  /**
   * Click create ECO button
   */
  async clickCreate(): Promise<void> {
    await this.createButton.click()
    await this.form.waitFor({ state: 'visible', timeout: 5000 })
  }

  /**
   * Fill in ECO form fields
   * Note: Change orders don't require a design selector - item number is auto-generated
   */
  async fillECOForm(name: string): Promise<void> {
    await this.fillField(this.nameInput, name)
  }

  /**
   * Submit the ECO form
   */
  async submit(): Promise<void> {
    await this.submitButton.click()
  }

  /**
   * Create a new ECO (full flow)
   */
  async createECO(name: string): Promise<void> {
    await this.fillECOForm(name)
    await this.submit()
    await this.page.waitForURL(/\/change-orders\/[a-f0-9-]+$/, {
      timeout: 10000,
    })
  }

  /**
   * Search for ECOs
   */
  async search(query: string): Promise<void> {
    if (await this.searchInput.isVisible()) {
      await this.searchInput.focus()
      await this.searchInput.pressSequentially(query, { delay: 30 })
      await this.page.waitForTimeout(500)
    }
  }

  /**
   * Click on first ECO in the list
   */
  async clickFirstECO(): Promise<void> {
    await this.ecoLinks.first().click()
    await this.page.waitForURL(/\/change-orders\/[a-f0-9-]+/, { timeout: 5000 })
  }

  /**
   * Click on first Draft ECO in the list
   */
  async clickFirstDraftECO(): Promise<void> {
    const row = this.draftRows.first()
    if (await row.isVisible()) {
      await row.locator('a').first().click()
      await this.page.waitForURL(/\/change-orders\/[a-f0-9-]+/, {
        timeout: 5000,
      })
    }
  }

  /**
   * Navigate to Affected Items tab
   */
  async gotoAffectedItems(): Promise<void> {
    if (await this.affectedItemsTab.isVisible()) {
      await this.affectedItemsTab.click()
    }
  }

  /**
   * Open filter dropdown
   */
  async openStateFilter(): Promise<void> {
    if (await this.stateFilter.isVisible()) {
      await this.stateFilter.click()
    }
  }
}
