/**
 * Component Catalog Service
 *
 * CRUD, full-text search, and bulk import for the component catalog.
 * Used by the BOM drafting tool (lookup_component_catalog) and the admin UI.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import {
  componentCatalogCategories,
  componentCatalogEntries,
  componentCatalogMedia,
} from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import type { SQL } from 'drizzle-orm'
import type {
  CatalogDimensions,
  CatalogElectrical,
  CatalogMountingFeature,
  CatalogStockSize,
  CatalogSupplier,
} from '../db/schema/componentCatalog'

// ============================================================================
// Zod Schemas
// ============================================================================

export const catalogEntryCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().nullable().optional(),
  categoryId: z.string().uuid('Invalid category ID'),
  entryType: z.enum(['component', 'raw_stock']).default('component'),
  dimensions: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      depth: z.number().optional(),
      diameter: z.number().optional(),
      weight: z.number().optional(),
    })
    .nullable()
    .optional(),
  mountingFeatures: z
    .array(
      z.object({
        type: z.string(),
        specs: z.record(z.string(), z.unknown()).optional().default({}),
      }),
    )
    .optional()
    .default([]),
  electrical: z
    .object({
      voltage: z.string().nullable().optional(),
      current: z.string().nullable().optional(),
      power: z.string().nullable().optional(),
      interface: z.string().nullable().optional(),
      pinout: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  specs: z.record(z.string(), z.unknown()).optional().default({}),
  stockSizes: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  suppliers: z
    .array(
      z.object({
        name: z.string(),
        partNumber: z.string().optional(),
        approximatePrice: z.number(),
        url: z.string().optional(),
        lastVerified: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
  designNotes: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  verified: z.boolean().optional().default(false),
})

export const catalogEntryUpdateSchema = catalogEntryCreateSchema.partial()

export const catalogBulkImportRowSchema = catalogEntryCreateSchema.extend({
  categorySlug: z.string().optional(),
  categoryId: z.string().uuid().optional(),
})

export const catalogCategoryCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional().default(0),
})

export const catalogCategoryUpdateSchema = catalogCategoryCreateSchema.partial()

export type CreateCatalogEntryInput = z.infer<typeof catalogEntryCreateSchema>
export type UpdateCatalogEntryInput = z.infer<typeof catalogEntryUpdateSchema>
export type BulkImportRow = z.infer<typeof catalogBulkImportRowSchema>

// ============================================================================
// Response Types
// ============================================================================

export interface CatalogEntryWithCategory {
  id: string
  name: string
  description: string | null
  category: { id: string; name: string; slug: string }
  entryType: 'component' | 'raw_stock'
  dimensions: CatalogDimensions | null
  mountingFeatures: Array<CatalogMountingFeature>
  electrical: CatalogElectrical | null
  specs: Record<string, string>
  stockSizes: Array<CatalogStockSize> | null
  suppliers: Array<CatalogSupplier>
  designNotes: string | null
  tags: Array<string>
  verified: boolean
}

export interface CatalogEntryFull extends CatalogEntryWithCategory {
  media: Array<{
    id: string
    type: 'thumbnail' | 'diagram' | 'datasheet'
    fileId: string
    label: string | null
    sortOrder: number | null
  }>
  createdAt: Date
  updatedAt: Date
}

export interface CatalogSearchOptions {
  categorySlug?: string
  entryType?: 'component' | 'raw_stock'
  limit?: number
}

export interface CatalogListOptions {
  categoryId?: string
  entryType?: 'component' | 'raw_stock'
  verified?: boolean
  query?: string
  offset?: number
  limit?: number
  sortBy?: 'name' | 'createdAt' | 'updatedAt'
  sortOrder?: 'asc' | 'desc'
}

export interface BulkImportResult {
  successCount: number
  errorCount: number
  errors: Array<{ row: number; message: string }>
}

// ============================================================================
// Service
// ============================================================================

export class CatalogService {
  // --------------------------------------------------------------------------
  // Search (used by LLM tool)
  // --------------------------------------------------------------------------

  /**
   * Full-text search using plainto_tsquery with 'simple' config.
   * Returns entries ranked by relevance with category joined.
   */
  static async search(
    query: string,
    options: CatalogSearchOptions = {},
  ): Promise<{ results: Array<CatalogEntryWithCategory>; total: number }> {
    const { categorySlug, entryType, limit = 5 } = options
    const conditions: Array<SQL> = []

    // Full-text search
    const tsVector = sql`to_tsvector('simple',
      ${componentCatalogEntries.name} || ' ' ||
      coalesce(${componentCatalogEntries.description}, '') || ' ' ||
      array_to_string(${componentCatalogEntries.tags}, ' ') || ' ' ||
      coalesce(${componentCatalogEntries.designNotes}, ''))`
    const tsQuery = sql`plainto_tsquery('simple', ${query})`
    conditions.push(sql`${tsVector} @@ ${tsQuery}`)

    if (categorySlug) {
      conditions.push(eq(componentCatalogCategories.slug, categorySlug))
    }

    if (entryType) {
      conditions.push(eq(componentCatalogEntries.entryType, entryType))
    }

    const rows = await db
      .select({
        entry: componentCatalogEntries,
        categoryId: componentCatalogCategories.id,
        categoryName: componentCatalogCategories.name,
        categorySlug: componentCatalogCategories.slug,
        rank: sql<number>`ts_rank(${tsVector}, ${tsQuery})`,
      })
      .from(componentCatalogEntries)
      .leftJoin(
        componentCatalogCategories,
        eq(componentCatalogEntries.categoryId, componentCatalogCategories.id),
      )
      .where(and(...conditions))
      .orderBy(sql`ts_rank(${tsVector}, ${tsQuery}) DESC`)
      .limit(limit)

    const results = rows.map((row) => hydrateEntry(row))
    return { results, total: results.length }
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  static async getById(id: string): Promise<CatalogEntryFull> {
    const rows = await db
      .select({
        entry: componentCatalogEntries,
        categoryId: componentCatalogCategories.id,
        categoryName: componentCatalogCategories.name,
        categorySlug: componentCatalogCategories.slug,
      })
      .from(componentCatalogEntries)
      .leftJoin(
        componentCatalogCategories,
        eq(componentCatalogEntries.categoryId, componentCatalogCategories.id),
      )
      .where(eq(componentCatalogEntries.id, id))
      .limit(1)

    if (rows.length === 0) {
      throw new NotFoundError('Catalog entry')
    }

    const media = await db
      .select()
      .from(componentCatalogMedia)
      .where(eq(componentCatalogMedia.componentId, id))
      .orderBy(asc(componentCatalogMedia.sortOrder))

    return {
      ...hydrateEntry(rows[0]),
      media: media.map((m) => ({
        id: m.id,
        type: m.type,
        fileId: m.fileId,
        label: m.label,
        sortOrder: m.sortOrder,
      })),
      createdAt: rows[0].entry.createdAt,
      updatedAt: rows[0].entry.updatedAt,
    }
  }

  static async list(
    options: CatalogListOptions = {},
  ): Promise<{ entries: Array<CatalogEntryWithCategory>; total: number }> {
    const {
      categoryId,
      entryType,
      verified,
      query,
      offset = 0,
      limit = 50,
      sortBy = 'name',
      sortOrder = 'asc',
    } = options

    const conditions: Array<SQL> = []

    if (categoryId) {
      conditions.push(eq(componentCatalogEntries.categoryId, categoryId))
    }
    if (entryType) {
      conditions.push(eq(componentCatalogEntries.entryType, entryType))
    }
    if (verified !== undefined) {
      conditions.push(eq(componentCatalogEntries.verified, verified))
    }
    if (query) {
      const tsVector = sql`to_tsvector('simple',
        ${componentCatalogEntries.name} || ' ' ||
        coalesce(${componentCatalogEntries.description}, '') || ' ' ||
        array_to_string(${componentCatalogEntries.tags}, ' ') || ' ' ||
        coalesce(${componentCatalogEntries.designNotes}, ''))`
      conditions.push(sql`${tsVector} @@ plainto_tsquery('simple', ${query})`)
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    // Count
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(componentCatalogEntries)
      .where(where)

    const total = Number(countRow?.count ?? 0)

    // Sort
    const sortCol =
      sortBy === 'createdAt'
        ? componentCatalogEntries.createdAt
        : sortBy === 'updatedAt'
          ? componentCatalogEntries.updatedAt
          : componentCatalogEntries.name
    const orderFn = sortOrder === 'desc' ? desc : asc

    const rows = await db
      .select({
        entry: componentCatalogEntries,
        categoryId: componentCatalogCategories.id,
        categoryName: componentCatalogCategories.name,
        categorySlug: componentCatalogCategories.slug,
      })
      .from(componentCatalogEntries)
      .leftJoin(
        componentCatalogCategories,
        eq(componentCatalogEntries.categoryId, componentCatalogCategories.id),
      )
      .where(where)
      .orderBy(orderFn(sortCol))
      .offset(offset)
      .limit(limit)

    return { entries: rows.map((row) => hydrateEntry(row)), total }
  }

  static async createEntry(
    data: CreateCatalogEntryInput,
  ): Promise<CatalogEntryWithCategory> {
    const validated = catalogEntryCreateSchema.parse(data)

    const values = {
      name: validated.name,
      description: validated.description ?? null,
      categoryId: validated.categoryId,
      entryType: validated.entryType,
      dimensions: validated.dimensions ?? null,
      mountingFeatures: validated.mountingFeatures,
      electrical: validated.electrical ?? null,
      specs: validated.specs,
      stockSizes: validated.stockSizes ?? null,
      suppliers: validated.suppliers,
      designNotes: validated.designNotes ?? null,
      tags: validated.tags,
      verified: validated.verified,
    }
    const [inserted] = await db
      .insert(componentCatalogEntries)
      .values(values as any)
      .returning()

    // Fetch with category joined
    return this.getById(inserted.id)
  }

  static async updateEntry(
    id: string,
    data: UpdateCatalogEntryInput,
  ): Promise<CatalogEntryWithCategory> {
    const validated = catalogEntryUpdateSchema.parse(data)

    const updateData: Record<string, unknown> = { updatedAt: new Date() }
    if (validated.name !== undefined) updateData.name = validated.name
    if (validated.description !== undefined)
      updateData.description = validated.description
    if (validated.categoryId !== undefined)
      updateData.categoryId = validated.categoryId
    if (validated.entryType !== undefined)
      updateData.entryType = validated.entryType
    if (validated.dimensions !== undefined)
      updateData.dimensions = validated.dimensions
    if (validated.mountingFeatures !== undefined)
      updateData.mountingFeatures = validated.mountingFeatures
    if (validated.electrical !== undefined)
      updateData.electrical = validated.electrical
    if (validated.specs !== undefined) updateData.specs = validated.specs
    if (validated.stockSizes !== undefined)
      updateData.stockSizes = validated.stockSizes
    if (validated.suppliers !== undefined)
      updateData.suppliers = validated.suppliers
    if (validated.designNotes !== undefined)
      updateData.designNotes = validated.designNotes
    if (validated.tags !== undefined) updateData.tags = validated.tags
    if (validated.verified !== undefined)
      updateData.verified = validated.verified

    const [updated] = await db
      .update(componentCatalogEntries)
      .set(updateData)
      .where(eq(componentCatalogEntries.id, id))
      .returning()

    if (!updated) {
      throw new NotFoundError('Catalog entry')
    }

    return this.getById(id)
  }

  static async deleteEntry(id: string): Promise<void> {
    const [deleted] = await db
      .delete(componentCatalogEntries)
      .where(eq(componentCatalogEntries.id, id))
      .returning({ id: componentCatalogEntries.id })

    if (!deleted) {
      throw new NotFoundError('Catalog entry')
    }
  }

  // --------------------------------------------------------------------------
  // Categories
  // --------------------------------------------------------------------------

  static async getCategories(): Promise<
    Array<{
      id: string
      name: string
      slug: string
      parentId: string | null
      sortOrder: number | null
    }>
  > {
    return db
      .select({
        id: componentCatalogCategories.id,
        name: componentCatalogCategories.name,
        slug: componentCatalogCategories.slug,
        parentId: componentCatalogCategories.parentId,
        sortOrder: componentCatalogCategories.sortOrder,
      })
      .from(componentCatalogCategories)
      .orderBy(
        asc(componentCatalogCategories.sortOrder),
        asc(componentCatalogCategories.name),
      )
  }

  static async createCategory(
    data: z.infer<typeof catalogCategoryCreateSchema>,
  ): Promise<{
    id: string
    name: string
    slug: string
    parentId: string | null
    sortOrder: number | null
  }> {
    const validated = catalogCategoryCreateSchema.parse(data)

    const [inserted] = await db
      .insert(componentCatalogCategories)
      .values({
        name: validated.name,
        slug: validated.slug,
        parentId: validated.parentId ?? null,
        sortOrder: validated.sortOrder,
      })
      .returning()

    return {
      id: inserted.id,
      name: inserted.name,
      slug: inserted.slug,
      parentId: inserted.parentId,
      sortOrder: inserted.sortOrder,
    }
  }

  static async updateCategory(
    id: string,
    data: z.infer<typeof catalogCategoryUpdateSchema>,
  ): Promise<{
    id: string
    name: string
    slug: string
    parentId: string | null
    sortOrder: number | null
  }> {
    const validated = catalogCategoryUpdateSchema.parse(data)

    const updateData: Record<string, unknown> = {}
    if (validated.name !== undefined) updateData.name = validated.name
    if (validated.slug !== undefined) updateData.slug = validated.slug
    if (validated.parentId !== undefined)
      updateData.parentId = validated.parentId
    if (validated.sortOrder !== undefined)
      updateData.sortOrder = validated.sortOrder

    const [updated] = await db
      .update(componentCatalogCategories)
      .set(updateData)
      .where(eq(componentCatalogCategories.id, id))
      .returning()

    if (!updated) {
      throw new NotFoundError('Catalog category')
    }

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      parentId: updated.parentId,
      sortOrder: updated.sortOrder,
    }
  }

  static async deleteCategory(id: string): Promise<void> {
    // Check if any entries reference this category
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(componentCatalogEntries)
      .where(eq(componentCatalogEntries.categoryId, id))

    if (Number(countRow?.count ?? 0) > 0) {
      throw new ValidationError(
        'Cannot delete category with existing entries. Move or delete entries first.',
      )
    }

    const [deleted] = await db
      .delete(componentCatalogCategories)
      .where(eq(componentCatalogCategories.id, id))
      .returning({ id: componentCatalogCategories.id })

    if (!deleted) {
      throw new NotFoundError('Catalog category')
    }
  }

  // --------------------------------------------------------------------------
  // Bulk Import
  // --------------------------------------------------------------------------

  static async bulkImport(
    rows: Array<BulkImportRow>,
  ): Promise<BulkImportResult> {
    let successCount = 0
    let errorCount = 0
    const errors: Array<{ row: number; message: string }> = []

    // Pre-fetch categories for slug resolution, auto-create missing ones
    const categories = await this.getCategories()
    const slugToId = new Map(categories.map((c) => [c.slug, c.id]))

    // Collect all unique slugs that don't exist yet and create them
    const missingSlugs = new Set<string>()
    for (const row of rows) {
      if (
        !row.categoryId &&
        row.categorySlug &&
        !slugToId.has(row.categorySlug)
      ) {
        missingSlugs.add(row.categorySlug)
      }
    }
    for (const slug of missingSlugs) {
      const name = slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
      const [created] = await db
        .insert(componentCatalogCategories)
        .values({ name, slug })
        .returning({ id: componentCatalogCategories.id })
      slugToId.set(slug, created.id)
    }

    for (let i = 0; i < rows.length; i++) {
      try {
        const row = rows[i]

        // Resolve categorySlug to categoryId if needed
        let categoryId = row.categoryId
        if (!categoryId && row.categorySlug) {
          categoryId = slugToId.get(row.categorySlug)
          if (!categoryId) {
            throw new Error(`Unknown category slug: "${row.categorySlug}"`)
          }
        }
        if (!categoryId) {
          throw new Error('categoryId or categorySlug is required')
        }

        const validated = catalogEntryCreateSchema.parse({
          ...row,
          categoryId,
        })

        await db.insert(componentCatalogEntries).values({
          name: validated.name,
          description: validated.description ?? null,
          categoryId: validated.categoryId,
          entryType: validated.entryType,
          dimensions: validated.dimensions ?? null,
          mountingFeatures: validated.mountingFeatures,
          electrical: validated.electrical ?? null,
          specs: validated.specs,
          stockSizes: validated.stockSizes ?? null,
          suppliers: validated.suppliers,
          designNotes: validated.designNotes ?? null,
          tags: validated.tags,
          verified: validated.verified,
        } as any)

        successCount++
      } catch (err) {
        errorCount++
        errors.push({
          row: i + 1,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { successCount, errorCount, errors }
  }

  // --------------------------------------------------------------------------
  // Media
  // --------------------------------------------------------------------------

  static async addMedia(
    catalogEntryId: string,
    fileId: string,
    type: 'thumbnail' | 'diagram' | 'datasheet',
    label?: string,
  ): Promise<{ id: string }> {
    const [inserted] = await db
      .insert(componentCatalogMedia)
      .values({
        componentId: catalogEntryId,
        fileId,
        type,
        label: label ?? null,
      })
      .returning({ id: componentCatalogMedia.id })

    return { id: inserted.id }
  }

  static async removeMedia(mediaId: string): Promise<void> {
    const [deleted] = await db
      .delete(componentCatalogMedia)
      .where(eq(componentCatalogMedia.id, mediaId))
      .returning({ id: componentCatalogMedia.id })

    if (!deleted) {
      throw new NotFoundError('Catalog media')
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function hydrateEntry(row: {
  entry: typeof componentCatalogEntries.$inferSelect
  categoryId: string | null
  categoryName: string | null
  categorySlug: string | null
}): CatalogEntryWithCategory {
  return {
    id: row.entry.id,
    name: row.entry.name,
    description: row.entry.description,
    category: {
      id: row.categoryId ?? '',
      name: row.categoryName ?? '',
      slug: row.categorySlug ?? '',
    },
    entryType: row.entry.entryType,
    dimensions: row.entry.dimensions,
    mountingFeatures: row.entry.mountingFeatures ?? [],
    electrical: row.entry.electrical,
    specs: row.entry.specs ?? {},
    stockSizes: row.entry.stockSizes,
    suppliers: row.entry.suppliers ?? [],
    designNotes: row.entry.designNotes,
    tags: row.entry.tags ?? [],
    verified: row.entry.verified ?? false,
  }
}
