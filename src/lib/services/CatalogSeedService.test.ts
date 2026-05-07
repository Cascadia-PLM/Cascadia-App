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

    it('reports counts that match what landed in the database', async () => {
      const result = await CatalogSeedService.run()

      const [categoryRow] = await testDb.db
        .select({ c: count() })
        .from(componentCatalogCategories)
      const [entryRow] = await testDb.db
        .select({ c: sql<number>`count(*)::int` })
        .from(componentCatalogEntries)

      expect(Number(categoryRow?.c ?? 0)).toBe(result.categoriesReady)
      expect(Number(entryRow?.c ?? 0)).toBe(result.inserted)
    })
  })
})
