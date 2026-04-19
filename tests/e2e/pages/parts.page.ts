/**
 * Parts Page Object Model
 *
 * Handles parts list and create/edit part flows.
 */

import { BasePage } from './base.page'
import type { Locator, Page } from '@playwright/test'

export class PartsPage extends BasePage {
  constructor(page: Page) {
    super(page)
  }

  async goto(): Promise<void> {
    await this.page.goto('/parts')
  }

  async gotoNew(): Promise<void> {
    await this.page.goto('/parts/new')
  }

  async waitForReady(): Promise<void> {
    await this.table.or(this.form).waitFor({ state: 'visible', timeout: 10000 })
  }

  // ===== List Page Locators =====

  get table(): Locator {
    return this.page.locator('table')
  }

  get createButton(): Locator {
    return this.page.locator('[data-testid="create-part-button"]')
  }

  get searchInput(): Locator {
    return this.page.locator(
      'input[placeholder*="Search"], input[type="search"], [data-testid="search-input"]',
    )
  }

  get partLinks(): Locator {
    return this.page.locator('table tbody tr a')
  }

  // ===== Form Locators =====

  get form(): Locator {
    return this.page.locator('[data-testid="part-form"]')
  }

  get designSelector(): Locator {
    return this.page.locator('[data-testid="design-selector"]')
  }

  get designOptions(): Locator {
    return this.page
      .locator('[role="option"]')
      .filter({ hasNotText: 'No Design' })
  }

  get itemNumberInput(): Locator {
    return this.page.locator('[data-testid="part-item-number"]')
  }

  get nameInput(): Locator {
    return this.page.locator('[data-testid="part-name"]')
  }

  get submitButton(): Locator {
    return this.page.locator('[data-testid="part-submit"]')
  }

  get cancelButton(): Locator {
    return this.page.locator('[data-testid="part-cancel"]')
  }

  // ===== Detail Page Locators =====

  get bomTab(): Locator {
    return this.page.locator('button:has-text("BOM"), [data-testid="bom-tab"]')
  }

  get whereUsedTab(): Locator {
    return this.page.locator(
      'button:has-text("Where Used"), [data-testid="where-used-tab"]',
    )
  }

  get relationshipsTab(): Locator {
    return this.page.locator(
      'button:has-text("Relationships"), [data-testid="relationships-tab"]',
    )
  }

  get stateBadge(): Locator {
    return this.page.locator('[data-testid="item-state"], .state-badge')
  }

  get workflowActions(): Locator {
    return this.page.locator('[data-testid="workflow-actions"]')
  }

  // ===== Actions =====

  /**
   * Click create part button
   */
  async clickCreate(): Promise<void> {
    await this.createButton.click()
    await this.page.waitForURL(/\/parts\/new/)
  }

  /**
   * Select a design from the dropdown
   * @returns true if a design was available, false otherwise
   */
  async selectFirstDesign(): Promise<boolean> {
    await this.designSelector.click()
    const count = await this.designOptions.count()
    if (count === 0) {
      // Close dropdown
      await this.page.keyboard.press('Escape')
      return false
    }
    await this.designOptions.first().click()
    return true
  }

  /**
   * Fill in part form fields
   */
  async fillPartForm(itemNumber: string, name: string): Promise<void> {
    await this.fillField(this.itemNumberInput, itemNumber)
    await this.fillField(this.nameInput, name)
  }

  /**
   * Submit the part form
   */
  async submit(): Promise<void> {
    await this.submitButton.click()
  }

  /**
   * Create a new part (full flow)
   * @returns true if successful, false if no designs available
   */
  async createPart(itemNumber: string, name: string): Promise<boolean> {
    const hasDesign = await this.selectFirstDesign()
    if (!hasDesign) return false

    await this.fillPartForm(itemNumber, name)
    await this.submit()
    await this.page.waitForURL(/\/parts\/[a-f0-9-]+$/, { timeout: 10000 })
    return true
  }

  /**
   * Search for parts
   */
  async search(query: string): Promise<void> {
    if (await this.searchInput.isVisible()) {
      await this.searchInput.focus()
      await this.searchInput.pressSequentially(query, { delay: 30 })
      // Wait for search to filter
      await this.page.waitForTimeout(500)
    }
  }

  /**
   * Click on first part in the list
   */
  async clickFirstPart(): Promise<void> {
    await this.partLinks.first().click()
    await this.page.waitForURL(/\/parts\/[a-f0-9-]+/)
  }

  /**
   * Navigate to BOM tab
   */
  async gotoBOM(): Promise<void> {
    if (await this.bomTab.isVisible()) {
      await this.bomTab.click()
    }
  }

  /**
   * Navigate to Where Used tab
   */
  async gotoWhereUsed(): Promise<void> {
    if (await this.whereUsedTab.isVisible()) {
      await this.whereUsedTab.click()
    }
  }
}
