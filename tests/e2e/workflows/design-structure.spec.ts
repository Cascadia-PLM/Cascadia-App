// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design Structure Tab E2E Journey
 *
 * One journey, end to end, in the design-management.spec.ts style: seed a
 * design and its parts over the API, open the design detail page (Structure
 * is the default tab), and drive the tab's write paths through the UI —
 * create a part in place, add a part from another design, add a BOM child,
 * create a child in place, remove a root from the structure, delete a part,
 * and add then remove a cross-design reference.
 *
 * Every assertion here is about the tree restaging *without a page reload*.
 * The Structure tab reads `designStructureQuery` from the shared cache, and
 * its dialogs refresh it by naming the resource they wrote: design membership
 * writes invalidate 'designs' directly, the BOM-child add invalidates
 * 'relationships' and reaches the tree through the RESOURCE_DEPENDENTS
 * fan-out, and the in-place creates and the delete invalidate 'parts' and
 * reach it through 'relationships' — three different wires, each pinned by a
 * phase below. If that wiring is dropped, the writes still succeed and the
 * page still renders; the only observable failure is the tree not changing
 * until a reload, which is exactly what these expects wait on. The window
 * marker at the end proves no reload happened behind their back.
 */

import { expect, test } from '../fixtures'
import { seedFreshDesign } from '../seed'
import { seedPart } from '../helpers/test-data'

/** Set before the first structure edit, checked after the last: survives
 * client-side routing and cache refreshes, but not a page reload. */
type MarkedWindow = Window & { __structureJourneyMarker?: true }

