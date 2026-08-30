// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ECO Release Journey E2E Test
 *
 * One journey, end to end, in the physical-traceability.spec.ts style:
 * API-seeded prerequisites, hard expects, no isVisible guards, no
 * conditional skips — the spec cannot green by vacancy.
 *
 * The journey is the product's signature loop: create an ECO against a
 * design, check a released part out to the ECO's branch, edit it there,
 * drive the seeded default workflow (Draft → Submit for Review → In Review
 * → Approve), and verify the release outcome — Approved is final with
 * finalKind 'release', so completing the workflow merges the branch and
 * assigns the next revision letter on main.
 */

import { expect, test } from '../fixtures'
import { ChangeOrdersPage } from '../pages'
import { seedFreshDesign } from '../seed'
import type { Page } from '@playwright/test'

interface SeededPart {
  id: string
  masterId?: string
  itemNumber: string
}

async function seedReleasedPart(
  page: Page,
  designId: string,
  itemNumber: string,
  name: string,
): Promise<SeededPart> {
  const response = await page.request.post('/api/v1/items', {
    data: {
      itemType: 'Part',
      designId,
      revision: 'A',
      state: 'Released',
      partType: 'Manufacture',
      itemNumber,
      name,
    },
  })
  expect(response.ok(), `part seed failed: ${await response.text()}`).toBe(true)
  const body = await response.json()
  return body.data.item as SeededPart
}

