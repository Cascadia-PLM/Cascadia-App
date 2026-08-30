// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Physical Traceability E2E Workflow Test
 *
 * The proposal's deferred acceptance test
 * (docs/features/physical-parts-and-traceability.md §6 Phase 5 / §8):
 * create a work order → consume a serial and a lot at the bench → record
 * produced serials → verify the derived genealogy page, the qualification
 * rollup (the uncertified lot is flagged), and the digital thread's
 * physical swim lane on the built part.
 *
 * Prerequisite parts are seeded through the API (the part form's tracking
 * select has no stable test id); everything under test — WO creation,
 * consumption, production, genealogy, qualification, thread — runs through
 * the UI.
 */

import { expect, test } from '../fixtures'
import { PhysicalPartsPage, WorkOrdersPage } from '../pages'
import { seedFreshDesign } from '../seed'
import { seedPart } from '../helpers/test-data'

test.describe('Physical Traceability Workflow', () => {
  test('WO → consume serial + lot → produce serials → genealogy, qualification, thread lane', async ({
    authenticatedPage: page,
  }) => {
    const workOrders = new WorkOrdersPage(page)
    const physicalParts = new PhysicalPartsPage(page)

    // ---- Seed: a fresh design and three parts (built, component, feedstock) ----
    const designId: string = (await seedFreshDesign(page, 'E2E Traceability'))
      .id

    const ts = Date.now()
    const builtPart = await seedPart(page, designId, {
      itemNumber: `PN-E2E-WIDGET-${ts}`,
      name: 'E2E Widget',
      trackingMode: 'serial',
    })
    const componentPart = await seedPart(page, designId, {
      itemNumber: `PN-E2E-COMP-${ts}`,
      name: 'E2E Component',
      trackingMode: 'serial',
    })
    const feedstockPart = await seedPart(page, designId, {
      itemNumber: `PN-E2E-FEED-${ts}`,
      name: 'E2E Feedstock',
      trackingMode: 'lot',
    })

    const componentSerial = `CS1-${ts}`
    const lotNumber = `LOT-${ts}`
    const builtSerials = [`W1-${ts}`, `W2-${ts}`]

    // ---- Create the work order for the built part (UI) ----
    const workOrderId = await workOrders.createForPart(builtPart.itemNumber)
    expect(workOrderId).not.toBe('')
    const workOrderNumber = await workOrders.workOrderNumber()

    // ---- Consume a serial and a lot at the bench (UI) ----
    await workOrders.openTab('Materials')

    await workOrders.selectMaterialPart(componentPart.itemNumber)
    await workOrders.consumeSerial(componentSerial)

    await workOrders.changeMaterialPart()
    await workOrders.selectMaterialPart(feedstockPart.itemNumber)
    await workOrders.consumeLot(lotNumber, 2)

    // ---- Record produced serials (UI) ----
    await workOrders.produceSerials(builtSerials)

    // ---- Genealogy: the produced unit's composition reaches both ----
    await workOrders.openProducedUnit(builtSerials[0]!)
    await expect(physicalParts.compositionSection).toBeVisible()
    await physicalParts.expectCompositionSerial(componentSerial)
    await physicalParts.expectCompositionLot(lotNumber)

    // ---- Qualification rollup flags the uncertified lot ----
    await workOrders.goto(workOrderId)
    await workOrders.openTab('Qualification')
    await workOrders.expectUncertifiedLot(lotNumber)

    // ---- Digital thread: the built part shows the physical lane ----
    await page.goto(`/parts/${builtPart.id}`)
    await page.getByRole('tab', { name: 'Relationships' }).click()
    await page.locator('button:has-text("Digital Thread")').click()

    // Legend entry for the new lane
    await expect(page.locator('text=Physical (As-Built)')).toBeVisible({
      timeout: 15000,
    })
    // The graph renders physical nodes: the WO and a produced unit
    const graph = page.locator('.react-flow')
    await expect(graph.getByText(workOrderNumber).first()).toBeVisible({
      timeout: 15000,
    })
    await expect(
      graph.getByText(`SN ${builtSerials[0]}`, { exact: false }).first(),
    ).toBeVisible()
  })
})
