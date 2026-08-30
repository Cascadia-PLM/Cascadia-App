// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import { readableItemTypes } from './items'
import type { GlobalSearchCriteria } from '@/lib/items/services/ItemService'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { db } from '@/lib/db'
import { designs } from '@/lib/db/schema/designs'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { apiHandler, parseQuery } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Enterprise Search')

/**
 * Enrich items with design metadata
 */
async function enrichWithDesignMetadata<T extends { designId?: string | null }>(
  items: Array<T>,
) {
  // Collect unique design IDs
  const designIds = [
    ...new Set(
      items
        .map((i) => i.designId)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ]

  if (designIds.length === 0) {
    return items.map((item) => ({
      ...item,
      designCode: null,
      designName: null,
    }))
  }

  // Fetch design metadata
  const designsData = await db
    .select({ id: designs.id, code: designs.code, name: designs.name })
    .from(designs)
    .where(inArray(designs.id, designIds))

  const designMap = new Map(
    designsData.map((d) => [d.id, { code: d.code, name: d.name }]),
  )

  // Enrich items
  return items.map((item) => {
    const design = item.designId ? designMap.get(item.designId) : null
    return {
      ...item,
      designCode: design?.code ?? null,
      designName: design?.name ?? null,
    }
  })
}

/**
 * Search across multiple item types and return grouped results.
 *
 * `readableTypes` is the type-level permission gate: the fan-out below reads
 * every registered item type, so it has to start from the types this caller
 * may read rather than from the whole registry. `accessScope` is the
 * orthogonal design-level gate — a readable type still only yields rows from
 * designs the caller can reach.
 */
async function searchAcrossTypes(
  query: string,
  userId: string,
  readableTypes: Set<string>,
  limit: number,
): Promise<{
  results: Array<{ itemType: string; items: Array<any>; total: number }>
}> {
  // The registered item types this caller may read — the same gate the
  // '/results' sibling applies, so the two search surfaces agree.
  const allTypes = ItemTypeRegistry.getAllTypes().filter((typeConfig) =>
    readableTypes.has(typeConfig.name),
  )

  // Bound every per-type search to what this caller may read.
  const accessScope = await AccessControlService.getAccessScope(userId)

  // Search each item type in parallel
  const searchPromises = allTypes.map(async (typeConfig) => {
    try {
      const results = await ItemService.searchByItemNumber(query, {
        limit,
        itemTypes: [typeConfig.name],
        accessScope,
      })

      // Enrich with design metadata
      const enrichedResults = await enrichWithDesignMetadata(results)

      return {
        itemType: typeConfig.name,
        label: typeConfig.pluralLabel,
        icon: typeConfig.icon,
        items: enrichedResults,
        total: enrichedResults.length,
      }
    } catch (error) {
      console.error(`Error searching ${typeConfig.name}:`, error)
      return {
        itemType: typeConfig.name,
        label: typeConfig.pluralLabel,
        icon: typeConfig.icon,
        items: [],
        total: 0,
      }
    }
  })

  const results = await Promise.all(searchPromises)

  // Filter out types with no results
  const filteredResults = results.filter((r) => r.total > 0)

  // Cap total results to requested limit (proportional truncation)
  const totalItems = filteredResults.reduce((sum, r) => sum + r.items.length, 0)
  if (totalItems > limit) {
    const ratio = limit / totalItems
    for (const result of filteredResults) {
      const capped = Math.max(1, Math.round(result.items.length * ratio))
      result.items = result.items.slice(0, capped)
      result.total = result.items.length
    }
  }

  return { results: filteredResults }
}

/**
 * The header typeahead's query. `limit` is capped exactly as the '/results'
 * sibling caps its own; it was an unbounded `parseInt`, so `limit=abc`
 * reached the per-type searches as NaN (a SQL error swallowed into empty
 * groups) and `limit=1000000` reached them whole. The default stays at this
 * endpoint's historical 50 rather than the grid's 25.
 */
const typeaheadQuerySchema = z.object({
  q: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const resultsQuerySchema = z.object({
  globalSearch: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  sortField: z.string().optional(),
  sortDirection: z.enum(['asc', 'desc']).optional(),
  /** JSON-encoded record of column filters, as sent by the DataGrid layer. */
  columnFilters: z.string().optional(),
})

const searchResultRowSchema = z.object({
  id: z.string().uuid(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  itemType: z.string(),
  revision: z.string().nullable(),
  state: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  designId: z.string().uuid().nullable(),
  designCode: z.string().nullable(),
  designName: z.string().nullable(),
  programId: z.string().uuid().nullable(),
  programCode: z.string().nullable(),
  programName: z.string().nullable(),
})

/**
 * Pull the itemType filter out of the grid's column filters: it is enforced
 * through `readableItemTypes` rather than passed through as a plain filter,
 * so a crafted filter cannot widen the search beyond the user's permissions.
 */
function splitItemTypeFilter(
  columnFilters: GlobalSearchCriteria['columnFilters'],
): {
  requestedTypes: Array<string> | null
  rest: GlobalSearchCriteria['columnFilters']
} {
  if (!columnFilters || !('itemType' in columnFilters)) {
    return { requestedTypes: null, rest: columnFilters }
  }
  const { itemType, ...rest } = columnFilters
  if (typeof itemType === 'string') {
    return { requestedTypes: itemType.trim() ? [itemType.trim()] : null, rest }
  }
  if (Array.isArray(itemType)) {
    return { requestedTypes: itemType.length > 0 ? itemType : null, rest }
  }
  return { requestedTypes: null, rest }
}

const app = new Hono()

// GET /api/enterprise-search
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const { q, limit } = parseQuery(request, typeaheadQuerySchema)

      // Permission gate: the grouped fan-out is bounded by the types the
      // user may read, matching '/results'.
      const readable = await readableItemTypes(user.id)

      return await searchAcrossTypes(q, user.id, readable, limit)
    }),
  ),
)

// GET /api/enterprise-search/results — the paged grid behind the /search page
app.get(
  '/results',
  adapt(
    apiHandler(
      {
        openapi: {
          summary: 'Search all item types with paging, sorting and filters',
          description:
            'Flat, paged search across every item type the user may read, ' +
            'scoped to designs in their programs plus library designs. ' +
            'Sortable and filterable on base item columns; `program` and ' +
            '`design` column filters take ids. Rows carry the full base ' +
            'item record plus design and program identity.',
          request: { query: resultsQuerySchema },
          responses: {
            200: {
              schema: z.object({
                items: z.array(searchResultRowSchema),
                total: z.number(),
              }),
            },
          },
        },
      },
      async ({ request, user }) => {
        const params = parseQuery(request, resultsQuerySchema)

        let columnFilters: GlobalSearchCriteria['columnFilters']
        if (params.columnFilters) {
          try {
            columnFilters = JSON.parse(params.columnFilters)
          } catch {
            // Ignore invalid columnFilters JSON (matches the items route)
          }
        }
        const { requestedTypes, rest } = splitItemTypeFilter(columnFilters)

        // Permission gate: requested types are intersected with the types
        // the user may read; no request widens beyond the readable set.
        const readable = await readableItemTypes(user.id)
        const itemTypes = requestedTypes
          ? requestedTypes.filter((t) => readable.has(t))
          : [...readable]

        const accessScope = await AccessControlService.getAccessScope(user.id)

        return await ItemService.searchGlobal({
          query: params.globalSearch,
          itemTypes,
          accessScope,
          limit: params.limit,
          offset: params.offset,
          sortField: params.sortField,
          sortDirection: params.sortDirection,
          columnFilters: rest,
        })
      },
    ),
  ),
)

export default app
