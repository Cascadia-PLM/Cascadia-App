// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Requirement Lifecycle E2E Journey
 *
 * One journey, end to end, in the eco-workflow.spec.ts style: create a
 * requirement through the UI, drive its lifecycle through whatever transition
 * the seeded default lifecycle offers, and assert the move in both places it
 * is visible — the badge and the API row.
 *
 * No state name appears here, deliberately. Lifecycle states are
 * configuration: the transition's own `name` and `toStateName` come from the
 * API, so this spec asserts that the lifecycle is wired up without asserting
 * what anyone called its states. Nor does it look for a `status` field —
 * requirements have none; it was absorbed into lifecycle flags.
 *
 * What it replaces: eighteen tests wrapped in `if (await …isVisible())`, most
 * of which opened `/requirements` and used whatever row happened to be first.
 */

import { expect, test } from '../fixtures'
import { seedFreshDesign } from '../seed'
import { seedPart, seedRequirement } from '../helpers/test-data'

test.describe('Requirement Lifecycle Journey', () => {
  test('create a requirement → transition it → its state moves everywhere it is shown', async ({
    authenticatedPage: page,
  }) => {
    const ts = Date.now()
    const design = await seedFreshDesign(page, 'E2E Requirement Journey')
    const itemNumber = `REQ-E2E-${ts}`
    const name = `E2E Requirement ${ts}`

    // ---- Create through the UI ----
    // The create page renders the detail view in create mode, so the fields
    // are ViewEdit ones — reachable by their labels, which is what FE-11 gave
    // them.
    await page.goto('/requirements/new')
    await page.getByRole('combobox', { name: 'Design' }).click()
    await page
      .getByRole('option')
      .filter({ hasText: design.name })
      .first()
      .click()
    await page.getByRole('textbox', { name: 'Item Number' }).fill(itemNumber)
    await page.getByRole('textbox', { name: 'Name' }).fill(name)

    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/v1/items') && r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      page.getByRole('button', { name: 'Create Requirement' }).click(),
    ])
    expect(
      createResponse.ok(),
      `requirement create failed: ${await createResponse.text()}`,
    ).toBe(true)
    const created = (await createResponse.json()).data.item as {
      id: string
      state: string
    }

    await page.waitForURL(/\/requirements\/[a-f0-9-]+/, { timeout: 15000 })

    // ---- The detail page shows it, in its lifecycle's initial state ----
    const main = page.locator('main')
    await expect(main).toContainText(itemNumber, { timeout: 15000 })

    // ---- Drive one transition through whatever the lifecycle offers ----
    const transitionsResponse = await page.request.get(
      `/api/v1/items/${created.id}/transitions`,
    )
    expect(transitionsResponse.ok()).toBe(true)
    const { transitions } = (await transitionsResponse.json()).data as {
      transitions: Array<{ name: string; toStateName: string }>
    }
    expect(
      transitions.length,
      'the seeded Requirement lifecycle offers no transition from its initial state',
    ).toBeGreaterThan(0)
    const move = transitions[0]!

    await page.getByRole('button', { name: move.name, exact: true }).click()

    // The badge moves, and so does the row the API returns — either one
    // agreeing on its own proves nothing.
    await expect(main).toContainText(move.toStateName, { timeout: 15000 })
    const afterResponse = await page.request.get(
      `/api/v1/requirements/${created.id}`,
    )
    expect(afterResponse.ok()).toBe(true)
    const after = (await afterResponse.json()).data.requirement as {
      state: string
    }
    expect(after.state).not.toBe(created.state)
  })

  test('linking a part to a requirement is readable from both ends', async ({
    authenticatedPage: page,
  }) => {
    const ts = Date.now()
    const designId = (await seedFreshDesign(page, 'E2E Requirement Link')).id
    const requirement = await seedRequirement(page, designId, {
      itemNumber: `REQ-E2E-LINK-${ts}`,
      name: `E2E Linked Requirement ${ts}`,
    })
    const part = await seedPart(page, designId, {
      itemNumber: `PN-E2E-SAT-${ts}`,
      name: `E2E Satisfying Part ${ts}`,
    })

    // Linked over the API: the edge *direction* is what is under test, and
    // driving the picker would test the picker instead.
    const linkResponse = await page.request.post(
      `/api/v1/requirements/${requirement.id}/satisfy`,
      { data: { itemIds: [part.id] } },
    )
    expect(
      linkResponse.ok(),
      `satisfy link failed: ${await linkResponse.text()}`,
    ).toBe(true)

    // The part's Relationships tab names the requirement. The edge belongs to
    // the part — SATISFIES points part → requirement — so this is the side
    // that renders it; the requirement's own page shows verification rather
    // than satisfaction, which is worth knowing and is why this assertion is
    // here rather than there.
    await page.goto(`/parts/${part.id}?tab=relationships`)
    await page.getByRole('tab', { name: 'Table View' }).click()
    await expect(page.locator('main')).toContainText(requirement.itemNumber, {
      timeout: 15000,
    })

    // …and the part's own satisfied-requirements read names the requirement.
    // Both directions matter: the edge belongs to one row and is read from the
    // other, which is exactly where a direction mistake hides.
    const satisfiedResponse = await page.request.get(
      `/api/v1/items/${part.id}/satisfied-requirements`,
    )
    expect(satisfiedResponse.ok()).toBe(true)
    expect(await satisfiedResponse.text()).toContain(requirement.itemNumber)
  })
})
