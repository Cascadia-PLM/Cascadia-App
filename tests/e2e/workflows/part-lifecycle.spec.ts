// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Part Lifecycle E2E Journey
 *
 * One journey, end to end, in the eco-workflow/bom-management style: create a
 * part through the UI, edit it through the UI, and read the server back after
 * each mutation. A page agreeing with itself proves nothing, so every UI step
 * here is checked against `/api/v1/parts/:id`, and the last one against the
 * same list query the parts grid runs.
 *
 * What it replaces: three tests whose assertions were URL- and
 * visibility-shaped — "the URL looks like a detail page", "the item number is
 * somewhere on screen" — each of which paid for its own design and its own
 * part to assert one of them. The list test typed the item number into the
 * grid's search box and slept 500ms; the containment question it was really
 * asking is a list query, and is asked as one now.
 */

import { expect, test } from '../fixtures'
import { seedFreshDesign, selectDesignByName } from '../seed'
import type { Page } from '@playwright/test'

/**
 * Helper to fill a form field
 * Uses fill() which is more reliable for React controlled inputs
 */
async function fillField(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  const field = page.locator(selector)
  await field.waitFor({ state: 'visible' })
  await field.fill(value)
}

/** The part as the server holds it, after a UI step claimed to have written it. */
async function readPart(
  page: Page,
  id: string,
): Promise<{ itemNumber: string; name: string; state: string }> {
  const response = await page.request.get(`/api/v1/parts/${id}`)
  expect(response.ok(), `part read failed: ${await response.text()}`).toBe(true)
  return (await response.json()).data.part as {
    itemNumber: string
    name: string
    state: string
  }
}

test.describe('Part Lifecycle Journey', () => {
  // The part this run created. Deleted through the API, not the UI: the old
  // version clicked a Delete button only if it happened to be visible, so
  // cleanup silently did nothing whenever the page was in a state without one.
  let createdPartId: string | null = null

  test.afterEach(async ({ authenticatedPage: page }) => {
    if (createdPartId) {
      try {
        await page.request.delete(`/api/v1/parts/${createdPartId}`)
      } catch {
        // Ignore cleanup errors
      }
      createdPartId = null
    }
  })

  test('create a part through the UI → edit it → the server agrees at every step', async ({
    authenticatedPage: page,
  }) => {
    const ts = Date.now()
    const design = await seedFreshDesign(page, 'E2E Part Journey')
    const itemNumber = `PN-E2E-LIFECYCLE-${ts}`
    const partName = `E2E Lifecycle Part ${ts}`
    const revisedName = `E2E Lifecycle Part ${ts} edited`

    // ---- Create through the UI ----
    await page.goto('/parts/new')
    await selectDesignByName(page, design.name)
    await fillField(page, '[data-testid="part-item-number"]', itemNumber)
    await fillField(page, '[data-testid="part-name"]', partName)

    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/v1/items') && r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      page.click('[data-testid="part-submit"]'),
    ])
    expect(
      createResponse.ok(),
      `part create failed: ${await createResponse.text()}`,
    ).toBe(true)
    const created = (await createResponse.json()).data.item as {
      id: string
      state: string
    }
    createdPartId = created.id

    await page.waitForURL(/\/parts\/[a-f0-9-]+(\?.*)?$/, { timeout: 15000 })
    await expect(page.locator('main')).toContainText(itemNumber, {
      timeout: 15000,
    })

    // ---- …and the row the server holds is the one the form described ----
    const detail = await readPart(page, created.id)
    expect(detail.itemNumber).toBe(itemNumber)
    expect(detail.name).toBe(partName)
    // No state name is spelled out here — lifecycle states are configuration.
    // What has to hold is that the read returns the state the create reported.
    expect(detail.state).toBe(created.state)

    // ---- Edit through the UI ----
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    // In edit mode the testid rides the input itself; in view mode it rides
    // the value container.
    const nameInput = page.locator('input[data-testid="part-name"]')
    await expect(nameInput).toHaveValue(partName, { timeout: 10000 })

    // focus → clear → pressSequentially, kept verbatim from the spec this
    // replaces. It is the workaround this controlled input has needed, and
    // re-fighting it is not what promoting the assertions is for.
    await nameInput.focus()
    await page.waitForTimeout(100)
    await nameInput.clear()
    await nameInput.pressSequentially(revisedName, { delay: 30 })

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
      `part save failed (${saveResponse.url()}): ${await saveResponse.text()}`,
    ).toBe(true)
    await expect(page.locator('main')).toContainText(revisedName, {
      timeout: 10000,
    })

    // ---- …and so does the server ----
    const edited = await readPart(page, created.id)
    expect(edited.name).toBe(revisedName)
    // An edit renames. It must not renumber the part or move its lifecycle
    // state, and neither would be visible on the page that just saved it.
    expect(edited.itemNumber).toBe(itemNumber)
    expect(edited.state).toBe(created.state)

    // ---- The part is reachable through the query the list page runs ----
    // `globalSearch` is the parameter `/parts`'s grid sends for its search
    // box, so asking the API the same question is the honest form of what the
    // old test approximated by typing and sleeping 500ms.
    const listResponse = await page.request.get(
      `/api/v1/items?itemType=Part&globalSearch=${encodeURIComponent(itemNumber)}&limit=50`,
    )
    expect(listResponse.ok()).toBe(true)
    const { items } = (await listResponse.json()).data as {
      items: Array<{ id: string; itemNumber: string; name: string }>
    }
    const listed = items.find((i) => i.itemNumber === itemNumber)
    expect(
      listed,
      'the created part is missing from the list query the grid runs',
    ).toBeTruthy()
    // And the list serves the edited row, not a stale copy of the created one.
    expect(listed!.name).toBe(revisedName)
  })
})
