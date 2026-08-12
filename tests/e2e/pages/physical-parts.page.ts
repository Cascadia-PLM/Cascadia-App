// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Physical Parts Page Object Model
 *
 * Handles the physical part (unit/lot) detail page: identity card,
 * genealogy (composition / where-used), and the digital thread section.
 */

import { expect } from '@playwright/test'
import { BasePage } from './base.page'
import type { Locator, Page } from '@playwright/test'

export class PhysicalPartsPage extends BasePage {
  constructor(page: Page) {
    super(page)
  }

  async goto(id?: string): Promise<void> {
    await this.page.goto(id ? `/physical-parts/${id}` : '/physical-parts')
  }

  // ===== Genealogy card =====

  get genealogyCard(): Locator {
    return this.page.locator('text=Genealogy')
  }

  get compositionSection(): Locator {
    return this.page.locator('text=Composition — what went into this')
  }

  get whereUsedSection(): Locator {
    return this.page.locator('text=Where used — what this went into')
  }

  /** Assert the composition tree contains a consumed serial. */
  async expectCompositionSerial(serialNumber: string): Promise<void> {
    await expect(
      this.page.locator(`a:has-text("SN ${serialNumber}")`).first(),
    ).toBeVisible({ timeout: 10000 })
  }

  /** Assert the composition tree contains a consumed lot. */
  async expectCompositionLot(lotNumber: string): Promise<void> {
    await expect(
      this.page.locator(`a:has-text("Lot ${lotNumber}")`).first(),
    ).toBeVisible({ timeout: 10000 })
  }
}
