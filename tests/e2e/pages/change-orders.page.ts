// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Change Orders (ECO) Page Object Model
 *
 * Locators and actions for the ECO release journey: create, checkout, and
 * workflow transitions. Every action here is a hard step — the guarded
 * methods this file used to carry (isVisible checks that silently skipped
 * the step) went out with the conditional tests that needed them.
 */

import { expect } from '@playwright/test'
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

  // ===== List Page Locators =====

  get table(): Locator {
    return this.page.locator(
      'table, [data-testid="change-orders-table"], [data-testid="change-orders-list"]',
    )
  }

  get createButton(): Locator {
    return this.page.locator(
      '[data-testid="create-eco-button"], button:has-text("New"), button:has-text("Create")',
    )
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

  /** Selectable designs in the create form's affected-designs picker. */
  get designOptions(): Locator {
    return this.page.locator('[data-testid="design-option"]')
  }

  // ===== Actions =====

  /**
   * Pick a specific design in the affected-designs picker — the options
   * carry their design id, so the test selects the design it seeded into
   * rather than whichever row sorts first.
   */
  async selectDesign(designId: string): Promise<void> {
    const option = this.page.locator(
      `[data-testid="design-option"][data-design-id="${designId}"]`,
    )
    await option.waitFor({ state: 'visible', timeout: 10000 })
    await option.click()
  }

  /**
   * Submit the ECO form
   */
  async submit(): Promise<void> {
    await this.submitButton.click()
  }

  /**
   * Create a new ECO against a specific design and land on its detail page.
   */
  async createECO(name: string, designId: string): Promise<void> {
    await this.fillField(this.nameInput, name)
    await this.selectDesign(designId)
    await this.submit()
    await this.page.waitForURL(/\/change-orders\/[a-f0-9-]+(\?.*)?$/, {
      timeout: 15000,
    })
  }

  /**
   * Complete the checkout dialog onto the (single) active ECO branch: pick
   * the Existing Change Order option, select the branch, confirm. Assumes
   * the dialog is already open (the part page's Revise button opens it).
   */
  async checkoutToEco(page: Page): Promise<void> {
    await page.locator('[data-testid="checkout-option-eco"]').click()

    // Radix Select locks pointer events on everything outside its open
    // listbox, so the click that successfully opened it can still be
    // reported as intercepted and spin until timeout. Fire the click with a
    // short leash and let the listbox option's own hard wait be the truth —
    // nothing is skipped: if the select genuinely never opened, the option
    // wait below fails the test.
    const trigger = page.locator('[data-testid="checkout-eco-branch-select"]')
    const branchOption = page
      .locator('[data-testid="checkout-eco-branch-option"]')
      .first()
    await trigger.click({ timeout: 3000 }).catch(() => {})
    // One retry if the listbox did not open on the first click. Expressed as
    // a short wait rather than an isVisible branch: the hard wait below is
    // still the verdict, so nothing here can silently skip the selection.
    await branchOption
      .waitFor({ state: 'visible', timeout: 2000 })
      .catch(async () => {
        await trigger.click({ timeout: 3000 }).catch(() => {})
      })
    await branchOption.waitFor({ state: 'visible', timeout: 5000 })
    await branchOption.click()

    const confirm = page.locator('[data-testid="checkout-confirm"]')
    await expect(confirm).toBeEnabled({ timeout: 5000 })
    await confirm.click()
  }

  /**
   * Fire a workflow transition by its name — the transition buttons render
   * the transition's own name as their label, backed by
   * POST /change-orders/:id/workflow/transition — and confirm it in the
   * transition dialog.
   */
  async transition(name: string): Promise<void> {
    await this.page.getByRole('button', { name, exact: true }).click()
    const confirm = this.page.getByRole('button', {
      name: 'Confirm Transition',
    })
    await confirm.waitFor({ state: 'visible', timeout: 10000 })
    // The dialog disables Confirm while its transition data (and, for a
    // releasing transition, the release preview) loads — wait for enabled
    // rather than clicking into the disabled window.
    await expect(confirm).toBeEnabled({ timeout: 20000 })
    await confirm.click()
  }
}
