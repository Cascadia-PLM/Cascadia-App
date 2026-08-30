// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ItemSearchService.searchGlobal Tests
 *
 * The cross-type search behind the enterprise search results page is an
 * access-control boundary: results must stay confined to the design scope
 * the caller resolved for the user, and to the item types the caller
 * allowed. These tests assert those invariants against a real database.
 *
 * Run: npm run test -- src/lib/items/services/ItemSearchService.test.ts
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
import { ItemSearchService } from './ItemSearchService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { designs, items, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('ItemSearchService.searchGlobal', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programAId: string
  let programBId: string
  let designAId: string
  let designBId: string

  async function insertItem(overrides: {
    itemNumber: string
    designId: string | null
    itemType?: string
    name?: string
    state?: string
    isCurrent?: boolean
    usageOf?: string
  }) {
    return takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: crypto.randomUUID(),
          revision: 'A',
          itemType: overrides.itemType ?? 'Part',
          state: overrides.state ?? 'Draft',
          createdBy: user.id,
          modifiedBy: user.id,
          ...overrides,
        })
        .returning(),
    )
  }

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    user = await insertTestUser(testDb.db)

    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const programA = takeFirst(
      await testDb.db
        .insert(programs)
        .values({ name: 'Program A', code: `PA-${uniq}`, createdBy: user.id })
        .returning(),
    )
    const programB = takeFirst(
      await testDb.db
        .insert(programs)
        .values({ name: 'Program B', code: `PB-${uniq}`, createdBy: user.id })
        .returning(),
    )
    programAId = programA.id
    programBId = programB.id

    const designA = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId: programAId,
          name: 'Design A',
          code: `DA-${uniq}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const designB = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId: programBId,
          name: 'Design B',
          code: `DB-${uniq}`,
          createdBy: user.id,
        })
        .returning(),
    )
    designAId = designA.id
    designBId = designB.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('confines results to the design scope', async () => {
    await insertItem({ itemNumber: 'SCOPE-001', designId: designAId })
    await insertItem({ itemNumber: 'SCOPE-002', designId: designBId })

    const result = await ItemSearchService.searchGlobal({
      query: 'SCOPE',
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId], programIds: [] },
    })

    expect(result.items.map((i) => i.itemNumber)).toEqual(['SCOPE-001'])
    expect(result.total).toBe(1)
  })

  it('reaches no design when the access scope is empty', async () => {
    await insertItem({ itemNumber: 'SCOPE-001', designId: designAId })

    const result = await ItemSearchService.searchGlobal({
      query: 'SCOPE',
      itemTypes: ['Part'],
      accessScope: { designIds: [], programIds: [] },
    })

    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })

  // `null` is the cross-program-authority scope. It has to be distinguishable
  // from `[]`, or an admin and a user who reaches nothing would get the same
  // answer — and only one of those answers can be "everything".
  it('searches every design when the access scope is null', async () => {
    await insertItem({ itemNumber: 'SCOPE-001', designId: designAId })
    await insertItem({ itemNumber: 'SCOPE-002', designId: designBId })

    const result = await ItemSearchService.searchGlobal({
      query: 'SCOPE',
      itemTypes: ['Part'],
      accessScope: null,
    })

    expect(result.items.map((i) => i.itemNumber).sort()).toEqual([
      'SCOPE-001',
      'SCOPE-002',
    ])
  })

  // An item in no design sits outside every program, so no membership can
  // gate it and scoping must not swallow it.
  it('keeps design-less items in scope however narrow the scope', async () => {
    await insertItem({ itemNumber: 'SCOPE-ORPHAN', designId: null })

    for (const designIds of [[], [designAId]]) {
      const result = await ItemSearchService.searchGlobal({
        query: 'SCOPE-ORPHAN',
        itemTypes: ['Part'],
        accessScope: { designIds, programIds: [] },
      })
      expect(result.items.map((i) => i.itemNumber)).toEqual(['SCOPE-ORPHAN'])
    }
  })

  it('matches nothing when no item types are allowed', async () => {
    await insertItem({ itemNumber: 'SCOPE-001', designId: designAId })

    const result = await ItemSearchService.searchGlobal({
      query: 'SCOPE',
      itemTypes: [],
      accessScope: { designIds: [designAId, designBId], programIds: [] },
    })

    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })

  it('restricts to the requested item types', async () => {
    await insertItem({ itemNumber: 'TYPE-001', designId: designAId })
    await insertItem({
      itemNumber: 'TYPE-002',
      designId: designAId,
      itemType: 'Document',
    })

    const result = await ItemSearchService.searchGlobal({
      query: 'TYPE',
      itemTypes: ['Document'],
      accessScope: { designIds: [designAId], programIds: [] },
    })

    expect(result.items.map((i) => i.itemNumber)).toEqual(['TYPE-002'])
  })

  it('filters by the owning program through the design join', async () => {
    await insertItem({ itemNumber: 'PROG-001', designId: designAId })
    await insertItem({ itemNumber: 'PROG-002', designId: designBId })

    const result = await ItemSearchService.searchGlobal({
      query: 'PROG',
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId, designBId], programIds: [] },
      columnFilters: { program: programBId },
    })

    expect(result.items.map((i) => i.itemNumber)).toEqual(['PROG-002'])
    expect(result.items[0]?.programId).toBe(programBId)
    expect(result.items[0]?.programName).toBe('Program B')
  })

  it('matches the term against both item number and name', async () => {
    await insertItem({
      itemNumber: 'NUM-MATCH-001',
      designId: designAId,
    })
    await insertItem({
      itemNumber: 'OTHER-001',
      name: 'Housing NUM-MATCH bracket',
      designId: designAId,
    })
    await insertItem({
      itemNumber: 'OTHER-002',
      name: 'Unrelated',
      designId: designAId,
    })

    const result = await ItemSearchService.searchGlobal({
      query: 'NUM-MATCH',
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId], programIds: [] },
    })

    expect(result.items.map((i) => i.itemNumber).sort()).toEqual([
      'NUM-MATCH-001',
      'OTHER-001',
    ])
  })

  it('reports the full match count while paging', async () => {
    await insertItem({ itemNumber: 'PAGE-001', designId: designAId })
    await insertItem({ itemNumber: 'PAGE-002', designId: designAId })
    await insertItem({ itemNumber: 'PAGE-003', designId: designAId })

    const result = await ItemSearchService.searchGlobal({
      query: 'PAGE',
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId], programIds: [] },
      limit: 2,
      offset: 0,
    })

    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(3)
  })

  it('excludes non-current revisions and usages', async () => {
    await insertItem({ itemNumber: 'CUR-001', designId: designAId })
    await insertItem({
      itemNumber: 'CUR-002',
      designId: designAId,
      isCurrent: false,
    })
    const definition = await insertItem({
      itemNumber: 'CUR-003',
      designId: designAId,
    })
    await insertItem({
      itemNumber: 'CUR-004',
      designId: designAId,
      usageOf: definition.id,
    })

    const result = await ItemSearchService.searchGlobal({
      query: 'CUR',
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId], programIds: [] },
    })

    expect(result.items.map((i) => i.itemNumber).sort()).toEqual([
      'CUR-001',
      'CUR-003',
    ])
  })

  it('matches nothing when sanitising strips the whole term', async () => {
    await insertItem({ itemNumber: 'SAN-001', designId: designAId })

    const result = await ItemSearchService.searchGlobal({
      query: '!!!',
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId], programIds: [] },
    })

    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })

  // A search box is a contains-box, not a pattern language. `%` and `_` are
  // ILIKE wildcards, so an unescaped term makes `A_1` match `AB1` in SQL and
  // not in the in-memory `String.includes` path — the same query answering
  // two different things depending on which path served it.
  it('treats a wildcard character in the term as a literal', async () => {
    await insertItem({ itemNumber: 'A_1', designId: designAId })
    await insertItem({ itemNumber: 'AB1', designId: designAId })

    // Two characters, so this takes the ILIKE fallback rather than tsquery.
    const result = await ItemSearchService.searchGlobal({
      query: 'A_',
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId], programIds: [] },
    })

    expect(result.items.map((i) => i.itemNumber)).toEqual(['A_1'])
  })

  it('treats a wildcard character in a column filter as a literal', async () => {
    await insertItem({ itemNumber: '10_1', designId: designAId })
    await insertItem({ itemNumber: '1051', designId: designAId })

    const result = await ItemSearchService.searchGlobal({
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId], programIds: [] },
      columnFilters: { itemNumber: '10_1' },
    })

    expect(result.items.map((i) => i.itemNumber)).toEqual(['10_1'])
  })

  it('does not let a bare percent term match every row', async () => {
    await insertItem({ itemNumber: 'PCT-001', designId: designAId })
    await insertItem({ itemNumber: 'PCT-002', designId: designAId })

    const result = await ItemSearchService.searchGlobal({
      query: '%',
      itemTypes: ['Part'],
      accessScope: { designIds: [designAId], programIds: [] },
    })

    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })
})

/**
 * `search` is the per-type grid query. Its global-search term takes one of two
 * paths — a Postgres `to_tsquery` for three characters or more, an ILIKE
 * fallback below that — and both consume user text in a language with its own
 * syntax. A term that is punctuation is ordinary input, not an error.
 */
describe('ItemSearchService.search — user text in a query language', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

  async function insertPart(itemNumber: string) {
    return takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: crypto.randomUUID(),
          revision: 'A',
          itemType: 'Part',
          state: 'Draft',
          createdBy: user.id,
          modifiedBy: user.id,
          itemNumber,
          designId,
        })
        .returning(),
    )
  }

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)

    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({ name: 'Program', code: `PS-${uniq}`, createdBy: user.id })
        .returning(),
    )
    designId = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId: program.id,
          name: 'Design',
          code: `DS-${uniq}`,
          createdBy: user.id,
        })
        .returning(),
    ).id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // `foo)` is unbalanced tsquery syntax. Unsanitised it reached Postgres and
  // raised a syntax error, so an ordinary typed character answered 500.
  it('answers a tsquery-invalid term with no rows rather than an error', async () => {
    await insertPart('TSQ-001')

    const result = await ItemSearchService.search('Part', {
      designId,
      globalSearch: 'foo)',
    })

    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })

  it('matches nothing when sanitising strips the whole term', async () => {
    await insertPart('TSQ-001')

    const result = await ItemSearchService.search('Part', {
      designId,
      globalSearch: '!!!!',
    })

    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })

  it('treats a wildcard character in the ILIKE fallback as a literal', async () => {
    await insertPart('A_1')
    await insertPart('AB1')

    const result = await ItemSearchService.search('Part', {
      designId,
      globalSearch: 'A_',
    })

    expect(
      result.items.map((i: { itemNumber: string }) => i.itemNumber),
    ).toEqual(['A_1'])
  })
})

/**
 * `findIdsByItemNumbers` exists because bulk import wires up BOM structure by
 * item number, and the previous implementation paged a search to build that
 * map. Anything past the page silently resolved to nothing, and every
 * relationship pointing at it failed claiming the parent did not exist. The
 * invariant these cover is completeness: for the numbers asked about, the
 * answer does not depend on how many other items the design holds.
 */
describe('ItemSearchService.findIdsByItemNumbers', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designAId: string
  let designBId: string

  async function insertPart(itemNumber: string, designId: string) {
    return takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: crypto.randomUUID(),
          revision: 'A',
          itemType: 'Part',
          state: 'Draft',
          createdBy: user.id,
          modifiedBy: user.id,
          itemNumber,
          designId,
        })
        .returning(),
    )
  }

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)

    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({ name: 'Program', code: `PF-${uniq}`, createdBy: user.id })
        .returning(),
    )
    const designA = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId: program.id,
          name: 'Design A',
          code: `FA-${uniq}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const designB = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          programId: program.id,
          name: 'Design B',
          code: `FB-${uniq}`,
          createdBy: user.id,
        })
        .returning(),
    )
    designAId = designA.id
    designBId = designB.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('resolves a target regardless of how many other items the design holds', async () => {
    // 60 filler rows does not reproduce the original 1000-row cap — seeding
    // that many per test is not worth the seconds. What this pins is that the
    // method has no row cap at all: the target sorts last by item number, so
    // any limit at or below the common page sizes (20/25/50) reintroduced
    // here fails this test.
    for (let i = 0; i < 60; i++) {
      await insertPart(`BULK-${String(i).padStart(3, '0')}`, designAId)
    }
    const target = await insertPart('ZZZ-TARGET', designAId)

    const resolved = await ItemSearchService.findIdsByItemNumbers(
      ['ZZZ-TARGET'],
      { designIds: [designAId] },
    )

    expect(resolved.get('zzz-target')).toBe(target.id)
  })

  it('matches item numbers case-insensitively', async () => {
    const part = await insertPart('MiXeD-001', designAId)

    const resolved = await ItemSearchService.findIdsByItemNumbers(
      ['mixed-001'],
      { designIds: [designAId] },
    )

    expect(resolved.get('mixed-001')).toBe(part.id)
  })

  it('omits numbers that do not exist rather than guessing', async () => {
    await insertPart('REAL-001', designAId)

    const resolved = await ItemSearchService.findIdsByItemNumbers(
      ['REAL-001', 'GHOST-001'],
      { designIds: [designAId] },
    )

    expect(resolved.has('real-001')).toBe(true)
    expect(resolved.has('ghost-001')).toBe(false)
  })

  it('confines resolution to the requested designs', async () => {
    await insertPart('SCOPED-001', designBId)

    const resolved = await ItemSearchService.findIdsByItemNumbers(
      ['SCOPED-001'],
      { designIds: [designAId] },
    )

    expect(resolved.size).toBe(0)
  })

  it('returns an empty map for an empty request without querying', async () => {
    const resolved = await ItemSearchService.findIdsByItemNumbers([])
    expect(resolved.size).toBe(0)
  })
})
