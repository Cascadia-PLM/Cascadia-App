/**
 * Component Catalog Seed Script
 *
 * Seeds the component catalog with categories and entries.
 * Safe to re-run — uses onConflictDoNothing for categories
 * and inserts entries that don't match existing names.
 *
 * Usage: npx tsx scripts/seed-catalog.ts
 */

import { eq, sql } from 'drizzle-orm'
import { db } from '../src/lib/db/index.ts'
import {
  componentCatalogCategories,
  componentCatalogEntries,
} from '../src/lib/db/schema/componentCatalog.ts'
import { CATEGORIES } from './seed/catalog-data/categories.ts'
import { FASTENERS } from './seed/catalog-data/fasteners.ts'
import { RAW_STOCK } from './seed/catalog-data/raw-stock.ts'
import type { CategoryDef } from './seed/catalog-data/categories.ts'
import type { CatalogEntryDef } from './seed/types.ts'

// ============================================================================
// Seed Categories
// ============================================================================

async function seedCategories() {
  console.log('Seeding categories...')
  const slugToId = new Map<string, string>()

  async function insertCategory(cat: CategoryDef, parentId: string | null) {
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
      // Already exists — look up ID
      const [existing] = await db
        .select({ id: componentCatalogCategories.id })
        .from(componentCatalogCategories)
        .where(eq(componentCatalogCategories.slug, cat.slug))
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

  console.log(`  ${slugToId.size} categories ready`)
  return slugToId
}

// ============================================================================
// Seed Entries
// ============================================================================

async function seedEntries(
  entries: Array<CatalogEntryDef>,
  slugToId: Map<string, string>,
  batchName: string,
) {
  console.log(`Seeding ${batchName} (${entries.length} entries)...`)
  let inserted = 0
  let skipped = 0

  for (const entry of entries) {
    const categoryId = slugToId.get(entry.categorySlug)
    if (!categoryId) {
      console.warn(
        `  WARN: Unknown category slug "${entry.categorySlug}" for "${entry.name}" — skipping`,
      )
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
    } catch (err) {
      console.warn(
        `  WARN: Failed to insert "${entry.name}": ${err instanceof Error ? err.message : err}`,
      )
      skipped++
    }
  }

  console.log(`  ${inserted} inserted, ${skipped} skipped`)
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('=== Component Catalog Seed ===\n')

  const slugToId = await seedCategories()

  // Seed in dependency order
  await seedEntries(FASTENERS, slugToId, 'Fasteners')
  await seedEntries(RAW_STOCK, slugToId, 'Raw Stock & T-Slot Hardware')

  // Count totals
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(componentCatalogEntries)
  console.log(`\nTotal catalog entries: ${countRow?.count ?? 0}`)

  console.log('\nDone!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
