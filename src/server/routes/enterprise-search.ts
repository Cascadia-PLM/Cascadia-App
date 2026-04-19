import { Hono } from 'hono'
import { eq, inArray, or } from 'drizzle-orm'
import { adapt } from '../adapter'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { ValidationError } from '@/lib/errors'
import { db } from '@/lib/db'
import { designs } from '@/lib/db/schema/designs'
import { ProgramService } from '@/lib/services/ProgramService'
import { apiHandler } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

/**
 * Get design IDs accessible to a user based on their program memberships
 * Returns design IDs from user's programs + library designs
 */
async function getAccessibleDesignIds(userId: string): Promise<Array<string>> {
  // Get user's programs
  const userPrograms = await ProgramService.listByUser(userId)
  const programIds = userPrograms.map((p) => p.id)

  // Get designs from user's programs + library designs (null programId with library type)
  const accessibleDesigns = await db
    .select({ id: designs.id })
    .from(designs)
    .where(
      or(
        programIds.length > 0
          ? inArray(designs.programId, programIds)
          : undefined,
        eq(designs.designType, 'Library'),
      ),
    )

  return accessibleDesigns.map((d) => d.id)
}

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
 * Search across multiple item types and return grouped results
 */
async function searchAcrossTypes(
  query: string,
  userId: string,
  limit: number = 50,
): Promise<{
  results: Array<{ itemType: string; items: Array<any>; total: number }>
}> {
  // Get all registered item types
  const allTypes = ItemTypeRegistry.getAllTypes()

  // Get accessible design IDs for the user
  const designIds = await getAccessibleDesignIds(userId)

  // Search each item type in parallel
  const searchPromises = allTypes.map(async (typeConfig) => {
    try {
      const results = await ItemService.searchByItemNumber(query, {
        limit,
        itemTypes: [typeConfig.name],
        designIds,
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

const app = new Hono()

// GET /api/enterprise-search
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
      const query = url.searchParams.get('q')
      const limit = parseInt(url.searchParams.get('limit') || '50')

      if (!query || query.trim().length === 0) {
        throw new ValidationError('Search query (q) is required')
      }

      const results = await searchAcrossTypes(query.trim(), user.id, limit)

      return results
    }),
  ),
)

export default app
