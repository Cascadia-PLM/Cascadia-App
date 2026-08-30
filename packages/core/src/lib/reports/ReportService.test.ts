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
import type { FilterOperator } from './types'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { items } from '@/lib/db/schema'

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

/**
 * ReportService filter operators — literal values, not patterns
 *
 * `like`, `not_like`, `starts_with` and `ends_with` are match MODES the report
 * builder offers in a dropdown beside a value the user types. `starts_with`
 * and `ends_with` exist as separate operators precisely because the value is
 * not a pattern language: a `%` or `_` in it means itself. Unescaped, a saved
 * report filtering on `50%` matched every row on that column, and a part
 * number containing `_` matched anything in that position.
 *
 * Complex-algorithm gate: four operators build four different patterns, and
 * reading the code does not tell you what a `_` in the value does.
 *
 * Run: npx vitest run packages/core/src/lib/reports/ReportService.test.ts
 */
describe('ReportService.execute — text filter operators', () => {
  const testDb = new TestDatabase()

  let userId: string
  let reportId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  /**
   * Design-less parts: `accessScopeCondition` admits those to every caller, so
   * the rows here are bounded by the filter under test and nothing else.
   */
  async function insertPart(name: string) {
    await testDb.db.insert(items).values({
      masterId: crypto.randomUUID(),
      itemNumber: `RPT-${crypto.randomUUID().slice(0, 8)}`,
      revision: 'A',
      itemType: 'Part',
      state: 'Draft',
      name,
      designId: null,
      createdBy: userId,
      modifiedBy: userId,
    })
  }

  async function namesMatching(
    operator: FilterOperator,
    value?: string,
  ): Promise<Array<string>> {
    const result = await ReportService.execute(
      reportId,
      { runtimeFilters: [{ fieldPath: 'name', operator, value }] },
      userId,
    )
    return result.rows.map((r) => r.name as string).sort()
  }

  beforeEach(async () => {
    await testDb.beginTransaction()
    userId = (await insertTestUser(testDb.db)).id

    const report = await ReportService.create(
      {
        name: 'Names',
        itemType: 'Part',
        isPublic: false,
        columns: [
          {
            fieldPath: 'name',
            label: 'Name',
            displayOrder: 0,
            isVisible: true,
          },
        ],
        filters: [],
        sorts: [],
      },
      userId,
    )
    reportId = report.id!

    await insertPart('Discount 50% off')
    await insertPart('Discount 500 units')
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('matches a percent in the value literally', async () => {
    expect(await namesMatching('like', '50%')).toEqual(['Discount 50% off'])
  })

  it('makes not_like the exact complement of like', async () => {
    const matched = await namesMatching('like', '50%')
    const rejected = await namesMatching('not_like', '50%')

    expect(rejected).toEqual(['Discount 500 units'])
    expect(matched.concat(rejected).sort()).toEqual([
      'Discount 50% off',
      'Discount 500 units',
    ])
  })

  it('matches an underscore in a starts_with value literally', async () => {
    await insertPart('A_1 bracket')
    await insertPart('AB1 bracket')

    expect(await namesMatching('starts_with', 'A_')).toEqual(['A_1 bracket'])
  })

  it('matches an underscore in an ends_with value literally', async () => {
    await insertPart('bracket X_9')
    await insertPart('bracket XZ9')

    expect(await namesMatching('ends_with', '_9')).toEqual(['bracket X_9'])
  })

  // An unset value used to build the pattern '%undefined%', which is a filter
  // on the literal text "undefined" — neither "match everything" nor
  // "match nothing", and silently wrong either way.
  it.each(['like', 'not_like', 'starts_with', 'ends_with'] as const)(
    'ignores a %s filter whose value is unset',
    async (operator) => {
      expect(await namesMatching(operator, undefined)).toEqual([
        'Discount 50% off',
        'Discount 500 units',
      ])
    },
  )
})
