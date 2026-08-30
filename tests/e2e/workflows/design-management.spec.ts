// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design Management E2E Journey
 *
 * One journey, end to end, in the eco-workflow.spec.ts style: the design is
 * created through the UI, then found, opened and read — every step a hard
 * expect against a design this test knows the name of.
 *
 * What it replaces: fourteen tests that each opened the designs list, took
 * whatever row happened to be first, and wrapped every assertion in
 * `if (await …isVisible())`. On an empty list they all passed having asserted
 * nothing; on a full one they asserted things about someone else's data. The
 * three-gate rule does not mourn them.
 */

import { expect, test } from '../fixtures'
import { DesignsPage } from '../pages'
import { seedFreshDesign } from '../seed'

test.describe('Design Management Journey', () => {
  test('create a design → find it in the list → open it → main branch is there', async ({
    authenticatedPage: page,
  }) => {
    const designsPage = new DesignsPage(page)
    const ts = Date.now()
    const suffix =
      `${ts}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase()
    const name = `E2E Journey Design ${suffix}`
    const code = `E2E-JD-${suffix}`

    // ---- Reach the designs area the way a user does (UI) ----
    await page.goto('/')
    await designsPage.navigateViaMenu()
    await expect(page).toHaveURL(/\/designs/)
    await designsPage.waitForReady()

    // ---- Create the design (UI) ----
    // The program comes from global setup; naming it rather than taking
    // whichever option is first keeps this journey independent of what else
    // has run.
    const programsResponse = await page.request.get('/api/v1/programs')
    expect(programsResponse.ok()).toBe(true)
    const programs = (await programsResponse.json()).data.programs as Array<{
      id: string
      name: string
    }>
    expect(
      programs.length,
      'no programs — e2e global setup should have created one',
    ).toBeGreaterThan(0)
    const program = programs[0]!

    await page.getByRole('link', { name: 'Create Design' }).click()
    await page.waitForURL(/\/designs\/new/, { timeout: 15000 })
    await page.getByRole('textbox', { name: 'Design Name' }).fill(name)
    await page.getByRole('textbox', { name: 'Design Code' }).fill(code)

    // A design with no program is reachable by different rules than one with
    // a program, so the journey pins the ordinary case. The trigger defaults
    // to "No Program" and carries no accessible name — its <label htmlFor>
    // points at a <button>, which gives nothing to match on.
    await page.getByRole('combobox').filter({ hasText: 'No Program' }).click()
    // The option label is `${code} - ${name}`, so match on the name the API
    // gave us rather than on position.
    await page
      .getByRole('option')
      .filter({ hasText: program.name })
      .first()
      .click()

    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/v1/designs') &&
          r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      page.getByRole('button', { name: 'Create Design' }).click(),
    ])
    expect(
      createResponse.ok(),
      `design create failed: ${await createResponse.text()}`,
    ).toBe(true)
    const created = (await createResponse.json()).data.design as { id: string }

    // ---- Find it in the list by code, not by position (UI) ----
    await designsPage.goto()
    await designsPage.waitForReady()
    await designsPage.search(code)
    const row = page.locator('tr', { hasText: code })
    await expect(row).toBeVisible({ timeout: 10000 })

    // ---- Open it and read what the detail page promises (UI) ----
    await row.getByRole('link').first().click()
    await page.waitForURL(new RegExp(`/designs/${created.id}`), {
      timeout: 15000,
    })
    await expect(page.locator('main')).toContainText(name, { timeout: 10000 })

    // ---- A new design has a main branch, and the selector shows it ----
    // Not a UI detail: every version-resolution path in the product resolves
    // through the design's default branch, so a design without one is broken
    // in a way no other assertion here would catch.
    const branchesResponse = await page.request.get(
      `/api/v1/designs/${created.id}/branches`,
    )
    expect(branchesResponse.ok()).toBe(true)
    const branches = (await branchesResponse.json()).data.branches as Array<{
      name: string
      branchType: string
    }>
    expect(branches.map((b) => b.branchType)).toContain('main')

    const branchSelector = designsPage.branchSelector.first()
    await expect(branchSelector).toBeVisible({ timeout: 10000 })
    await branchSelector.click()
    await expect(
      page.locator('[role="option"]', { hasText: 'main' }).first(),
    ).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Escape')
  })

  test('a seeded design opens straight from its own URL', async ({
    authenticatedPage: page,
  }) => {
    // The API-seeded path, kept because the create form is not the only way a
    // design arrives — imports and MBOM derivation both make one without it.
    const design = await seedFreshDesign(page, 'E2E Direct Open')

    await page.goto(`/designs/${design.id}`)

    await expect(page.locator('main')).toContainText(design.name, {
      timeout: 15000,
    })
  })
})
