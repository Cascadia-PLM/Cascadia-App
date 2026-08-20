// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ReportService.update — partial-update semantics
 *
 * A report's columns, filters and sorts live in child tables and are replaced
 * wholesale. What matters is *which* of them a given request is asking to
 * replace: the route validates with `reportSchema.partial()`, so a body may
 * carry nothing but a name, and reading "absent" as "replace with nothing"
 * quietly destroys the report.
 *
 * Data-integrity gate — a half-applied update leaves a report in a state its
 * own schema forbids (`columns` is `min(1)`), which then executes and returns
 * rows with no columns at all.
 *
 * Run: npx vitest run packages/core/src/lib/reports/ReportService.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { ReportService } from './ReportService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'

describe('ReportService.update', () => {
  const testDb = new TestDatabase()

  let userId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    userId = (await insertTestUser(testDb.db)).id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** Two columns, one filter, one sort — enough that losing any is visible. */
  const baseline = async () => {
    const report = await ReportService.create(
      {
        name: 'Baseline',
        itemType: 'Part',
        isPublic: false,
        columns: [
          {
            fieldPath: 'itemNumber',
            label: 'Number',
            displayOrder: 0,
            isVisible: true,
          },
          {
            fieldPath: 'name',
            label: 'Name',
            displayOrder: 1,
            isVisible: true,
          },
        ],
        filters: [
          {
            fieldPath: 'state',
            operator: 'eq',
            value: 'Draft',
            displayOrder: 0,
          },
        ],
        sorts: [{ fieldPath: 'itemNumber', direction: 'asc', priority: 0 }],
      },
      userId,
    )
    return report.id!
  }

  const readBack = async (reportId: string) => {
    const report = await ReportService.findById(reportId)
    if (!report) throw new Error('report vanished')
    return {
      name: report.name,
      columns: report.columns ?? [],
      filters: report.filters ?? [],
      sorts: report.sorts ?? [],
    }
  }

  it('leaves every child collection alone when none was supplied', async () => {
    const reportId = await baseline()

    await ReportService.update(reportId, { name: 'Renamed' }, userId)

    const after = await readBack(reportId)
    expect(after.name).toBe('Renamed')
    expect(after.columns).toHaveLength(2)
    expect(after.filters).toHaveLength(1)
    expect(after.sorts).toHaveLength(1)
  })

  it('clears a collection that was supplied empty', async () => {
    const reportId = await baseline()

    // `[]` is a request, not an omission: it means "this report now has no
    // filters", and has to be told apart from never mentioning filters.
    await ReportService.update(reportId, { filters: [] }, userId)

    const after = await readBack(reportId)
    expect(after.filters).toHaveLength(0)
    expect(after.columns).toHaveLength(2)
    expect(after.sorts).toHaveLength(1)
  })

  it('replaces a supplied collection wholesale, and only that one', async () => {
    const reportId = await baseline()

    await ReportService.update(
      reportId,
      {
        columns: [
          {
            fieldPath: 'state',
            label: 'State',
            displayOrder: 0,
            isVisible: true,
          },
        ],
      },
      userId,
    )

    const after = await readBack(reportId)
    expect(after.columns.map((c) => c.fieldPath)).toEqual(['state'])
    expect(after.filters).toHaveLength(1)
    expect(after.sorts).toHaveLength(1)
  })

  it('survives a rename with its query intact', async () => {
    // The end the other cases are protecting: a renamed report is still a
    // runnable report. `columns` is `min(1)` in the schema, so a report that
    // lost them is one the API could never have accepted.
    const reportId = await baseline()

    await ReportService.update(reportId, { name: 'Still Works' }, userId)
    await ReportService.update(reportId, { description: 'and again' }, userId)

    const after = await readBack(reportId)
    expect(after.columns.length).toBeGreaterThan(0)
  })
})
