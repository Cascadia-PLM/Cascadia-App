// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Work Orders Page Object Model
 *
 * Handles work order creation and the detail page's Materials /
 * Produced Units / Qualification / Thread tabs — the MES capture surface.
 */

import { expect } from '@playwright/test'
import { BasePage } from './base.page'
import type { Locator, Page } from '@playwright/test'

export class WorkOrdersPage extends BasePage {
  constructor(page: Page) {
    super(page)
  }

  async goto(id?: string): Promise<void> {
    await this.page.goto(id ? `/work-orders/${id}` : '/work-orders')
  }

  async gotoNew(): Promise<void> {
    await this.page.goto('/work-orders/new')
  }

  // ===== Create Form =====

  get partSearchInput(): Locator {
    return this.page.locator('input[placeholder="Search for a part..."]')
  }

  get createSubmitButton(): Locator {
    return this.page.locator('button:has-text("Create Work Order")')
  }

  /**
   * Create a work order for the given part via the UI.
   * @returns the created work order's id (from the URL)
   */
  async createForPart(partItemNumber: string): Promise<string> {
    await this.gotoNew()
    await this.partSearchInput.focus()
    await this.partSearchInput.pressSequentially(partItemNumber, { delay: 30 })
    await this.page
      .locator(`button:has-text("${partItemNumber}")`)
      .first()
      .click()
    await this.createSubmitButton.click()
    await this.page.waitForURL(/\/work-orders\/[a-f0-9-]+$/, {
      timeout: 10000,
    })
    return this.page.url().split('/').pop() ?? ''
  }

  /** The work order number shown in the detail header (WO-######). */
  async workOrderNumber(): Promise<string> {
    const heading = this.page.locator('h1')
    await expect(heading).toContainText(/WO-/)
    return (await heading.innerText()).trim()
  }

  // ===== Tabs =====

  async openTab(
    name: 'Details' | 'Instructions' | 'Materials' | 'Qualification' | 'Thread',
  ): Promise<void> {
    await this.page.getByRole('tab', { name }).click()
  }

  // ===== Materials tab =====

  get materialPartSearch(): Locator {
    return this.page.locator('input[placeholder*="Search part to consume"]')
  }

  get identityInput(): Locator {
    // Serial ("Scan or type serial number…") or lot ("Lot number…") input
    return this.page.locator(
      'input[placeholder*="serial number"], input[placeholder*="Lot number"]',
    )
  }

  get quantityInput(): Locator {
    return this.page.locator('input[type="number"]').first()
  }

  /** Pick the part to consume in the scan-first entry row. */
  async selectMaterialPart(partItemNumber: string): Promise<void> {
    await this.materialPartSearch.focus()
    await this.materialPartSearch.pressSequentially(partItemNumber, {
      delay: 30,
    })
    await this.page
      .locator(`button:has-text("${partItemNumber}")`)
      .first()
      .click()
  }

  /** Scan a serial for the selected part (Enter submits). */
  async consumeSerial(serialNumber: string): Promise<void> {
    await this.identityInput.fill(serialNumber)
    await this.identityInput.press('Enter')
    await expect(
      this.page.locator(`a:has-text("SN ${serialNumber}")`),
    ).toBeVisible({ timeout: 10000 })
  }

  /** Enter a lot + quantity for the selected part (Enter submits). */
  async consumeLot(lotNumber: string, quantity: number): Promise<void> {
    await this.quantityInput.fill(String(quantity))
    await this.identityInput.fill(lotNumber)
    await this.identityInput.press('Enter')
    await expect(
      this.page.locator(`a:has-text("Lot ${lotNumber}")`),
    ).toBeVisible({ timeout: 10000 })
  }

  /** Clear the selected material part (back to part search). */
  async changeMaterialPart(): Promise<void> {
    await this.page.locator('button:has-text("Change")').click()
  }

  // ===== Produced Units card =====

  get producedSerialsInput(): Locator {
    return this.page.locator('input[placeholder*="enter serials"]')
  }

  /** Record produced serials (comma-separated; Enter submits). */
  async produceSerials(serialNumbers: Array<string>): Promise<void> {
    await this.producedSerialsInput.fill(serialNumbers.join(','))
    await this.producedSerialsInput.press('Enter')
    for (const serial of serialNumbers) {
      await expect(this.producedUnitBadge(serial)).toBeVisible({
        timeout: 10000,
      })
    }
  }

  producedUnitBadge(serialNumber: string): Locator {
    return this.page.locator(`a:has-text("SN ${serialNumber}")`).first()
  }

  /** Open a produced unit's physical-part page from its badge. */
  async openProducedUnit(serialNumber: string): Promise<void> {
    await this.producedUnitBadge(serialNumber).click()
    await this.page.waitForURL(/\/physical-parts\/[a-f0-9-]+$/, {
      timeout: 10000,
    })
  }

  // ===== Qualification tab =====

  get uncertifiedMaterialsCard(): Locator {
    return this.page.locator('text=Uncertified materials')
  }

  async expectUncertifiedLot(lotNumber: string): Promise<void> {
    await expect(this.uncertifiedMaterialsCard).toBeVisible({ timeout: 10000 })
    await expect(
      this.page.locator(`a:has-text("Lot ${lotNumber}")`).first(),
    ).toBeVisible()
  }
}
