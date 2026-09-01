// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design Structure Tab E2E Journey
 *
 * One journey, end to end, in the design-management.spec.ts style: seed a
 * design and its parts over the API, open the design detail page (Structure
 * is the default tab), and drive the tab's three write paths through the UI —
 * add a part from another design, add a BOM child, remove a root from the
 * structure.
 *
 * Every assertion here is about the tree restaging *without a page reload*.
 * The Structure tab reads `designStructureQuery` from the shared cache, and
 * its dialogs refresh it by naming the resource they wrote: design membership
 * writes invalidate 'designs' directly, while the BOM-child add invalidates
 * 'relationships' and reaches the tree through the RESOURCE_DEPENDENTS
 * fan-out — two different wires, each pinned by its own phase below. If that
 * wiring is dropped, the writes still succeed and the page still renders; the
 * only observable failure is the tree not changing until a reload, which is
 * exactly what these expects wait on. The window marker at the end proves no
 * reload happened behind their back.
 */

import { expect, test } from '../fixtures'
import { seedFreshDesign } from '../seed'
import { seedPart } from '../helpers/test-data'

/** Set before the first structure edit, checked after the last: survives
 * client-side routing and cache refreshes, but not a page reload. */
type MarkedWindow = Window & { __structureJourneyMarker?: true }

test.describe('Design Structure Journey', () => {
  test('structure edits restage the BOM tree in place — add part, add BOM child, remove from structure', async ({
    authenticatedPage: page,
  }) => {
    const ts = Date.now()

    // The design under test holds two root parts. The donor design exists
    // because the Add Part dialog only offers parts from *other* designs —
    // its usage-copy mode copies the part in, keeping the item number.
    const design = await seedFreshDesign(page, 'E2E Structure Journey')
    const parent = await seedPart(page, design.id, {
      itemNumber: `PN-E2E-ST-PARENT-${ts}`,
      name: `E2E Structure Parent ${ts}`,
    })
    const child = await seedPart(page, design.id, {
      itemNumber: `PN-E2E-ST-CHILD-${ts}`,
      name: `E2E Structure Child ${ts}`,
    })
    const donorDesign = await seedFreshDesign(page, 'E2E Structure Donor')
    const donor = await seedPart(page, donorDesign.id, {
      itemNumber: `PN-E2E-ST-DONOR-${ts}`,
      name: `E2E Structure Donor ${ts}`,
    })

    // ---- Open the design; Structure is the default tab ----
    await page.goto(`/designs/${design.id}`)
    await expect(
      page.getByRole('heading', { name: 'Design Structure' }),
    ).toBeVisible({ timeout: 15000 })
    await expect(
      page.getByText(parent.itemNumber, { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    await expect(
      page.getByText(child.itemNumber, { exact: true }),
    ).toBeVisible()

    // From here on nothing navigates and nothing reloads.
    await page.evaluate(() => {
      ;(window as MarkedWindow).__structureJourneyMarker = true
    })

    // ---- Add a part from the donor design (writes design membership) ----
    await page.getByRole('button', { name: 'Add Part' }).click()
    const addDialog = page.getByRole('dialog')
    await expect(addDialog).toBeVisible()
    await addDialog
      .getByPlaceholder('Search by part number or name...')
      .fill(donor.itemNumber)
    const donorRow = addDialog
      .locator('label')
      .filter({ hasText: donor.itemNumber })
      .first()
    await expect(donorRow).toBeVisible()
    await donorRow.getByRole('checkbox').click()

    const [addResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/designs/${design.id}/items`) &&
          r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      addDialog.getByRole('button', { name: 'Add (1)' }).click(),
    ])
    expect(
      addResponse.ok(),
      `add to design failed: ${await addResponse.text()}`,
    ).toBe(true)

    // The dialog closes and the tree restages to show the usage copy as a new
    // root — same item number, no reload, no local re-read. (Waiting for the
    // dialog first keeps the number unambiguous on the page.)
    await expect(addDialog).toBeHidden({ timeout: 15000 })
    await expect(page.getByText(donor.itemNumber, { exact: true })).toBeVisible(
      { timeout: 15000 },
    )

    // ---- Add a BOM child (writes a relationship) ----
    // The child part is currently its own root. Nesting it under the parent
    // goes through invalidate('relationships'), which only reaches this tree
    // via the RESOURCE_DEPENDENTS fan-out to 'designs' — the second wire.
    await page
      .getByText(parent.itemNumber, { exact: true })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add Child' }).click()
    const childDialog = page.getByRole('dialog')
    await expect(childDialog).toBeVisible()
    await childDialog
      .getByPlaceholder('Search by part number or name...')
      .fill(child.itemNumber)
    const childResult = childDialog
      .getByRole('button')
      .filter({ hasText: child.itemNumber })
      .first()
    await expect(childResult).toBeVisible()
    await childResult.click()

    const [edgeResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/items/${parent.id}/relationships`) &&
          r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      childDialog.getByRole('button', { name: 'Add to BOM' }).click(),
    ])
    expect(
      edgeResponse.ok(),
      `BOM edge create failed: ${await edgeResponse.text()}`,
    ).toBe(true)

    // The refreshed tree no longer lists the child as a root, and its new
    // parent starts collapsed — so the child's number leaves the page
    // entirely. A tree that never refetched keeps the stale root row and
    // fails here.
    await expect(page.getByText(child.itemNumber, { exact: true })).toHaveCount(
      0,
      { timeout: 15000 },
    )

    // Expanding shows the same part again, now nested under its parent.
    await page.getByRole('button', { name: 'Expand All' }).click()
    await expect(
      page.getByText(child.itemNumber, { exact: true }),
    ).toBeVisible()

    // ---- Remove a root from the structure (writes design membership) ----
    await page
      .getByText(donor.itemNumber, { exact: true })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Remove from Structure' }).click()
    const confirmDialog = page.getByRole('alertdialog')
    await expect(confirmDialog).toBeVisible()
    const [removeResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/designs/${design.id}/items`) &&
          r.request().method() === 'DELETE',
        { timeout: 15000 },
      ),
      confirmDialog.getByRole('button', { name: 'Remove' }).click(),
    ])
    expect(
      removeResponse.ok(),
      `remove from structure failed: ${await removeResponse.text()}`,
    ).toBe(true)

    // The part moves to Non-Structure Items — a section that did not exist on
    // this page until this refresh. The grid renders item numbers as links
    // where the tree renders plain spans, so the link proves it joined the
    // grid and the count of one proves it also left the tree.
    await expect(
      page.getByRole('heading', { name: 'Non-Structure Items' }),
    ).toBeVisible({ timeout: 15000 })
    await expect(
      page.getByRole('link', { name: donor.itemNumber }),
    ).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(donor.itemNumber, { exact: true })).toHaveCount(
      1,
    )

    // Every restage above happened on the page loaded at the start — had the
    // page reloaded, the fresh loads would have painted the same end states
    // without invalidation ever firing, and this marker would be gone.
    const markerSurvived = await page.evaluate(
      () => (window as MarkedWindow).__structureJourneyMarker === true,
    )
    expect(markerSurvived, 'the page reloaded mid-journey').toBe(true)
  })
})
