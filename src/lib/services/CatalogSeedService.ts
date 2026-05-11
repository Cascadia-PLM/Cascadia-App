// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Component Catalog Seed Service
 *
 * Seeds the component catalog with categories and curated entries sourced
 * from `test-data/*.json`. Idempotent: categories use onConflictDoNothing
 * on slug, and duplicate entry inserts are caught and counted as skipped.
 *
 * Used by `scripts/seed-catalog.ts` (CLI) and `POST /api/v1/setup/seed-catalog`
 * (first-time setup wizard).
 */

import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  componentCatalogCategories,
  componentCatalogEntries,
} from '../db/schema/componentCatalog'
import { CATEGORIES } from '../../../scripts/seed/catalog-data/categories'
import { ENTRIES } from '../../../scripts/seed/catalog-data/entries'
import type {
  CatalogDimensions,
  CatalogElectrical,
  CatalogMountingFeature,
  CatalogStockSize,
} from '../db/schema/componentCatalog'
import type { CategoryDef } from '../../../scripts/seed/catalog-data/categories'
import type { CatalogEntryDef } from '../../../scripts/seed/types'

export interface CatalogSeedResult {
  categoriesReady: number
  inserted: number
  skipped: number
  prunedCategories: number
}

export class CatalogSeedService {
  /**
   * Run the catalog seed end-to-end. Safe to re-run.
   */
  static async run(): Promise<CatalogSeedResult> {
    const slugToId = await this.seedCategories()

    const result = await this.seedEntries(ENTRIES, slugToId)
    const prunedCategories = await this.pruneEmptyCategories()

    return {
      categoriesReady: slugToId.size - prunedCategories,
      inserted: result.inserted,
      skipped: result.skipped,
      prunedCategories,
    }
  }

  /**
   * Delete categories that have no entries and no descendant categories.
   * Iterates until stable so parents become eligible once their last empty
   * child is dropped. Safe: only categories with zero entries can match,
   * so no entries are ever orphaned.
   */
  private static async pruneEmptyCategories(): Promise<number> {
    let total = 0
    let rows = 0
    do {
      const deleted = await db.execute<{ id: string }>(sql`
        DELETE FROM component_catalog_categories parent
        WHERE NOT EXISTS (
          SELECT 1 FROM component_catalog_entries e
          WHERE e.category_id = parent.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM component_catalog_categories child
          WHERE child.parent_id = parent.id
        )
        RETURNING id
      `)
      rows = (deleted as unknown as Array<{ id: string }>).length
      total += rows
    } while (rows > 0)
    return total
  }

  private static async seedCategories(): Promise<Map<string, string>> {
    const slugToId = new Map<string, string>()

    const insertCategory = async (
      cat: CategoryDef,
      parentId: string | null,
    ): Promise<void> => {
      const [inserted] = await db
        .insert(componentCatalogCategories)
        .values({
          name: cat.name,
          slug: cat.slug,
          parentId,
        })
        .onConflictDoNothing({ target: componentCatalogCategories.slug })
        .returning()

      let catId: string
      if (inserted) {
        catId = inserted.id
      } else {
        const [existing] = await db
          .select({ id: componentCatalogCategories.id })
          .from(componentCatalogCategories)
          .where(eq(componentCatalogCategories.slug, cat.slug))
        if (!existing) {
          throw new Error(
            `Category lookup failed for slug "${cat.slug}" after insert conflict`,
          )
        }
        catId = existing.id
      }

      slugToId.set(cat.slug, catId)

      if (cat.children) {
        for (const child of cat.children) {
          await insertCategory(child, catId)
        }
      }
    }

    for (const cat of CATEGORIES) {
      await insertCategory(cat, null)
    }

    return slugToId
  }

  private static async seedEntries(
    entries: Array<CatalogEntryDef>,
    slugToId: Map<string, string>,
  ): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0
    let skipped = 0

    for (const entry of entries) {
      const categoryId = slugToId.get(entry.categorySlug)
      if (!categoryId) {
        skipped++
        continue
      }

      try {
        // The seed input is loose (JSON) but the column types are strict.
        // jsonb accepts any JSON shape, so cast at the boundary.
        await db.insert(componentCatalogEntries).values({
          name: entry.name,
          description: entry.description,
          categoryId,
          entryType: entry.entryType,
          dimensions: (entry.dimensions ?? null) as CatalogDimensions | null,
          mountingFeatures: (entry.mountingFeatures ??
            []) as Array<CatalogMountingFeature>,
          electrical: (entry.electrical ?? null) as CatalogElectrical | null,
          specs: (entry.specs ?? {}) as Record<string, string>,
          stockSizes: (entry.stockSizes ?? null) as Array<CatalogStockSize> | null,
          suppliers: entry.suppliers ?? [],
          designNotes: entry.designNotes ?? null,
          tags: entry.tags ?? [],
          verified: false,
        })
        inserted++
      } catch {
        skipped++
      }
    }

    return { inserted, skipped }
  }
}
