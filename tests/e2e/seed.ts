// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * API seeding helpers shared by the workflow specs.
 *
 * Every spec that creates items seeds its own fresh design and selects it
 * explicitly. Picking "the first design in the list" is a time bomb: the
 * designs listing is newest-first, and any spec that releases an item (the
 * ECO release journey does) leaves behind a design on which direct item
 * creation is branch-protected — whichever spec grabbed the list head next
 * failed with BRANCH_PROTECTED, or sat on a create form whose submit never
 * enabled. A fresh design per spec also keeps runs from seeing each other's
 * leftovers, whatever order the workers schedule.
 */

import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export interface SeededDesign {
  id: string
  name: string
}

/**
 * Create a fresh design over the API and return its id and (unique) name.
 * The design belongs to the global-setup program and starts with no released
 * items, so direct item creation on it is allowed.
 */
export async function seedFreshDesign(
  page: Page,
  label: string,
): Promise<SeededDesign> {
  const programsResponse = await page.request.get('/api/v1/programs')
  const programs = (await programsResponse.json()).data?.programs ?? []
  expect(
    programs.length,
    'no programs in the database — e2e global setup should have created one',
  ).toBeGreaterThan(0)

  // Uppercase: design codes must match uppercase-alphanumeric-with-hyphens.
  const suffix =
    `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase()
  const name = `${label} ${suffix}`
  const response = await page.request.post('/api/v1/designs', {
    data: {
      programId: programs[0].id,
      name,
      code: `E2E-${suffix}`,
      designType: 'Engineering',
    },
  })
  expect(response.ok(), `design seed failed: ${await response.text()}`).toBe(
    true,
  )
  const design = (await response.json()).data.design
  return { id: design.id, name }
}

/**
 * Open a create form's design selector and pick the given design by its
 * (unique) seeded name — never "the first option".
 */
export async function selectDesignByName(
  page: Page,
  name: string,
): Promise<void> {
  await page.locator('[data-testid="design-selector"]').click()
  const option = page.locator('[role="option"]', { hasText: name })
  await option.waitFor({ state: 'visible', timeout: 10000 })
  await option.click()
}
