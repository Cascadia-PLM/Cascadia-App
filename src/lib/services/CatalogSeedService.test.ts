// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * CatalogSeedService Tests
 *
 * Invariant tests per the three-gate rule (gate 1: multi-entity state
 * mutation). Verifies foreign-key integrity between entries and
 * categories, and that running the seed twice does not duplicate
 * categories.
 *
 * Run: npx vitest run src/lib/services/CatalogSeedService.test.ts
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
import { count, eq, isNull, sql } from 'drizzle-orm'
import { CatalogSeedService } from './CatalogSeedService'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  componentCatalogCategories,
  componentCatalogEntries,
} from '@/lib/db/schema/componentCatalog'

describe('CatalogSeedService', () => {
  const testDb = new TestDatabase()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  describe('run()', () => {
    it('inserts categories and entries with valid foreign keys', async () => {
      const result = await CatalogSeedService.run()

      expect(result.categoriesReady).toBeGreaterThan(0)
      expect(result.inserted).toBeGreaterThan(0)

      // Invariant: every inserted entry's categoryId references a real category.
      const orphans = await testDb.db
        .select({ id: componentCatalogEntries.id })
        .from(componentCatalogEntries)
        .leftJoin(
          componentCatalogCategories,
          eq(componentCatalogEntries.categoryId, componentCatalogCategories.id),
        )
        .where(isNull(componentCatalogCategories.id))

      expect(orphans).toEqual([])
    })

    it('does not duplicate categories when run twice', async () => {
      await CatalogSeedService.run()

      const [first] = await testDb.db
        .select({ count: count() })
        .from(componentCatalogCategories)
      const firstCount = Number(first?.count ?? 0)

      await CatalogSeedService.run()

      const [second] = await testDb.db
        .select({ count: count() })
        .from(componentCatalogCategories)
      const secondCount = Number(second?.count ?? 0)

      expect(secondCount).toBe(firstCount)
    })

    it('reports counts consistent with the rows it inserted', async () => {
      // Baseline counts may be non-zero if another committed run is
      // already in the database (e.g. someone ran db:seed:catalog), so
      // we compare the delta around our run instead of absolute totals.
      const [entryBefore] = await testDb.db
        .select({ c: sql<number>`count(*)::int` })
        .from(componentCatalogEntries)
      const beforeCount = Number(entryBefore?.c ?? 0)

      const result = await CatalogSeedService.run()

      const [entryAfter] = await testDb.db
        .select({ c: sql<number>`count(*)::int` })
        .from(componentCatalogEntries)
      const afterCount = Number(entryAfter?.c ?? 0)

      expect(afterCount - beforeCount).toBe(result.inserted)
      expect(result.categoriesReady).toBeGreaterThan(0)
    })
  })
})
