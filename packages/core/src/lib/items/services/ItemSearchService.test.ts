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
    designId: string
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
      designIds: [designAId],
    })

    expect(result.items.map((i) => i.itemNumber)).toEqual(['SCOPE-001'])
    expect(result.total).toBe(1)
  })

  it('matches nothing when the design scope is empty', async () => {
    await insertItem({ itemNumber: 'SCOPE-001', designId: designAId })

    const result = await ItemSearchService.searchGlobal({
      query: 'SCOPE',
      itemTypes: ['Part'],
      designIds: [],
    })

    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })

  it('matches nothing when no item types are allowed', async () => {
    await insertItem({ itemNumber: 'SCOPE-001', designId: designAId })

    const result = await ItemSearchService.searchGlobal({
      query: 'SCOPE',
      itemTypes: [],
      designIds: [designAId, designBId],
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
      designIds: [designAId],
    })

    expect(result.items.map((i) => i.itemNumber)).toEqual(['TYPE-002'])
  })

  it('filters by the owning program through the design join', async () => {
    await insertItem({ itemNumber: 'PROG-001', designId: designAId })
    await insertItem({ itemNumber: 'PROG-002', designId: designBId })

    const result = await ItemSearchService.searchGlobal({
      query: 'PROG',
      itemTypes: ['Part'],
      designIds: [designAId, designBId],
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
      designIds: [designAId],
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
      designIds: [designAId],
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
      designIds: [designAId],
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
      designIds: [designAId],
    })

    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
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
