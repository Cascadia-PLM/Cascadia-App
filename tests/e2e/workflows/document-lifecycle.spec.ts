// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Document Lifecycle E2E Journey
 *
 * One journey, end to end, in the eco-workflow/bom-management style: create a
 * document through the UI, find it through the same list query the documents
 * grid runs, and delete it through the UI — reading the server back after each
 * mutation rather than trusting the page that performed it.
 *
 * What it replaces: four tests, two of which were pure navigation smoke —
 * "clicking New lands on /documents/new", "the create form renders its
 * fields" — with no invariant behind either, and a list test that typed into
 * the grid's search box and slept 500ms hoping the filter had run.
 *
 * The UI *edit* leg is deliberately absent, and it is the one step of the
 * lifecycle this journey cannot assert today. The document detail page PUTs
 * the whole row back, and `documentUpdateSchema` refuses `null` on `fileId`
 * and `fileName` — which is exactly what a read returns for a document with
 * no file attached. `partUpdateSchema` was made nullable for this precise
 * reason when body validation landed; the document schema was not. Until it
 * is, a save from that page is a 400, and a step here would assert a known
 * break rather than guard against a new one.
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

/** The document as the server holds it, after a UI step claimed to write it. */
async function readDocument(
  page: Page,
  id: string,
): Promise<{ itemNumber: string; name: string; state: string }> {
  const response = await page.request.get(`/api/v1/documents/${id}`)
  expect(response.ok(), `document read failed: ${await response.text()}`).toBe(
    true,
  )
  return (await response.json()).data.document as {
    itemNumber: string
    name: string
    state: string
  }
}

test.describe('Document Lifecycle Journey', () => {
  // Only set while the journey still owns a row: the UI delete below clears
  // it. Cleanup goes through the API — see the note in part-lifecycle.spec.ts
  // on why a visibility-guarded Delete click was no cleanup at all.
  let createdDocumentId: string | null = null

  test.afterEach(async ({ authenticatedPage: page }) => {
    if (createdDocumentId) {
      try {
        await page.request.delete(`/api/v1/documents/${createdDocumentId}`)
      } catch {
        // Ignore cleanup errors
      }
      createdDocumentId = null
    }
  })

  test('create a document through the UI → it is in the list query → delete it through the UI', async ({
    authenticatedPage: page,
  }) => {
    const ts = Date.now()
    const design = await seedFreshDesign(page, 'E2E Doc Journey')
    const itemNumber = `DOC-E2E-LIFECYCLE-${ts}`
    const docName = `E2E Lifecycle Document ${ts}`

    // ---- Create through the UI ----
    await page.goto('/documents/new')
    await selectDesignByName(page, design.name)
    await fillField(page, '[data-testid="document-item-number"]', itemNumber)
    await fillField(page, '[data-testid="document-name"]', docName)

    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/v1/items') && r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      page.click('[data-testid="document-submit"]'),
    ])
    expect(
      createResponse.ok(),
      `document create failed: ${await createResponse.text()}`,
    ).toBe(true)
    const created = (await createResponse.json()).data.item as {
      id: string
      state: string
    }
    createdDocumentId = created.id

    await page.waitForURL(/\/documents\/[a-f0-9-]+(\?.*)?$/, { timeout: 15000 })
    await expect(page.locator('main')).toContainText(itemNumber, {
      timeout: 15000,
    })

    // ---- …and the row the server holds is the one the form described ----
    const detail = await readDocument(page, created.id)
    expect(detail.itemNumber).toBe(itemNumber)
    expect(detail.name).toBe(docName)
    // No state name is spelled out here — lifecycle states are configuration.
    // What has to hold is that the read returns the state the create reported.
    expect(detail.state).toBe(created.state)

    // ---- Reachable through the query the list page runs ----
    // `globalSearch` is the parameter `/documents`'s grid sends for its search
    // box, so asking the API the same question is the honest form of what the
    // old test approximated by typing and sleeping 500ms.
    const listResponse = await page.request.get(
      `/api/v1/items?itemType=Document&globalSearch=${encodeURIComponent(itemNumber)}&limit=50`,
    )
    expect(listResponse.ok()).toBe(true)
    const { items } = (await listResponse.json()).data as {
      items: Array<{ id: string; itemNumber: string; name: string }>
    }
    const listed = items.find((i) => i.itemNumber === itemNumber)
    expect(
      listed,
      'the created document is missing from the list query the grid runs',
    ).toBeTruthy()
    expect(listed!.name).toBe(docName)

    // ---- Delete through the UI ----
    // The header's Delete is unambiguous while the document has no files: the
    // per-file delete buttons in the Files card are titled 'Delete' too, and
    // none of them exists until a file does.
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const confirmDialog = page.getByRole('alertdialog')
    await expect(confirmDialog).toBeVisible({ timeout: 10000 })
    const [deleteResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/v1/documents/') &&
          r.request().method() === 'DELETE',
        { timeout: 15000 },
      ),
      confirmDialog
        .getByRole('button', { name: 'Delete', exact: true })
        .click(),
    ])
    expect(
      deleteResponse.ok(),
      `document delete failed: ${await deleteResponse.text()}`,
    ).toBe(true)
    await page.waitForURL(/\/documents(\?.*)?$/, { timeout: 15000 })

    // ---- …and the row is gone from the server, not merely off the page ----
    const gone = await page.request.get(`/api/v1/documents/${created.id}`)
    expect(gone.status()).toBe(404)
    // Deleted here, so afterEach has nothing left to clean up.
    createdDocumentId = null
  })
})