test.describe('Design Structure Journey', () => {
  test('structure edits restage the BOM tree in place — add, nest, remove, delete, reference', async ({
    authenticatedPage: page,
  }) => {
    const ts = Date.now()

    // The design under test holds two root parts. The donor design exists
    // because the Add Part dialog's Use Existing step only offers parts from
    // *other* designs — its usage-copy mode copies the part in, keeping the
    // item number, and its reference mode links one without copying it.
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
    const referenced = await seedPart(page, donorDesign.id, {
      itemNumber: `PN-E2E-ST-REF-${ts}`,
      name: `E2E Structure Referenced ${ts}`,
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

    // ---- Create a part in place (writes an item) ----
    // The greenfield gesture: Add Part → Create New, the item number left
    // blank so the server numbers it. The part is created in this design,
    // which designates it a top-level part, and the tree shows it as a root
    // via the third wire — invalidate('parts') reaching 'designs' through
    // 'relationships'.
    await page.getByRole('button', { name: 'Add Part' }).click()
    const createDialog = page.getByRole('dialog')
    await expect(createDialog).toBeVisible()
    await createDialog.getByRole('button', { name: 'Create New' }).click()
    await createDialog
      .getByTestId('create-part-name')
      .fill(`E2E Structure Created ${ts}`)
    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/v1/items' &&
          r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      createDialog.getByTestId('create-part-submit').click(),
    ])
    expect(
      createResponse.ok(),
      `create part failed: ${await createResponse.text()}`,
    ).toBe(true)
    const created = (await createResponse.json()).data.item as {
      id: string
      itemNumber: string
    }
    await expect(createDialog).toBeHidden({ timeout: 15000 })
    await expect(
      page.getByText(created.itemNumber, { exact: true }),
    ).toBeVisible({ timeout: 15000 })

    // ---- Add a part from the donor design (writes design membership) ----
    await page.getByRole('button', { name: 'Add Part' }).click()
    const addDialog = page.getByRole('dialog')
    await expect(addDialog).toBeVisible()
    await addDialog.getByRole('button', { name: 'Use Existing' }).click()
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
    await childDialog.getByRole('button', { name: 'Use Existing' }).click()
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

    // ---- Create a child in place (writes an item, then a relationship) ----
    // Add Child → Create New makes the part in this design and nests it under
    // the parent in one go. The parent is expanded from the step above, so
    // the new number shows under it; the server's structure says whether it
    // is a child or a root.
    await page
      .getByText(parent.itemNumber, { exact: true })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add Child' }).click()
    const createChildDialog = page.getByRole('dialog')
    await expect(createChildDialog).toBeVisible()
    await createChildDialog.getByRole('button', { name: 'Create New' }).click()
    await createChildDialog
      .getByTestId('create-part-name')
      .fill(`E2E Structure Created Child ${ts}`)
    const [childCreateResponse, childEdgeResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/v1/items' &&
          r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      page.waitForResponse(
        (r) =>
          r.url().includes(`/items/${parent.id}/relationships`) &&
          r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      createChildDialog.getByTestId('create-part-submit').click(),
    ])
    expect(
      childCreateResponse.ok(),
      `create child failed: ${await childCreateResponse.text()}`,
    ).toBe(true)
    expect(
      childEdgeResponse.ok(),
      `nest child failed: ${await childEdgeResponse.text()}`,
    ).toBe(true)
    const createdChild = (await childCreateResponse.json()).data.item as {
      id: string
      itemNumber: string
    }
    await expect(createChildDialog).toBeHidden({ timeout: 15000 })
    await expect(
      page.getByText(createdChild.itemNumber, { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    const structureResponse = await page.request.get(
      `/api/v1/designs/${design.id}/structure`,
    )
    const structure = (await structureResponse.json()).data as {
      roots: Array<{ itemId: string; children?: Array<{ itemId: string }> }>
    }
    expect(structure.roots.map((r) => r.itemId)).not.toContain(createdChild.id)
    expect(
      structure.roots
        .find((r) => r.itemId === parent.id)
        ?.children?.map((c) => c.itemId),
    ).toContain(createdChild.id)

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

    // ---- Delete a part (writes an item) ----
    // Through the row's visible menu rather than a right-click, since the menu
    // is how the action gets found. The part created in place at the start is
    // a root of a design with nothing released, viewed on main, which is where
    // Delete Part is offered. It leaves the page altogether — the tree and
    // Non-Structure Items both — through the third wire.
    await page
      .getByRole('button', { name: `Actions for ${created.itemNumber}` })
      .click()
    await page.getByRole('menuitem', { name: 'Delete Part' }).click()
    const deleteDialog = page.getByRole('alertdialog')
    await expect(deleteDialog).toBeVisible()
    const [deleteResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/v1/parts/${created.id}` &&
          r.request().method() === 'DELETE',
        { timeout: 15000 },
      ),
      deleteDialog.getByRole('button', { name: 'Delete' }).click(),
    ])
    expect(
      deleteResponse.ok(),
      `delete part failed: ${await deleteResponse.text()}`,
    ).toBe(true)
    await expect(
      page.getByText(created.itemNumber, { exact: true }),
    ).toHaveCount(0, { timeout: 15000 })
    const deletedRead = await page.request.get(`/api/v1/parts/${created.id}`)
    expect(deletedRead.status(), 'the deleted part is still readable').toBe(404)

    // ---- Reference a part, then remove the reference (writes design membership) ----
    // Use Existing's other mode links the donor design's part instead of
    // copying it in, and the tree shows it as a reference root. Remove
    // Reference drops the link: the root leaves the tree, and the part is
    // still there in its own design.
    await page.getByRole('button', { name: 'Add Part' }).click()
    const referenceDialog = page.getByRole('dialog')
    await expect(referenceDialog).toBeVisible()
    await referenceDialog.getByRole('button', { name: 'Use Existing' }).click()
    await referenceDialog
      .getByRole('button', { name: 'Cross-Design Reference' })
      .click()
    await referenceDialog
      .getByPlaceholder('Search by part number or name...')
      .fill(referenced.itemNumber)
    const referencedRow = referenceDialog
      .locator('label')
      .filter({ hasText: referenced.itemNumber })
      .first()
    await expect(referencedRow).toBeVisible()
    await referencedRow.getByRole('checkbox').click()
    const [referenceResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/designs/${design.id}/items`) &&
          r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      referenceDialog.getByRole('button', { name: 'Add (1)' }).click(),
    ])
    expect(
      referenceResponse.ok(),
      `add reference failed: ${await referenceResponse.text()}`,
    ).toBe(true)
    await expect(referenceDialog).toBeHidden({ timeout: 15000 })
    await expect(
      page.getByText(referenced.itemNumber, { exact: true }),
    ).toBeVisible({ timeout: 15000 })

    await page
      .getByRole('button', { name: `Actions for ${referenced.itemNumber}` })
      .click()
    await page.getByRole('menuitem', { name: 'Remove Reference' }).click()
    const unreferenceDialog = page.getByRole('alertdialog')
    await expect(unreferenceDialog).toBeVisible()
    const [unreferenceResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/designs/${design.id}/cross-references`) &&
          r.request().method() === 'DELETE',
        { timeout: 15000 },
      ),
      unreferenceDialog.getByRole('button', { name: 'Remove' }).click(),
    ])
    expect(
      unreferenceResponse.ok(),
      `remove reference failed: ${await unreferenceResponse.text()}`,
    ).toBe(true)
    await expect(
      page.getByText(referenced.itemNumber, { exact: true }),
    ).toHaveCount(0, { timeout: 15000 })
    const referencedRead = await page.request.get(
      `/api/v1/parts/${referenced.id}`,
    )
    expect(
      referencedRead.ok(),
      'removing the reference touched the part it named',
    ).toBe(true)

    // Every restage above happened on the page loaded at the start — had the
    // page reloaded, the fresh loads would have painted the same end states
    // without invalidation ever firing, and this marker would be gone.
    const markerSurvived = await page.evaluate(
      () => (window as MarkedWindow).__structureJourneyMarker === true,
    )
    expect(markerSurvived, 'the page reloaded mid-journey').toBe(true)
  })
})
