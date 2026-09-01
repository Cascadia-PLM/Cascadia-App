// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Component Catalog Schema
 *
 * Curated reference library of real, purchasable components and raw stock
 * materials. Used by the design engine during BOM drafting to ground
 * Purchase parts in real specs, pricing, and sourcing info.
 *
 * This is NOT a versioned PLM data source. Once a PLM Part is materialized
 * from a catalog entry, the part stands alone — no FK back to catalog.
 */

import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'

// ============================================================================
// JSONB Type Definitions
// ============================================================================

export interface CatalogDimensions {
  width?: number // mm
  height?: number
  depth?: number
  diameter?: number
  weight?: number // grams
}

export interface CatalogMountingFeature {
  type: string // "bolt_circle", "flange", "shaft", "pin_header", "screw_terminal"
  specs: Record<string, unknown> // e.g., { boltCircleDiameter: 31, boltSize: 3, pattern: "square" }
}

export interface CatalogElectrical {
  voltage?: string // "12V", "5-24V"
  current?: string // "1.7A"
  power?: string
  interface?: string // "STEP/DIR", "I2C", "UART"
  pinout?: string
}

export interface CatalogSupplier {
  name: string // "Amazon", "DigiKey"
  partNumber?: string
  approximatePrice: number // USD
  url?: string
  lastVerified?: string // ISO date
}

export interface CatalogStockSize {
  label: string // "500mm", "300x300mm"
  dimensions: Record<string, number> // { length: 500 } or { width: 300, height: 300 }
  supplierPartNumber?: string
  approximatePrice?: number
}

// ============================================================================
// Categories Table (self-referencing hierarchy)
// ============================================================================

export const componentCatalogCategories = pgTable(
  'component_catalog_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    // Self-referencing FK — added via raw SQL in migration (Drizzle limitation)
    parentId: uuid('parent_id'),
    sortOrder: integer('sort_order').default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_catalog_categories_parent').on(table.parentId),
    index('idx_catalog_categories_slug').on(table.slug),
  ],
)

// ============================================================================
// Entries Table (main catalog)
// ============================================================================

export const componentCatalogEntries = pgTable(
  'component_catalog_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    // FK named in the table extras below — see the note there.
    categoryId: uuid('category_id').notNull(),

    // Distinguishes finished components from raw stock materials
    entryType: text('entry_type', { enum: ['component', 'raw_stock'] })
      .notNull()
      .default('component'),

    // Structured specs (JSONB)
    dimensions: jsonb('dimensions').$type<CatalogDimensions>(),
    mountingFeatures: jsonb('mounting_features')
      .$type<Array<CatalogMountingFeature>>()
      .notNull()
      .default([]),
    electrical: jsonb('electrical').$type<CatalogElectrical>(),
    specs: jsonb('specs').$type<Record<string, string>>().notNull().default({}),

    // Raw stock: available standard sizes this material is sold in
    stockSizes: jsonb('stock_sizes').$type<Array<CatalogStockSize>>(),

    // Sourcing
    suppliers: jsonb('suppliers')
      .$type<Array<CatalogSupplier>>()
      .notNull()
      .default([]),

    // LLM guidance
    designNotes: text('design_notes'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'`),

    // Admin metadata
    verified: boolean('verified').default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Named explicitly: the implicit name is 72 bytes, past Postgres's 63.
    foreignKey({
      name: 'fk_catalog_entry_category',
      columns: [table.categoryId],
      foreignColumns: [componentCatalogCategories.id],
    }),
    // Full-text search using 'simple' config to preserve engineering tokens (M3, NEMA, 2020)
    // Note: Uses immutable-safe expression (no array_to_string which is STABLE)
    index('idx_catalog_fts').using(
      'gin',
      sql`to_tsvector('simple',
        coalesce(${table.name}, '') || ' ' ||
        coalesce(${table.description}, '') || ' ' ||
        coalesce(${table.designNotes}, ''))`,
    ),
    // Separate GIN index on tags array for @> containment queries
    index('idx_catalog_tags').using('gin', table.tags),
    index('idx_catalog_category').on(table.categoryId),
    index('idx_catalog_entry_type').on(table.entryType),
  ],
)

// ============================================================================
// Media Table (images, diagrams, datasheets)
// ============================================================================

export const componentCatalogMedia = pgTable(
  'component_catalog_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK named in the table extras below — see the note there.
    componentId: uuid('component_id').notNull(),
    type: text('type', {
      enum: ['thumbnail', 'diagram', 'datasheet'],
    }).notNull(),
    fileId: uuid('file_id').notNull(), // references vault file
    label: text('label'),
    sortOrder: integer('sort_order').default(0),
  },
  (table) => [
    // Named explicitly: the implicit name is 68 bytes, past Postgres's 63.
    foreignKey({
      name: 'fk_catalog_media_component',
      columns: [table.componentId],
      foreignColumns: [componentCatalogEntries.id],
    }).onDelete('cascade'),
    index('idx_catalog_media_component').on(table.componentId),
  ],
)

// ============================================================================
// Relations
// ============================================================================

export const componentCatalogCategoriesRelations = relations(
  componentCatalogCategories,
  ({ one, many }) => ({
    parent: one(componentCatalogCategories, {
      fields: [componentCatalogCategories.parentId],
      references: [componentCatalogCategories.id],
      relationName: 'categoryParent',
    }),
    children: many(componentCatalogCategories, {
      relationName: 'categoryParent',
    }),
    entries: many(componentCatalogEntries),
  }),
)

export const componentCatalogEntriesRelations = relations(
  componentCatalogEntries,
  ({ one, many }) => ({
    category: one(componentCatalogCategories, {
      fields: [componentCatalogEntries.categoryId],
      references: [componentCatalogCategories.id],
    }),
    media: many(componentCatalogMedia),
  }),
)

export const componentCatalogMediaRelations = relations(
  componentCatalogMedia,
  ({ one }) => ({
    entry: one(componentCatalogEntries, {
      fields: [componentCatalogMedia.componentId],
      references: [componentCatalogEntries.id],
    }),
  }),
)
