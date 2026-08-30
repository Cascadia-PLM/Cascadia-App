// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * BOM Management E2E Journey
 *
 * One journey, end to end, in the eco-workflow.spec.ts style: seed an assembly
 * and a child over the API, build the structure through the UI, then read it
 * back through both the UI and the relationship API — the two have to agree,
 * because the BOM view resolving differently from the data underneath it is
 * the failure worth catching.
 *
 * What it replaces: sixteen tests that opened `/parts`, took whatever row was
 * first, and wrapped every assertion in `if (await …isVisible())`. Nothing they
 * asserted survived an empty parts list, and on a full one they asserted things
 * about another spec's data.
 */

import { expect, test } from '../fixtures'
import { seedFreshDesign } from '../seed'
import { seedBomEdge, seedPart } from '../helpers/test-data'

test.describe('BOM Management Journey', () => {
  test('add a child through the UI → it reaches the BOM tree, the relationship API, and where-used', async ({
    authenticatedPage: page,
  }) => {
    const ts = Date.now()
    const designId = (await seedFreshDesign(page, 'E2E BOM Journey')).id

    const assembly = await seedPart(page, designId, {
      itemNumber: `PN-E2E-ASM-${ts}`,
      name: `E2E Assembly ${ts}`,
    })
    const child = await seedPart(page, designId, {
      itemNumber: `PN-E2E-CHILD-${ts}`,
      name: `E2E Child ${ts}`,
    })

    // ---- Add the child through the UI ----
    await page.goto(`/parts/${assembly.id}?tab=relationships`)
    await page.getByRole('tab', { name: 'BOM Structure' }).click()

    // Relationship edits follow the click-Edit policy: the panel is read-only
    // until the item is checked out, and an unreleased part on main takes the
    // lock directly.
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Add Relationship' }).click()

    // The panel's Add opens the type chooser first — a relationship needs a
    // type before it needs a target — so the journey picks BOM and then the
    // item, which is the path a user actually walks.
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await dialog.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'BOM', exact: true }).click()

    const search = dialog.getByPlaceholder('Search by item number or name...')
    await expect(search).toBeVisible({ timeout: 10000 })
    await search.fill(child.itemNumber)

    const result = dialog
      .locator('div.divide-y > button')
      .filter({ hasText: child.itemNumber })
      .first()
    await expect(result).toBeVisible({ timeout: 10000 })
    await result.click()

    const confirm = dialog.getByRole('button', {
      name: 'Add Relationship',
      exact: true,
    })
    await expect(confirm).toBeEnabled({ timeout: 10000 })
    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/relationships') && r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      confirm.click(),
    ])
    expect(
      createResponse.ok(),
      `relationship create failed: ${await createResponse.text()}`,
    ).toBe(true)

    // ---- The tree shows it ----
    await expect(page.locator('main')).toContainText(child.itemNumber, {
      timeout: 15000,
    })

    // ---- And so does the API, as a BOM edge rather than some other type ----
    const relationshipsResponse = await page.request.get(
      `/api/v1/items/${assembly.id}/relationships`,
    )
    expect(relationshipsResponse.ok()).toBe(true)
    const { relationships } = (await relationshipsResponse.json()).data as {
      relationships: Array<{
        relationshipType: string
        targetItem: { id: string; itemNumber: string }
      }>
    }
    expect(
      relationships
        .filter((r) => r.relationshipType === 'BOM')
        .map((r) => r.targetItem.itemNumber),
      'the edge the UI created is not in the relationship API',
    ).toContain(child.itemNumber)

    // ---- Where-used is the same edge read from the other end ----
    await page.goto(`/parts/${child.id}?tab=relationships`)
    await page.getByRole('tab', { name: 'Where Used' }).click()
    await expect(page.locator('main')).toContainText(assembly.itemNumber, {
      timeout: 15000,
    })
  })

  test('a seeded three-level BOM renders every level, with its quantities intact', async ({
    authenticatedPage: page,
  }) => {
    // Seeded rather than built through the UI: the point here is what the tree
    // *renders*, and driving three levels of dialog to get there would test the
    // dialog again instead.
    const ts = Date.now()
    const designId = (await seedFreshDesign(page, 'E2E BOM Depth')).id

    const top = await seedPart(page, designId, {
      itemNumber: `PN-E2E-TOP-${ts}`,
      name: `E2E Top ${ts}`,
    })
    const mid = await seedPart(page, designId, {
      itemNumber: `PN-E2E-MID-${ts}`,
      name: `E2E Mid ${ts}`,
    })
    const leaf = await seedPart(page, designId, {
      itemNumber: `PN-E2E-LEAF-${ts}`,
      name: `E2E Leaf ${ts}`,
    })
    await seedBomEdge(page, top.id, mid.id, '2')
    await seedBomEdge(page, mid.id, leaf.id, '3')

    await page.goto(`/parts/${top.id}?tab=relationships`)
    await page.getByRole('tab', { name: 'BOM Structure' }).click()

    // The direct child is there without expanding anything.
    const main = page.locator('main')
    await expect(main).toContainText(mid.itemNumber, { timeout: 15000 })

    // Expanding the child reveals the grandchild — a tree that stops at one
    // level looks identical to a correct one until you open a row.
    await page
      .locator('[data-testid="bom-tree"], main')
      .locator('div,tr')
      .filter({ hasText: mid.itemNumber })
      .last()
      .getByRole('button')
      .first()
      .click()
    await expect(main).toContainText(leaf.itemNumber, { timeout: 15000 })

    // Quantities survive. A BOM whose quantities all read 1 is worse than no
    // BOM, and the rendered page would not notice — the tree is assembled
    // client-side from the relationship API, so that is where the number has
    // to be right.
    const relationshipsResponse = await page.request.get(
      `/api/v1/items/${top.id}/relationships`,
    )
    expect(relationshipsResponse.ok()).toBe(true)
    const { relationships } = (await relationshipsResponse.json()).data as {
      relationships: Array<{
        relationshipType: string
        quantity: string | null
        targetItem: { itemNumber: string }
      }>
    }
    const edge = relationships.find(
      (r) =>
        r.relationshipType === 'BOM' &&
        r.targetItem.itemNumber === mid.itemNumber,
    )
    expect(edge, 'the seeded BOM edge is missing').toBeTruthy()
    expect(Number(edge!.quantity)).toBe(2)
  })
})