test.describe('ECO Release Journey', () => {
  test('create ECO → checkout → edit → Submit for Review → Approve → revision B on main', async ({
    authenticatedPage: page,
  }) => {
    const ecoPage = new ChangeOrdersPage(page)

    // ---- Seed: a fresh design with one released part (API) ----
    // A design of its own, because branch protection forbids creating items
    // directly on main once a design has released items — a fresh design's
    // first released part is the allowed bootstrap, and it keeps this
    // journey's ECO from ever seeing another run's leftovers.
    const designId: string = (await seedFreshDesign(page, 'E2E ECO Journey')).id
    const ts = Date.now()
    const originalName = `E2E Bracket ${ts}`
    const revisedName = `E2E Bracket ${ts} rev-B`
    const part = await seedReleasedPart(
      page,
      designId,
      `PN-E2E-ECO-${ts}`,
      originalName,
    )

    // ---- Create the ECO against that design (UI) ----
    await ecoPage.gotoNew()
    await expect(ecoPage.form).toBeVisible()
    await ecoPage.fillField(ecoPage.nameInput, `E2E Release Journey ${ts}`)
    await ecoPage.selectDesign(designId)
    await expect(ecoPage.submitButton).toBeEnabled()
    await ecoPage.submit()
    await page.waitForURL(/\/change-orders\/[a-f0-9-]+(\?.*)?$/, {
      timeout: 15000,
    })
    const ecoId = new URL(page.url()).pathname.split('/').pop()!
    expect(ecoId).toMatch(/^[a-f0-9-]+$/)

    // ---- Check the part out to the ECO's branch (UI) ----
    await page.goto(`/parts/${part.id}`)
    // A released item's edit affordance is Revise, which opens the checkout
    // dialog — released lineage on main is only edited through a branch.
    await page.getByRole('button', { name: 'Revise' }).click()
    const [checkoutResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/checkout') && r.request().method() === 'POST',
        { timeout: 20000 },
      ),
      ecoPage.checkoutToEco(page),
    ])
    expect(
      checkoutResponse.ok(),
      `checkout failed: ${await checkoutResponse.text()}`,
    ).toBe(true)
    // Checking out a released item mints its branch working copy up front;
    // the row the checkout returns points at it. Editing happens on the
    // working copy's own page — the same place the affected-items tab's View
    // action lands. (The checkout dialog also flips the original row's page
    // into an in-place edit whose save targets the original id and is
    // refused by branch protection — a product bug recorded in the
    // remediation plan's findings, not exercised here.)
    const checkoutBody = (await checkoutResponse.json()).data
    const workingCopyId: string = checkoutBody.branchItem.currentItemId
    const ecoBranchId: string = checkoutBody.branchItem.branchId
    expect(workingCopyId).toBeTruthy()
    expect(workingCopyId).not.toBe(part.id)

    // Checking out through the part page registers the change on the ECO's
    // affected-items list itself (a gap this journey originally surfaced:
    // the eager working-copy mint used to skip registration, and the
    // release then refused the unlisted branch content). Assert the
    // registration as an invariant; the release preview below depends on
    // it, and re-adding here would be rejected as a duplicate.
    const affectedResponse = await page.request.get(
      `/api/v1/change-orders/${ecoId}/affected-items`,
    )
    expect(affectedResponse.ok()).toBe(true)
    const { affectedItems } = (await affectedResponse.json()).data
    expect(
      JSON.stringify(affectedItems),
      'checkout did not register the revised part on the ECO',
    ).toContain(part.itemNumber)

    await page.goto(`/parts/${workingCopyId}?branch=${ecoBranchId}`)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()

    // In edit mode the testid rides the input itself; in view mode it
    // rides the value container.
    const nameInput = page.locator('input[data-testid="part-name"]')
    await expect(nameInput).toBeVisible({ timeout: 10000 })
    await expect(nameInput).toHaveValue(originalName)

    // ---- Edit on the branch and save (UI) ----
    await nameInput.fill(revisedName)
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/v1/parts/') && r.request().method() === 'PUT',
        { timeout: 15000 },
      ),
      page.locator('[data-testid="part-submit"]').click(),
    ])
    expect(
      saveResponse.ok(),
      `branch save failed (${saveResponse.url()}): ${await saveResponse.text()}`,
    ).toBe(true)
    // The save lands on the branch: the page leaves edit mode and shows the
    // new value (the view panel renders plain definition text, no testid).
    await expect(page.locator('main')).toContainText(revisedName, {
      timeout: 10000,
    })

    // ---- Drive the workflow: Submit for Review, then Approve (UI) ----
    await page.goto(`/change-orders/${ecoId}`)
    await ecoPage.transition('Submit for Review')
    // The next gate's action proves the state moved.
    await expect(
      page.getByRole('button', { name: 'Approve', exact: true }),
    ).toBeVisible({ timeout: 15000 })

    // The release preview is what arms the Approve dialog's confirm — a
    // false canRelease here names its reasons instead of a mute disabled
    // button.
    const previewResponse = await page.request.get(
      `/api/v1/change-orders/${ecoId}/release`,
    )
    expect(previewResponse.ok()).toBe(true)
    const preview = (await previewResponse.json()).data
    expect(
      preview.canRelease,
      `release blocked: ${JSON.stringify(preview.validationIssues)}`,
    ).toBe(true)

    await ecoPage.transition('Approve')
    // Approved is final with finalKind 'release': the transition runs the
    // merge before the state write — once the page reads Approved, the
    // release has happened.
    await expect(page.locator('main')).toContainText('Approved', {
      timeout: 30000,
    })

    // ---- The release outcome, asserted hard ----
    // API: main's current version of the part carries the next revision
    // letter and the branch's edit. at-context?released=true resolves the
    // master to its released/main version whatever row id we hold.
    const resolvedResponse = await page.request.get(
      `/api/v1/items/${part.id}/at-context?released=true`,
    )
    expect(resolvedResponse.ok()).toBe(true)
    const resolved = (await resolvedResponse.json()).data
    expect(resolved.item.revision).toBe('B')
    expect(resolved.item.name).toBe(revisedName)
    expect(resolved.item.id).not.toBe(part.id)

    // UI: the part page on main shows the released revision's content.
    await page.goto(`/parts/${resolved.item.id}`)
    await expect(page.locator('main')).toContainText(revisedName, {
      timeout: 10000,
    })
  })
})
