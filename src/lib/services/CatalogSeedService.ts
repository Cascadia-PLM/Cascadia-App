// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Component Catalog Seed Service
 *
 * Seeds the component catalog with categories and entries (fasteners,
 * raw stock). Idempotent: categories use onConflictDoNothing on slug, and
 * duplicate entry inserts are caught and counted as skipped.
 *
 * Used by `scripts/seed-catalog.ts` (CLI) and `POST /api/v1/setup/seed-catalog`
 * (first-time setup wizard).
 */

import { eq } from 'drizzle-orm'
import { db } from '../db'
import {
  componentCatalogCategories,
  componentCatalogEntries,
} from '../db/schema/componentCatalog'
import { CATEGORIES } from '../../../scripts/seed/catalog-data/categories'
import { FASTENERS } from '../../../scripts/seed/catalog-data/fasteners'
import { RAW_STOCK } from '../../../scripts/seed/catalog-data/raw-stock'
import type { CategoryDef } from '../../../scripts/seed/catalog-data/categories'
import type { CatalogEntryDef } from '../../../scripts/seed/types'

export interface CatalogSeedResult {
  categoriesReady: number
  inserted: number
  skipped: number
}

export class CatalogSeedService {
  /**
   * Run the catalog seed end-to-end. Safe to re-run.
   */
  static async run(): Promise<CatalogSeedResult> {
    const slugToId = await this.seedCategories()

    const fastenersResult = await this.seedEntries(FASTENERS, slugToId)
    const rawStockResult = await this.seedEntries(RAW_STOCK, slugToId)

    return {
      categoriesReady: slugToId.size,
      inserted: fastenersResult.inserted + rawStockResult.inserted,
      skipped: fastenersResult.skipped + rawStockResult.skipped,
    }
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
        await db.insert(componentCatalogEntries).values({
          name: entry.name,
          description: entry.description,
          categoryId,
          entryType: entry.entryType,
          dimensions: entry.dimensions ?? null,
          mountingFeatures: entry.mountingFeatures ?? [],
          electrical: entry.electrical ?? null,
          specs: entry.specs ?? {},
          stockSizes: entry.stockSizes ?? null,
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
