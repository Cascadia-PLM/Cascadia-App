import { Hono } from 'hono'
import { and, asc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import { ZodError } from 'zod'
import { adapt } from '../adapter'
import type { ResourceType } from '@/lib/auth/permissions'
import type { BaseItem } from '@/lib/items/types/base'
import { requirePermission } from '@/lib/auth/server'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'
import { BranchService } from '@/lib/services/BranchService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { RequirementService } from '@/lib/services/RequirementService'
import { UsageService } from '@/lib/services/UsageService'
import {
  ImpactAnalysisService,
  impactAnalysisRequestSchema,
} from '@/lib/services/ImpactAnalysisService'
import { apiHandler, created, jsonResponse } from '@/lib/api/handler'
import { requireBranchAccess, requireDesignAccess } from '@/lib/auth/access'
import {
  batchCreateRequestSchema,
  calculateLockDuration,
  createLockedStatus, createUnlockedStatus 
} from '@/lib/api'
import {
  batchCheckinRequestSchema,
  batchCheckoutRequestSchema,
  batchDeleteRequestSchema,
  batchUpdateRequestSchema,
} from '@/lib/api/schemas'
import { FileService } from '@/lib/vault/services/FileService'
import { db } from '@/lib/db'
import {
  changeOrders,
  documents,
  itemRelationships,
  items,
  parts,
  requirements,
  tasks,
  users, vaultFiles 
} from '@/lib/db/schema'
import { designs } from '@/lib/db/schema/designs'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

// Map item types to permission resource types
function getResourceType(itemType: string): ResourceType {
  const mapping: Record<string, ResourceType> = {
    Part: 'parts',
    Document: 'documents',
    ChangeOrder: 'change_orders',
    Requirement: 'requirements',
    Task: 'tasks',
    TestPlan: 'test_plans',
    TestCase: 'test_cases',
  }
  return mapping[itemType] || 'parts'
}

/** Map item type to RBAC resource type */
function itemTypeToResource(itemType: string): ResourceType | null {
  const map: Record<string, ResourceType> = {
    Part: 'parts',
    Document: 'documents',
    ChangeOrder: 'change_orders',
    Requirement: 'requirements',
    Task: 'tasks',
    WorkInstruction: 'work_instructions',
    Issue: 'issues',
  }
  return map[itemType] ?? null
}

type DesignScope = 'current' | 'all' | 'library'

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
  rows: Array<T>,
  contextDesignId?: string,
) {
  const designIds = [
    ...new Set(
      rows
        .map((i) => i.designId)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ]

  if (designIds.length === 0) {
    return rows.map((item) => ({
      ...item,
      designCode: null,
      designName: null,
      isExternal: false,
    }))
  }

  const designsData = await db
    .select({ id: designs.id, code: designs.code, name: designs.name })
    .from(designs)
    .where(inArray(designs.id, designIds))

  const designMap = new Map(
    designsData.map((d) => [d.id, { code: d.code, name: d.name }]),
  )

  return rows.map((item) => {
    const design = item.designId ? designMap.get(item.designId) : null
    return {
      ...item,
      designCode: design?.code ?? null,
      designName: design?.name ?? null,
      isExternal: contextDesignId ? item.designId !== contextDesignId : false,
    }
  })
}

// Extended item type that includes usageOf field from database
interface ItemWithUsage {
  id?: string
  masterId?: string
  designId?: string | null
  itemNumber?: string
  revision: string
  itemType: string
  name?: string
  state?: string
  usageOf?: string | null
}

interface GraphNode {
  id: string
  type: 'itemNode'
  data: {
    itemId: string
    itemNumber: string
    revision: string
    itemType: string
    name: string
    state: string
    level: number // 0 = center, 1 = direct relation, 2 = second-level relation
    // Definition/Usage pattern fields
    isDefinition: boolean
    isUsage: boolean
    usageCount?: number // For definitions: how many usages reference this
    definitionItemNumber?: string // For usages: the item number of the definition
    isCrossDesign?: boolean // True if item is in a different design than the center item
    designCodes?: Array<string> // Design code(s) for cross-design items
  }
  position: { x: number; y: number }
}

interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
  data: {
    relationshipType: string
    quantity?: string | null
    referenceDesignator?: string | null
    findNumber?: number | null
    isUsageRelationship?: boolean // True for usageOf edges
  }
}

interface GraphData {
  nodes: Array<GraphNode>
  edges: Array<GraphEdge>
}

const VIEWABLE_CAD_EXTENSIONS = new Set(['stl', 'obj', 'glb', 'gltf'])

function isViewableCAD(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop()
  return ext !== undefined && VIEWABLE_CAD_EXTENSIONS.has(ext)
}

interface BatchCheckinResult {
  checkedIn: Array<{
    itemId: string
    masterId: string
  }>
  errors: Array<{
    itemId: string
    error: string
    details?: string
  }>
}

interface BatchCheckoutResult {
  checkedOut: Array<{
    itemId: string
    masterId: string
    branchItemId: string
  }>
  errors: Array<{
    itemId: string
    error: string
    details?: string
  }>
}

interface BatchCreateResponse {
  created: Array<BaseItem>
  errors: Array<{
    itemNumber: string
    error: string
    details?: string
  }>
}

interface BatchDeleteResult {
  deleted: Array<{
    id: string
    masterId: string
  }>
  errors: Array<{
    id: string
    error: string
    details?: string
  }>
}

interface BatchUpdateResult {
  updated: Array<BaseItem>
  errors: Array<{
    id: string
    error: string
    details?: string
  }>
}

const app = new Hono()

// =============================================
// Static routes MUST come before parameterized
// =============================================

// GET /api/items/search
app.get(
  '/search',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
      const q = url.searchParams.get('q')
      const itemType = url.searchParams.get('itemType')
      const query = url.searchParams.get('query') || undefined
      const state = url.searchParams.get('state') || undefined
      const limit = parseInt(url.searchParams.get('limit') || '50')
      const designScope = url.searchParams.get(
        'designScope',
      ) as DesignScope | null
      const contextDesignId =
        url.searchParams.get('contextDesignId') || undefined
      const designIdsParam = url.searchParams.get('designIds') || undefined

      // If 'q' is provided, use searchByItemNumber for autocomplete
      if (q) {
        const itemTypes = url.searchParams
          .get('types')
          ?.split(',')
          .filter(Boolean)

        // Get design filter based on scope
        let designIds: Array<string> | undefined
        if (designIdsParam) {
          // Explicit designIds param takes precedence (e.g., from breadcrumb program filter)
          designIds = designIdsParam.split(',').filter(Boolean)
        } else if (designScope === 'current' && contextDesignId) {
          designIds = [contextDesignId]
        } else if (designScope === 'library') {
          const stdLib = await DesignService.getStandardLibrary()
          designIds = stdLib ? [stdLib.id] : []
        } else if (designScope === 'all') {
          designIds = await getAccessibleDesignIds(user.id)
        }

        const searchResults = await ItemService.searchByItemNumber(q, {
          limit,
          itemTypes,
          designIds,
        })

        const enrichedItems = await enrichWithDesignMetadata(
          searchResults,
          contextDesignId,
        )

        return { items: enrichedItems }
      }

      // Otherwise, use the original search with itemType required
      if (!itemType) {
        throw new ValidationError('itemType or q parameter is required')
      }

      // Get design filter based on scope
      let designId: string | undefined
      let designIds: Array<string> | undefined

      if (designIdsParam) {
        // Explicit designIds param takes precedence
        designIds = designIdsParam.split(',').filter(Boolean)
      } else if (designScope === 'current' && contextDesignId) {
        designId = contextDesignId
      } else if (designScope === 'library') {
        const stdLib = await DesignService.getStandardLibrary()
        designId = stdLib?.id
      } else if (designScope === 'all') {
        designIds = await getAccessibleDesignIds(user.id)
      }

      const results = await ItemService.search(itemType, {
        query,
        state,
        limit,
        designId,
        designIds,
      })

      // Enrich with design metadata
      const enrichedItems = await enrichWithDesignMetadata(
        results.items,
        contextDesignId,
      )

      return { items: enrichedItems, total: results.total }
    }),
  ),
)

// POST /api/items/batch-checkin
app.post(
  '/batch-checkin',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      // Parse and validate request body
      const body = await request.json()
      const parseResult = batchCheckinRequestSchema.safeParse(body)

      if (!parseResult.success) {
        throw ValidationError.fromZodError(parseResult.error)
      }

      const { itemIds, branchId } = parseResult.data

      // Limit batch size to prevent abuse
      if (itemIds.length > 100) {
        throw new ValidationError('Batch size limited to 100 items')
      }

      // Verify branch exists and user has access
      await requireBranchAccess(user.id, branchId)

      const checkedIn: Array<{ itemId: string; masterId: string }> = []
      const errors: Array<{
        itemId: string
        error: string
        details?: string
      }> = []

      // Process each item
      for (const itemId of itemIds) {
        try {
          // Get the item to retrieve masterId
          const item = await ItemService.findById(itemId)
          if (!item) {
            errors.push({
              itemId,
              error: 'Item not found',
            })
            continue
          }

          if (!item.masterId) {
            errors.push({
              itemId,
              error: 'Item has no masterId',
            })
            continue
          }

          // Check in the item (release checkout but keep changes)
          await CheckoutService.checkin(item.masterId, branchId, user.id)

          checkedIn.push({
            itemId,
            masterId: item.masterId,
          })
        } catch (error) {
          errors.push({
            itemId,
            error: 'Failed to checkin item',
            details: (error as Error).message,
          })
        }
      }

      const result: BatchCheckinResult = {
        checkedIn,
        errors,
      }

      // Return 207 Multi-Status if there are both successes and errors
      // Return 200 OK if all succeeded
      // Return 400 Bad Request if all failed
      let status = 200
      if (errors.length > 0 && checkedIn.length > 0) {
        status = 207 // Multi-Status
      } else if (errors.length > 0 && checkedIn.length === 0) {
        status = 400
      }

      return jsonResponse(result, status)
    }),
  ),
)

// POST /api/items/batch-checkout
app.post(
  '/batch-checkout',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      // Parse and validate request body
      const body = await request.json()
      const parseResult = batchCheckoutRequestSchema.safeParse(body)

      if (!parseResult.success) {
        throw ValidationError.fromZodError(parseResult.error)
      }

      const { itemIds, branchId } = parseResult.data

      // Limit batch size to prevent abuse
      if (itemIds.length > 100) {
        throw new ValidationError('Batch size limited to 100 items')
      }

      // Verify branch exists and user has access
      await requireBranchAccess(user.id, branchId)

      const checkedOut: Array<{
        itemId: string
        masterId: string
        branchItemId: string
      }> = []
      const errors: Array<{
        itemId: string
        error: string
        details?: string
      }> = []

      // Process each item
      for (const itemId of itemIds) {
        try {
          // Get the item to retrieve masterId
          const item = await ItemService.findById(itemId)
          if (!item) {
            errors.push({
              itemId,
              error: 'Item not found',
            })
            continue
          }

          if (!item.masterId) {
            errors.push({
              itemId,
              error: 'Item has no masterId',
            })
            continue
          }

          // Checkout the item
          const branchItem = await CheckoutService.checkout(
            { itemMasterId: item.masterId, branchId },
            user.id,
          )

          checkedOut.push({
            itemId,
            masterId: item.masterId,
            branchItemId: branchItem.id,
          })
        } catch (error) {
          errors.push({
            itemId,
            error: 'Failed to checkout item',
            details: (error as Error).message,
          })
        }
      }

      const result: BatchCheckoutResult = {
        checkedOut,
        errors,
      }

      // Return 207 Multi-Status if there are both successes and errors
      // Return 201 Created if all succeeded
      // Return 400 Bad Request if all failed
      let status = 201
      if (errors.length > 0 && checkedOut.length > 0) {
        status = 207 // Multi-Status
      } else if (errors.length > 0 && checkedOut.length === 0) {
        status = 400
      }

      return jsonResponse(result, status)
    }),
  ),
)

// POST /api/items/batch-create
app.post(
  '/batch-create',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const userId = user.id

      // Parse and validate request body
      const body = await request.json()
      const parseResult = batchCreateRequestSchema.safeParse(body)

      if (!parseResult.success) {
        throw ValidationError.fromZodError(parseResult.error)
      }

      const { items: requestItems, bypassBranchProtection } = parseResult.data

      if (requestItems.length > 100) {
        throw new ValidationError('Batch size limited to 100 items')
      }

      const createdItems: Array<BaseItem> = []
      const errors: Array<{
        itemNumber: string
        error: string
        details?: string
      }> = []

      for (const itemRequest of requestItems) {
        try {
          const { itemType, data } = itemRequest

          // Create the item using ItemService
          // Use createOnBranch if branchId is provided (for ECO/workspace branches)
          let createdItem: BaseItem
          const itemData = data as BaseItem & {
            branchId?: string
            commitMessage?: string
          }

          if (itemData.branchId) {
            const result = await ItemService.createOnBranch(
              itemType,
              itemData,
              itemData.branchId,
              itemData.commitMessage || `Created ${itemType}`,
              userId,
            )
            createdItem = result.item
          } else {
            createdItem = await ItemService.create(itemType, itemData, userId, {
              bypassBranchProtection,
            })
          }
          createdItems.push(createdItem)
        } catch (error) {
          const itemData = itemRequest.data as { itemNumber?: string }
          errors.push({
            itemNumber: itemData.itemNumber || 'unknown',
            error: 'Failed to create item',
            details: (error as Error).message,
          })
        }
      }

      const response: BatchCreateResponse = {
        created: createdItems,
        errors,
      }

      let status = 201
      if (errors.length > 0 && createdItems.length > 0) {
        status = 207
      } else if (errors.length > 0 && createdItems.length === 0) {
        status = 400
      }

      return jsonResponse(response, status)
    }),
  ),
)

// POST /api/items/batch-delete
app.post(
  '/batch-delete',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const userId = user.id

      // Parse and validate request body
      const body = await request.json()
      const parseResult = batchDeleteRequestSchema.safeParse(body)

      if (!parseResult.success) {
        throw ValidationError.fromZodError(parseResult.error)
      }

      const { itemIds, branchId, commitMessage } = parseResult.data

      // Limit batch size to prevent abuse
      if (itemIds.length > 100) {
        throw new ValidationError('Batch size limited to 100 items')
      }

      const deleted: Array<{ id: string; masterId: string }> = []
      const errors: Array<{ id: string; error: string; details?: string }> = []

      // Process each item
      for (const itemId of itemIds) {
        try {
          // Get the item to retrieve masterId
          const item = await ItemService.findById(itemId)
          if (!item) {
            errors.push({
              id: itemId,
              error: 'Item not found',
            })
            continue
          }

          if (!item.masterId) {
            errors.push({
              id: itemId,
              error: 'Item has no masterId',
            })
            continue
          }

          // Delete the item on the branch
          await ItemService.deleteOnBranch(
            item.masterId,
            branchId,
            commitMessage || `Batch delete: ${item.itemNumber}`,
            userId,
          )

          deleted.push({
            id: itemId,
            masterId: item.masterId,
          })
        } catch (error) {
          errors.push({
            id: itemId,
            error: 'Failed to delete item',
            details: (error as Error).message,
          })
        }
      }

      const result: BatchDeleteResult = {
        deleted,
        errors,
      }

      // Return 207 Multi-Status if there are both successes and errors
      // Return 200 OK if all succeeded
      // Return 400 Bad Request if all failed
      let status = 200
      if (errors.length > 0 && deleted.length > 0) {
        status = 207 // Multi-Status
      } else if (errors.length > 0 && deleted.length === 0) {
        status = 400
      }

      return jsonResponse(result, status)
    }),
  ),
)

// POST /api/items/batch-update
app.post(
  '/batch-update',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const userId = user.id

      // Parse and validate request body
      const body = await request.json()
      const parseResult = batchUpdateRequestSchema.safeParse(body)

      if (!parseResult.success) {
        throw ValidationError.fromZodError(parseResult.error)
      }

      const { items: requestItems, commitMessage } = parseResult.data

      if (requestItems.length > 100) {
        throw new ValidationError('Batch size limited to 100 items')
      }

      const updated: Array<BaseItem> = []
      const errors: Array<{ id: string; error: string; details?: string }> = []

      for (const itemRequest of requestItems) {
        try {
          const { id, data } = itemRequest

          // Build update data - spread item data and add commit message if provided
          const updateData: Record<string, unknown> = { ...data }
          if (commitMessage) {
            updateData.commitMessage = commitMessage
          }

          // Update the item using ItemService
          const updatedItem = await ItemService.update(
            id,
            updateData as Partial<BaseItem>,
            userId,
          )
          updated.push(updatedItem)
        } catch (error) {
          errors.push({
            id: itemRequest.id,
            error: 'Failed to update item',
            details: (error as Error).message,
          })
        }
      }

      const result: BatchUpdateResult = {
        updated,
        errors,
      }

      // Return 207 Multi-Status if there are both successes and errors
      // Return 200 OK if all succeeded
      // Return 400 Bad Request if all failed
      let status = 200
      if (errors.length > 0 && updated.length > 0) {
        status = 207 // Multi-Status
      } else if (errors.length > 0 && updated.length === 0) {
        status = 400
      }

      return jsonResponse(result, status)
    }),
  ),
)

// GET /api/items/by-filename/:filename
app.get(
  '/by-filename/:filename',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { filename } = params

      // Search for files matching the filename
      // Support both exact match and partial match
      const matchingFiles = await db
        .select({
          fileId: vaultFiles.id,
          fileName: vaultFiles.fileName,
          originalFileName: vaultFiles.originalFileName,
          itemId: vaultFiles.itemId,
        })
        .from(vaultFiles)
        .where(
          and(
            or(
              eq(vaultFiles.fileName, filename),
              eq(vaultFiles.originalFileName, filename),
              like(vaultFiles.fileName, `%${filename}%`),
              like(vaultFiles.originalFileName, `%${filename}%`),
            ),
            isNull(vaultFiles.deletedAt),
          ),
        )

      if (matchingFiles.length === 0) {
        return {
          items: [],
          exactMatch: null,
          message: 'No items found with matching filename',
        }
      }

      // Get unique item IDs
      const itemIds = [...new Set(matchingFiles.map((f) => f.itemId))]

      // Fetch item details
      const itemRecords = await db
        .select()
        .from(items)
        .where(
          and(
            or(...itemIds.map((itemId) => eq(items.id, itemId))),
            eq(items.isCurrent, true),
          ),
        )

      // Find exact match if any
      const exactMatchFile = matchingFiles.find(
        (f) => f.fileName === filename || f.originalFileName === filename,
      )

      const exactMatchItem = exactMatchFile
        ? itemRecords.find((item) => item.id === exactMatchFile.itemId)
        : null

      // Return results
      return {
        items: itemRecords,
        exactMatch: exactMatchItem || null,
        totalMatches: matchingFiles.length,
        matchingFiles: matchingFiles.map((f) => ({
          fileId: f.fileId,
          fileName: f.fileName,
          originalFileName: f.originalFileName,
          itemId: f.itemId,
        })),
      }
    }),
  ),
)

// =============================================
// Parameterized routes with :id
// =============================================

// GET /api/items - supports programId filter, server-side sorting/filtering,
// state counts (?includeCounts=true&countStates=Draft,InReview,Released)
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
      const designId = url.searchParams.get('designId')
      const programId = url.searchParams.get('programId')
      const branchName = url.searchParams.get('branch')
      const commitId = url.searchParams.get('commit')
      const tagId = url.searchParams.get('tag')
      const itemType = url.searchParams.get('itemType') || undefined
      const state = url.searchParams.get('state') || undefined
      const search = url.searchParams.get('search') || undefined
      const globalSearch = url.searchParams.get('globalSearch') || undefined
      const includeDeleted = url.searchParams.get('includeDeleted') === 'true'
      const limit = parseInt(url.searchParams.get('limit') || '100', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const sortField = url.searchParams.get('sortField') || undefined
      const sortDirection = (url.searchParams.get('sortDirection') ||
        undefined) as 'asc' | 'desc' | undefined
      const includeCounts = url.searchParams.get('includeCounts') === 'true'
      const countStates = url.searchParams.get('countStates')

      let columnFilters:
        | Record<string, string | Array<string> | { min?: number; max?: number }>
        | undefined
      const columnFiltersRaw = url.searchParams.get('columnFilters')
      if (columnFiltersRaw) {
        try {
          columnFilters = JSON.parse(columnFiltersRaw)
        } catch {
          // Invalid JSON — ignore
        }
      }

      // Resolve programId to designIds when no specific designId is set
      let resolvedDesignIds: Array<string> | undefined
      if (programId && !designId) {
        const programDesigns = await db
          .select({ id: designs.id })
          .from(designs)
          .where(eq(designs.programId, programId))
        resolvedDesignIds = programDesigns.map((d) => d.id)
        if (resolvedDesignIds.length === 0) {
          const result: Record<string, unknown> = { items: [], total: 0 }
          if (includeCounts && countStates) {
            const counts: Record<string, number> = {}
            for (const s of countStates.split(',')) counts[s.trim()] = 0
            result.counts = counts
          }
          return result
        }
      }

      // Version context path: designId + branch/commit/tag
      if (designId && (branchName || commitId || tagId)) {
        const design = await DesignService.getById(designId)
        if (!design) throw new NotFoundError('Design', designId)
        await requireDesignAccess(user.id, designId)

        let context = VersionResolver.parseContext({
          designId,
          commit: commitId || undefined,
          tag: tagId || undefined,
        })

        if (branchName && !commitId && !tagId) {
          context = await VersionResolver.resolveBranchContext(
            designId,
            branchName,
          )
        }

        if (!context) {
          context = { type: 'released', designId }
        }

        const result = await ItemService.listAtContext(designId, context, {
          itemType,
          state,
          search: search || globalSearch,
          includeDeleted,
          limit,
          offset,
        })

        const contextDescription =
          await VersionResolver.getContextDescription(context)

        const response: Record<string, unknown> = {
          items: result.items,
          total: result.total,
          context: contextDescription,
        }

        if (includeCounts && countStates) {
          const allItems = await ItemService.listAtContext(designId, context, {
            itemType,
            limit: 100000,
          })
          const counts: Record<string, number> = {}
          for (const s of countStates.split(',')) {
            const stateName = s.trim()
            counts[stateName] = allItems.items.filter(
              (i) => i.state === stateName,
            ).length
          }
          response.counts = counts
        }

        return response
      }

      // designId-only path (no version context)
      if (designId) {
        const design = await DesignService.getById(designId)
        if (!design) throw new NotFoundError('Design', designId)
        await requireDesignAccess(user.id, designId)

        let context = VersionResolver.parseContext({ designId })
        if (!context) {
          context = { type: 'released', designId }
        }

        const result = await ItemService.listAtContext(designId, context, {
          itemType,
          state,
          search: search || globalSearch,
          includeDeleted,
          limit,
          offset,
        })

        const contextDescription =
          await VersionResolver.getContextDescription(context)
        return {
          items: result.items,
          total: result.total,
          context: contextDescription,
        }
      }

      // No designId — use regular search (with optional programId→designIds filter)
      const result = await ItemService.search(itemType || 'Part', {
        query: search || globalSearch,
        state,
        limit,
        offset,
        designIds: resolvedDesignIds,
        sortField,
        sortDirection,
        columnFilters,
        globalSearch,
      })

      const response: Record<string, unknown> = {
        items: result.items,
        total: result.total,
      }

      if (includeCounts && countStates) {
        const stateNames = countStates.split(',').map((s) => s.trim())
        const countResults = await Promise.all(
          stateNames.map((stateName) =>
            ItemService.search(itemType || 'Part', {
              limit: 1,
              state: stateName,
              designIds: resolvedDesignIds,
            }),
          ),
        )
        const counts: Record<string, number> = {}
        for (let i = 0; i < stateNames.length; i++) {
          counts[stateNames[i]] = countResults[i].total
        }
        response.counts = counts
      }

      return response
    }),
  ),
)

// POST /api/items
app.post(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const data = await request.json()
      const { branchId, itemType, commitMessage, ...itemData } = data

      if (!itemType) {
        throw new ValidationError('itemType is required')
      }

      // Check permission based on item type
      const resourceType = getResourceType(itemType)
      await requirePermission(request, resourceType, 'create')

      // If branchId provided, create on that branch
      if (branchId) {
        // Get branch to check access
        const branch = await BranchService.getById(branchId)
        if (!branch) {
          throw new NotFoundError('Branch', branchId)
        }

        const design = await DesignService.getById(branch.designId)
        if (!design) {
          throw new NotFoundError('Design', branch.designId)
        }

        // Check user has access to this design
        await requireDesignAccess(user.id, design.id)

        const result = await ItemService.createOnBranch(
          itemType,
          itemData,
          branchId,
          commitMessage || `Created ${itemType} ${itemData.itemNumber}`,
          user.id,
        )

        return created({ item: result.item, commit: result.commit })
      }

      // No branchId: create directly on main (pre-release phase)
      const item = await ItemService.create(itemType, itemData, user.id)

      // Auto-start workflow for ChangeOrders
      if (itemType === 'ChangeOrder' && itemData.changeType) {
        const { ChangeOrderService } =
          await import('@/lib/items/services/ChangeOrderService')
        try {
          await ChangeOrderService.autoStartWorkflow(
            item.id,
            itemData.changeType,
            user.id,
          )
        } catch (workflowError) {
          // Log but don't fail the creation - workflow can be started manually
          console.warn(
            `Failed to auto-start workflow for ChangeOrder ${item.id}:`,
            workflowError,
          )
        }
      }

      return created({ item })
    }),
  ),
)

// GET /api/items/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const branchName = url.searchParams.get('branch')
      const commitId = url.searchParams.get('commit')
      const tagId = url.searchParams.get('tag')

      // First, get the item to determine its product and masterId
      const baseItem = await ItemService.findById(params.id)
      if (!baseItem) {
        throw new NotFoundError('Item', params.id)
      }

      // Check type-specific RBAC permission
      const resource = itemTypeToResource(baseItem.itemType)
      if (resource) {
        await requirePermission(request, resource, 'read')
      }

      // Check access if item is in a design
      if (baseItem.designId) {
        const design = await DesignService.getById(baseItem.designId)
        if (design?.programId) {
          const canAccess = await ProgramService.canUserAccess(
            user.id,
            design.programId,
          )
          if (!canAccess) {
            throw new PermissionDeniedError('item', 'read')
          }
        }
      }

      // If no version context specified, return the item as-is
      if (!branchName && !commitId && !tagId) {
        // Get usage count (number of items that reference this item via usageOf)
        const usageCountResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(items)
          .where(eq(items.usageOf, params.id))

        const usageCount = Number(usageCountResult[0]?.count ?? 0)

        return { item: { ...baseItem, usageCount } }
      }

      // Need designId for version context
      if (!baseItem.designId) {
        throw new ValidationError(
          'Item is not in a design, version context not available',
        )
      }

      // Determine version context
      let context = VersionResolver.parseContext({
        designId: baseItem.designId,
        commit: commitId || undefined,
        tag: tagId || undefined,
      })

      // If branch name is provided, resolve it
      if (branchName && !commitId && !tagId) {
        context = await VersionResolver.resolveBranchContext(
          baseItem.designId,
          branchName,
        )
      }

      if (!context) {
        throw new ValidationError('Could not resolve version context')
      }

      // Get item at specific context
      const item = await ItemService.getAtContext(
        baseItem.masterId!,
        baseItem.designId,
        context,
      )

      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Get context description
      const contextDescription =
        await VersionResolver.getContextDescription(context)

      return {
        item,
        context: contextDescription,
      }
    }),
  ),
)

// PUT /api/items/:id
app.put(
  '/:id',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId')

      const body = await request.json()
      const { commitMessage, ...changes } = body

      // Get the item
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check type-specific RBAC permission
      const resource = itemTypeToResource(item.itemType)
      if (resource) {
        await requirePermission(request, resource, 'update')
      }

      // If no branchId, use legacy update
      if (!branchId) {
        const updated = await ItemService.update(params.id, changes, user.id)
        return { item: updated }
      }

      // Check access to branch
      const branch = await BranchService.getById(branchId)
      if (!branch) {
        throw new NotFoundError('Branch', branchId)
      }

      const design = await DesignService.getById(branch.designId)
      if (design?.programId) {
        const canAccess = await ProgramService.canUserAccess(
          user.id,
          design.programId,
        )
        if (!canAccess) {
          throw new PermissionDeniedError('item', 'update')
        }
      }

      // Save changes via CheckoutService
      const result = await CheckoutService.saveChanges(
        {
          branchId,
          itemId: params.id,
          changes,
          commitMessage: commitMessage || `Updated ${item.itemNumber}`,
        },
        user.id,
      )

      return {
        item: result.item,
        commit: result.commit,
      }
    }),
  ),
)

// DELETE /api/items/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId')
      const commitMessage = url.searchParams.get('commitMessage')

      // Get the item
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check type-specific RBAC permission
      const resource = itemTypeToResource(item.itemType)
      if (resource) {
        await requirePermission(request, resource, 'delete')
      }

      // If no branchId, use legacy delete
      if (!branchId) {
        await ItemService.delete(params.id)
        return { success: true }
      }

      // Check access to branch
      const branch = await BranchService.getById(branchId)
      if (!branch) {
        throw new NotFoundError('Branch', branchId)
      }

      const design = await DesignService.getById(branch.designId)
      if (design?.programId) {
        const canAccess = await ProgramService.canUserAccess(
          user.id,
          design.programId,
        )
        if (!canAccess) {
          throw new PermissionDeniedError('item', 'delete')
        }
      }

      // Soft delete on branch
      const commit = await ItemService.deleteOnBranch(
        item.masterId!,
        branchId,
        commitMessage || `Deleted ${item.itemNumber}`,
        user.id,
      )

      return {
        success: true,
        commit,
      }
    }),
  ),
)

// GET /api/items/:id/at-context
app.get(
  '/:id/at-context',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const commitId = url.searchParams.get('commitId')
      const tagId = url.searchParams.get('tagId')
      const branchId = url.searchParams.get('branchId')

      // Get the base item to find masterId and designId
      const baseItem = await ItemService.findById(params.id)
      if (!baseItem) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to design
      if (baseItem.designId) {
        await requireDesignAccess(user.id, baseItem.designId)
      }

      const released = url.searchParams.get('released')

      // If no version context, return the base item
      // If released=true, resolve to the released/main version via VersionResolver
      let context:
        | { type: 'branch'; branchId: string }
        | { type: 'commit'; commitId: string }
        | { type: 'tag'; tagId: string }
        | { type: 'released'; designId: string }
        | undefined
      if (!commitId && !tagId && !branchId) {
        if (released === 'true' && baseItem.designId && baseItem.masterId) {
          context = { type: 'released', designId: baseItem.designId }
          // fall through to VersionResolver resolution below
        } else {
          return {
            item: baseItem,
            existsAtContext: true,
            resolvedItemId: baseItem.id,
          }
        }
      }

      // Need a design to resolve version context
      if (!baseItem.designId) {
        return {
          item: baseItem,
          existsAtContext: true,
          resolvedItemId: baseItem.id,
        }
      }

      // Build version context (if not already set by released=true above)
      if (!context) {
        if (commitId) {
          context = { type: 'commit', commitId }
        } else if (tagId) {
          context = { type: 'tag', tagId }
        } else if (branchId) {
          context = { type: 'branch', branchId }
        } else {
          context = { type: 'released', designId: baseItem.designId }
        }
      }

      // Get the item at the specified version context
      const itemAtContext = await VersionResolver.getItemAtContext(
        baseItem.masterId!,
        baseItem.designId,
        context,
      )

      if (!itemAtContext) {
        // Item didn't exist at this version
        return new Response(
          JSON.stringify({
            error: 'Item did not exist at this version',
            data: { item: null, existsAtContext: false },
          }),
          {
            status: 200, // Not 404 - the item exists, just not at this context
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      // Enrich with type-specific data
      let enrichedItem = { ...itemAtContext }

      if (itemAtContext.itemType === 'Part') {
        const partResults = await db
          .select()
          .from(parts)
          .where(eq(parts.itemId, itemAtContext.id))
        if (partResults[0]) {
          enrichedItem = { ...enrichedItem, ...partResults[0] }
        }
      }
      if (itemAtContext.itemType === 'Document') {
        const docResults = await db
          .select()
          .from(documents)
          .where(eq(documents.itemId, itemAtContext.id))
        if (docResults[0]) {
          enrichedItem = { ...enrichedItem, ...docResults[0] }
        }
      }
      if (itemAtContext.itemType === 'ChangeOrder') {
        const coResults = await db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, itemAtContext.id))
        if (coResults[0]) {
          enrichedItem = { ...enrichedItem, ...coResults[0] }
        }
      }
      if (itemAtContext.itemType === 'Requirement') {
        const reqResults = await db
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, itemAtContext.id))
        if (reqResults[0]) {
          enrichedItem = { ...enrichedItem, ...reqResults[0] }
        }
      }
      if (itemAtContext.itemType === 'Task') {
        const taskResults = await db
          .select()
          .from(tasks)
          .where(eq(tasks.itemId, itemAtContext.id))
        if (taskResults[0]) {
          enrichedItem = { ...enrichedItem, ...taskResults[0] }
        }
      }

      return {
        item: enrichedItem,
        existsAtContext: true,
        resolvedItemId: itemAtContext.id,
      }
    }),
  ),
)

// GET /api/items/:id/available-contexts
app.get(
  '/:id/available-contexts',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      // Get the item to find masterId and designId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to design
      if (item.designId) {
        await requireDesignAccess(user.id, item.designId)
      }

      // If no designId, return empty arrays - item is not versioned
      if (!item.designId) {
        return { branches: [], tags: [] }
      }

      // Get available contexts for the item
      const contexts = await VersionResolver.getAvailableContextsForItem(
        item.masterId!,
        item.designId,
      )

      return contexts
    }),
  ),
)

// POST /api/items/:id/cancel-checkout
app.post(
  '/:id/cancel-checkout',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const data = await request.json()
      const { branchId } = data

      if (!branchId) {
        throw new ValidationError('branchId is required')
      }

      // Get the item to get its masterId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to branch/design
      await requireBranchAccess(user.id, branchId)

      await CheckoutService.cancelCheckout(item.masterId!, branchId, user.id)

      return { success: true }
    }),
  ),
)

// POST /api/items/:id/checkin
app.post(
  '/:id/checkin',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const data = await request.json()
      const { branchId } = data

      if (!branchId) {
        throw new ValidationError('branchId is required')
      }

      // Get the item to get its masterId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to branch/design
      await requireBranchAccess(user.id, branchId)

      await CheckoutService.checkin(item.masterId!, branchId, user.id)

      return { success: true }
    }),
  ),
)

// GET /api/items/:id/checkout
app.get(
  '/:id/checkout',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId')

      if (!branchId) {
        throw new ValidationError('branchId query parameter is required')
      }

      // Get the item to get its masterId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to branch/design
      await requireBranchAccess(user.id, branchId)

      const status = await CheckoutService.getCheckoutStatus(
        item.masterId!,
        branchId,
      )

      return { status }
    }),
  ),
)

// POST /api/items/:id/checkout
app.post(
  '/:id/checkout',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const data = await request.json()
      const { branchId } = data

      if (!branchId) {
        throw new ValidationError('branchId is required')
      }

      // Get the item to get its masterId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to branch/design
      await requireBranchAccess(user.id, branchId)

      const branchItem = await CheckoutService.checkout(
        { itemMasterId: item.masterId!, branchId },
        user.id,
      )

      return created({ branchItem })
    }),
  ),
)

// DELETE /api/items/:id/checkout
app.delete(
  '/:id/checkout',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId')

      if (!branchId) {
        throw new ValidationError('branchId query parameter is required')
      }

      // Get the item to get its masterId
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      await CheckoutService.cancelCheckout(item.masterId!, branchId, user.id)

      return { success: true }
    }),
  ),
)

// GET /api/items/:id/graph
app.get(
  '/:id/graph',
  adapt(
    apiHandler({}, async ({ params, request }) => {
      const url = new URL(request.url)
      const depth = parseInt(url.searchParams.get('depth') || '2', 10)
      const direction = url.searchParams.get('direction') || 'all' // 'all', 'outgoing', 'incoming'
      const relationshipTypes =
        url.searchParams.get('types')?.split(',').filter(Boolean) || []
      const includeUsages = url.searchParams.get('includeUsages') !== 'false' // Default to true

      // Get the center item
      const centerItem = await ItemService.findById(params.id)
      if (!centerItem) {
        throw new NotFoundError('Item', params.id)
      }

      // Build graph data
      const graphData: GraphData = {
        nodes: [],
        edges: [],
      }

      // Store the center item's designId for cross-design detection
      const centerDesignId = centerItem.designId

      // Track visited items by itemNumber+designId to deduplicate revisions
      // but keep usages and definitions as separate nodes (they may share itemNumber)
      // Map (itemNumber + designId) -> canonical node ID
      const visitedItemKeys = new Map<string, string>()
      // Cache itemId -> composite key for edge remapping
      const itemIdToKey = new Map<string, string>()
      // Cache itemId -> designId for cross-design detection
      const itemIdToDesignId = new Map<string, string | null>()
      // Cache itemId -> usageOf for definition/usage detection
      const itemIdToUsageOf = new Map<string, string | null>()
      // Also track raw item IDs we've processed to avoid reprocessing
      const processedItemIds = new Set<string>()
      // Collect all relationships for edge creation after nodes are processed
      const collectedRelationships: Array<{
        sourceId: string
        targetId: string
        relationshipType: string
        quantity: string | null
        referenceDesignator: string | null
        findNumber: number | null
        isUsageRelationship?: boolean
      }> = []

      const itemsToProcess: Array<{ itemId: string; level: number }> = [
        { itemId: params.id, level: 0 },
      ]

      // Process items level by level
      while (itemsToProcess.length > 0) {
        const { itemId, level } = itemsToProcess.shift()!

        // Skip if already processed this specific item ID or beyond max depth
        if (processedItemIds.has(itemId) || level > depth) {
          continue
        }

        processedItemIds.add(itemId)

        // Get item details
        const baseItem = await ItemService.findById(itemId)
        if (!baseItem) continue

        // Cast to extended type that includes usageOf from database
        const item = baseItem as ItemWithUsage

        // Create composite key: itemNumber + designId
        // This ensures usages and definitions with same itemNumber but different designs
        // are treated as separate nodes
        const itemNumber = item.itemNumber ?? ''
        const designId = item.designId ?? 'no-design'
        const compositeKey = `${itemNumber}::${designId}`

        itemIdToKey.set(itemId, compositeKey)
        itemIdToDesignId.set(itemId, item.designId ?? null)
        itemIdToUsageOf.set(itemId, item.usageOf ?? null)

        // Check if we've already seen this item (same itemNumber + designId = different revision)
        const existingNodeId = visitedItemKeys.get(compositeKey)
        if (existingNodeId) {
          // We already have a node for this item in this design
          // Skip adding a duplicate node, but still process relationships
          // to find connected items (they'll be remapped to the canonical node)
        } else {
          // First time seeing this item in this design - add as canonical node
          visitedItemKeys.set(compositeKey, itemId)

          // Determine definition/usage status
          const isDefinition = UsageService.isDefinition(item)
          const isUsage = UsageService.isUsage(item)

          // Get usage count for definitions (only if showing usages)
          let usageCount: number | undefined
          if (isDefinition && includeUsages) {
            usageCount = await UsageService.getUsageCount(itemId)
          }

          // Get definition item number for usages
          let definitionItemNumber: string | undefined
          if (isUsage && item.usageOf) {
            const definition = await ItemService.findById(item.usageOf)
            if (definition) {
              definitionItemNumber = definition.itemNumber ?? undefined
            }
          }

          // Determine if cross-design
          const isCrossDesign =
            item.designId != null &&
            centerDesignId != null &&
            item.designId !== centerDesignId

          // Add node
          graphData.nodes.push({
            id: itemId,
            type: 'itemNode',
            data: {
              itemId: itemId, // Use the known itemId instead of item.id which may be undefined
              itemNumber: itemNumber,
              revision: item.revision,
              itemType: item.itemType,
              name: item.name || '',
              state: item.state || '',
              level,
              isDefinition,
              isUsage,
              usageCount,
              definitionItemNumber,
              isCrossDesign,
            },
            position: { x: 0, y: 0 }, // Will be calculated by layout algorithm
          })
        }

        // Get relationships based on direction filter
        let relationshipsQuery = db.select().from(itemRelationships)

        if (direction === 'outgoing') {
          // Only show relationships where this item is the source
          relationshipsQuery = relationshipsQuery.where(
            eq(itemRelationships.sourceId, itemId),
          ) as any
        } else if (direction === 'incoming') {
          // Only show relationships where this item is the target (where-used)
          relationshipsQuery = relationshipsQuery.where(
            eq(itemRelationships.targetId, itemId),
          ) as any
        } else {
          // Show both directions
          relationshipsQuery = relationshipsQuery.where(
            or(
              eq(itemRelationships.sourceId, itemId),
              eq(itemRelationships.targetId, itemId),
            ),
          ) as any
        }

        const relationships = await relationshipsQuery

        // Process each relationship
        for (const rel of relationships) {
          // Skip if relationship type filter is active and this type is not included
          if (
            relationshipTypes.length > 0 &&
            !relationshipTypes.includes(rel.relationshipType)
          ) {
            continue
          }

          // Collect relationship for later edge creation
          collectedRelationships.push({
            sourceId: rel.sourceId,
            targetId: rel.targetId,
            relationshipType: rel.relationshipType,
            quantity: rel.quantity,
            referenceDesignator: rel.referenceDesignator,
            findNumber: rel.findNumber,
            isUsageRelationship: false,
          })

          // Determine direction and queue related item
          const isSource = rel.sourceId === itemId
          const relatedItemId = isSource ? rel.targetId : rel.sourceId

          // Queue related item for processing at next level
          if (!processedItemIds.has(relatedItemId)) {
            itemsToProcess.push({
              itemId: relatedItemId,
              level: level + 1,
            })
          }
        }

        // Process usageOf relationships if enabled
        // The includeUsages param is the sole control for UsageOf edges
        // (client handles filtering UsageOf separately from regular relationship types)
        const shouldIncludeUsageOf = includeUsages

        if (shouldIncludeUsageOf) {
          // If this item is a usage, add edge from usage to definition
          // Note: We include usageOf edges for ALL directions (including 'incoming')
          // because the client visually swaps UsageOf edges so definitions appear
          // upstream of usages — so expanding "upstream" should show the definition.
          if (item.usageOf) {
            // Collect usageOf relationship (usage -> definition)
            collectedRelationships.push({
              sourceId: itemId,
              targetId: item.usageOf,
              relationshipType: 'UsageOf',
              quantity: null,
              referenceDesignator: null,
              findNumber: null,
              isUsageRelationship: true,
            })

            // Queue definition for processing
            if (!processedItemIds.has(item.usageOf)) {
              itemsToProcess.push({
                itemId: item.usageOf,
                level: level + 1,
              })
            }
          }

          // If this item is a definition, find all usages (incoming direction)
          if (UsageService.isDefinition(item) && direction !== 'outgoing') {
            const usages = await UsageService.getUsagesOfDefinition(itemId)
            for (const usage of usages) {
              // Collect usageOf relationship (usage -> definition)
              collectedRelationships.push({
                sourceId: usage.id,
                targetId: itemId,
                relationshipType: 'UsageOf',
                quantity: null,
                referenceDesignator: null,
                findNumber: null,
                isUsageRelationship: true,
              })

              // Queue usage for processing
              if (!processedItemIds.has(usage.id)) {
                itemsToProcess.push({
                  itemId: usage.id,
                  level: level + 1,
                })
              }
            }
          }
        }
      }

      // Enrich cross-design nodes with design codes
      const crossDesignIds = new Set<string>()
      for (const node of graphData.nodes) {
        if (node.data.isCrossDesign) {
          const designId = itemIdToDesignId.get(node.id)
          if (designId) crossDesignIds.add(designId)
        }
      }

      if (crossDesignIds.size > 0) {
        const designRows = await db
          .select({ id: designs.id, code: designs.code })
          .from(designs)
          .where(inArray(designs.id, [...crossDesignIds]))

        const designCodeMap = new Map(designRows.map((d) => [d.id, d.code]))

        for (const node of graphData.nodes) {
          if (node.data.isCrossDesign) {
            const designId = itemIdToDesignId.get(node.id)
            if (designId) {
              const code = designCodeMap.get(designId)
              if (code) node.data.designCodes = [code]
            }
          }
        }
      }

      // Second pass: add edges with remapped IDs using cached data
      const addedEdges = new Set<string>()
      for (const rel of collectedRelationships) {
        // Get composite keys from cache
        const sourceKey = itemIdToKey.get(rel.sourceId)
        const targetKey = itemIdToKey.get(rel.targetId)

        // If not in cache, we didn't process these items (shouldn't happen)
        if (!sourceKey || !targetKey) continue

        const canonicalSourceId = visitedItemKeys.get(sourceKey)
        const canonicalTargetId = visitedItemKeys.get(targetKey)

        // Only add edge if both endpoints have canonical nodes in our graph
        if (!canonicalSourceId || !canonicalTargetId) continue

        // Skip self-loops (can happen when remapping different revisions)
        if (canonicalSourceId === canonicalTargetId) continue

        // Create edge with canonical IDs
        const edgeId = `${canonicalSourceId}-${canonicalTargetId}-${rel.relationshipType}`
        if (!addedEdges.has(edgeId)) {
          addedEdges.add(edgeId)
          graphData.edges.push({
            id: edgeId,
            source: canonicalSourceId,
            target: canonicalTargetId,
            label: rel.isUsageRelationship ? 'usage of' : rel.relationshipType,
            data: {
              relationshipType: rel.relationshipType,
              quantity: rel.quantity,
              referenceDesignator: rel.referenceDesignator,
              findNumber: rel.findNumber,
              isUsageRelationship: rel.isUsageRelationship ?? false,
            },
          })
        }
      }

      // Return graphData directly as Response to preserve existing shape
      // (existing clients expect { nodes, edges } at the top level, not { data: { nodes, edges } })
       
      return new Response(JSON.stringify(graphData), {
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  ),
)

// GET /api/items/:id/history
app.get(
  '/:id/history',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const commitId = url.searchParams.get('commitId')
      const tagId = url.searchParams.get('tagId')
      const branchId = url.searchParams.get('branchId')

      // Get the item
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      // Check access to design
      if (item.designId) {
        await requireDesignAccess(user.id, item.designId)
      }

      // Get history - need designId
      if (!item.designId) {
        // Item not in a design yet - return empty history
        return { history: [] }
      }

      // Resolve the version context to a commit ID
      let untilCommitId: string | undefined
      if (commitId) {
        untilCommitId = commitId
      } else if (tagId) {
        // Get the commit ID from the tag
        const { tags } = await import('@/lib/db/schema')
        const [tag] = await db
          .select({ commitId: tags.commitId })
          .from(tags)
          .where(eq(tags.id, tagId))
        untilCommitId = tag.commitId
      } else if (branchId) {
        // Get the head commit ID from the branch
        const branch = await BranchService.getById(branchId)
        if (branch?.headCommitId) {
          untilCommitId = branch.headCommitId
        }
      }

      // designId and masterId are guaranteed to be non-null at this point (checked above)
      const history = await ItemService.getHistory(
        item.masterId!,
        item.designId,
        {
          untilCommitId,
          branchId: branchId || undefined,
        },
      )

      // Enrich with author information
      const authorIds = [...new Set(history.map((h) => h.commit.createdBy))]
      const authorsResult =
        authorIds.length > 0
          ? await db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, authorIds))
          : []
      const authorMap = new Map(authorsResult.map((a) => [a.id, a]))

      const enrichedHistory = history.map((entry) => ({
        ...entry,
        author: authorMap.get(entry.commit.createdBy) || null,
      }))

      return { history: enrichedHistory }
    }),
  ),
)

// POST /api/items/:id/impact-analysis
app.post(
  '/:id/impact-analysis',
  adapt(
    apiHandler({}, async ({ params, request }) => {
      // Parse and validate request body
      const body = await request.json()
      let validatedBody
      try {
        validatedBody = impactAnalysisRequestSchema.parse(body)
      } catch (error) {
        if (error instanceof ZodError) {
          throw ValidationError.fromZodError(error)
        }
        throw error
      }

      // Run impact analysis
      const result = await ImpactAnalysisService.analyze({
        itemId: params.id,
        ...validatedBody,
      })

      return result
    }),
  ),
)

// GET /api/items/:id/lock-status
app.get(
  '/:id/lock-status',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { id } = params

      // Get item with lock info
      const result = await db
        .select()
        .from(items)
        .where(eq(items.id, id))
        .limit(1)
      const item = result.at(0)

      if (!item) {
        throw new NotFoundError('Item', id)
      }

      // If not locked, return simple status
      if (!item.lockedBy) {
        const status = createUnlockedStatus('lock')
        return { lockStatus: status }
      }

      // Get user info for locked by user
      const userResult = await db
        .select()
        .from(users)
        .where(eq(users.id, item.lockedBy))
        .limit(1)
      const user = userResult.at(0)

      // Create locked status with unified schema
      const status = createLockedStatus({
        lockedBy: {
          id: item.lockedBy,
          name: user?.name ?? 'Unknown User',
          email: user?.email ?? 'unknown',
        },
        lockedAt: item.lockedAt ?? new Date(),
        lockType: 'lock',
        lockedFor: item.lockedAt
          ? calculateLockDuration(item.lockedAt)
          : undefined,
        scope: 'item',
      })

      return { lockStatus: status }
    }),
  ),
)

// POST /api/items/:id/lock
app.post(
  '/:id/lock',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const { id } = params
      const userId = user.id

      // Parse request body for force option
      const body = await request.json().catch(() => ({}))
      const force = body.force === true

      // Get current item
      const result = await db
        .select()
        .from(items)
        .where(eq(items.id, id))
        .limit(1)
      const item = result.at(0)

      if (!item) {
        throw new NotFoundError('Item', id)
      }

      // Check if already locked
      if (item.lockedBy) {
        // If locked by same user, return success
        if (item.lockedBy === userId) {
          return {
            success: true,
            message: 'Item already locked by you',
            lockedBy: userId,
            lockedAt: item.lockedAt,
          }
        }

        // If locked by another user and not forcing, return conflict
        if (!force) {
          const { ConflictError } = await import('@/lib/errors')
          throw new ConflictError('Item is already locked by another user')
        }

        // Force is true, admin override (TODO: check admin permissions)
      }

      // Lock the item
      const updateResult = await db
        .update(items)
        .set({
          lockedBy: userId,
          lockedAt: new Date(),
          modifiedBy: userId,
          modifiedAt: new Date(),
        })
        .where(eq(items.id, id))
        .returning()
      const updated = updateResult.at(0)

      return {
        success: true,
        message: 'Item locked successfully',
        lockedBy: updated?.lockedBy,
        lockedAt: updated?.lockedAt,
      }
    }),
  ),
)

// GET /api/items/:id/relationships
app.get(
  '/:id/relationships',
  adapt(
    apiHandler({}, async ({ params, request }) => {
      const url = new URL(request.url)
      const relationshipType = url.searchParams.get('type') || undefined
      const branchId = url.searchParams.get('branch') || undefined

      const relationships = branchId
        ? await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
            params.id,
            branchId,
            relationshipType,
          )
        : await ItemService.getRelationshipsWithDetails(
            params.id,
            relationshipType,
          )

      return { relationships }
    }),
  ),
)

// POST /api/items/:id/relationships
app.post(
  '/:id/relationships',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const data = await request.json()

      await ItemService.addRelationship(
        params.id,
        data.targetId,
        data.relationshipType,
        user.id,
        {
          quantity: data.quantity,
          referenceDesignator: data.referenceDesignator,
          findNumber: data.findNumber,
        },
      )

      return created({ success: true })
    }),
  ),
)

// GET /api/items/:id/satisfied-requirements
app.get(
  '/:id/satisfied-requirements',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { id } = params
      const satisfiedRequirements =
        await RequirementService.getRequirementsSatisfiedBy(id)

      return { requirements: satisfiedRequirements }
    }),
  ),
)

// POST /api/items/:id/sync-properties
app.post(
  '/:id/sync-properties',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const { id } = params
      const userId = user.id

      // Parse request body
      const body = await request.json()
      const { properties } = body

      if (!properties) {
        throw new ValidationError('Properties object is required')
      }

      // Get current item
      const result = await db
        .select()
        .from(items)
        .where(eq(items.id, id))
        .limit(1)
      const item = result.at(0)

      if (!item) {
        throw new NotFoundError('Item', id)
      }

      const updatedFields: Array<string> = []

      // Update base item properties
      const baseUpdates: any = {
        modifiedBy: userId,
        modifiedAt: new Date(),
      }

      if (properties.name !== undefined) {
        baseUpdates.name = properties.name
        updatedFields.push('name')
      }

      if (properties.state !== undefined) {
        baseUpdates.state = properties.state
        updatedFields.push('state')
      }

      // Update base item if there are changes
      if (Object.keys(baseUpdates).length > 2) {
        // More than just modifiedBy/modifiedAt
        await db.update(items).set(baseUpdates).where(eq(items.id, id))
      }

      // Update type-specific properties based on item type
      if (item.itemType === 'Part') {
        const partUpdates: any = {}

        if (properties.material !== undefined) {
          partUpdates.material = properties.material
          updatedFields.push('material')
        }

        if (properties.weight !== undefined) {
          partUpdates.weight = properties.weight.toString()
          updatedFields.push('weight')
        }

        if (properties.weightUnit !== undefined) {
          partUpdates.weightUnit = properties.weightUnit
          updatedFields.push('weightUnit')
        }

        if (properties.description !== undefined) {
          partUpdates.description = properties.description
          updatedFields.push('description')
        }

        if (properties.partType !== undefined) {
          partUpdates.partType = properties.partType
          updatedFields.push('partType')
        }

        if (properties.cost !== undefined) {
          partUpdates.cost = properties.cost.toString()
          updatedFields.push('cost')
        }

        if (properties.costCurrency !== undefined) {
          partUpdates.costCurrency = properties.costCurrency
          updatedFields.push('costCurrency')
        }

        if (properties.leadTimeDays !== undefined) {
          partUpdates.leadTimeDays = properties.leadTimeDays
          updatedFields.push('leadTimeDays')
        }

        // Update parts table if there are changes
        if (Object.keys(partUpdates).length > 0) {
          await db.update(parts).set(partUpdates).where(eq(parts.itemId, id))
        }
      }

      // TODO: Handle other item types (Documents, etc.)

      return {
        success: true,
        message: 'Properties synced successfully',
        updatedFields,
      }
    }),
  ),
)

// GET /api/items/:id/thumbnail
app.get(
  '/:id/thumbnail',
  adapt(
    apiHandler({ permission: ['parts', 'read'] }, async ({ params, user }) => {
      const { id } = params

      // Find any thumbnail for this item (primary model first, then fallback)
      const thumbnailFileId = await FileService.getItemThumbnailFileId(id)
      if (!thumbnailFileId) {
        return new Response(null, { status: 404 })
      }

      const thumbnailFile = await FileService.getFileMetadata(thumbnailFileId)
      if (!thumbnailFile) {
        return new Response(null, { status: 404 })
      }

      const data = await FileService.downloadFile(thumbnailFileId, user.id)

      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': data.length.toString(),
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }),
  ),
)

// POST /api/items/:id/unlock
app.post(
  '/:id/unlock',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const { id } = params
      const userId = user.id

      // Parse request body for force option
      const body = await request.json().catch(() => ({}))
      const force = body.force === true

      // Get current item
      const result = await db
        .select()
        .from(items)
        .where(eq(items.id, id))
        .limit(1)
      const item = result.at(0)

      if (!item) {
        throw new NotFoundError('Item', id)
      }

      // Check if item is locked
      if (!item.lockedBy) {
        return {
          success: true,
          message: 'Item is not locked',
        }
      }

      // Check if locked by current user or force unlock
      if (item.lockedBy !== userId && !force) {
        throw new PermissionDeniedError('item', 'unlock')
      }

      // Unlock the item
      await db
        .update(items)
        .set({
          lockedBy: null,
          lockedAt: null,
          modifiedBy: userId,
          modifiedAt: new Date(),
        })
        .where(eq(items.id, id))

      return {
        success: true,
        message: 'Item unlocked successfully',
      }
    }),
  ),
)

// GET /api/items/:id/where-used
app.get(
  '/:id/where-used',
  adapt(
    apiHandler({}, async ({ params, request }) => {
      const url = new URL(request.url, 'http://localhost')
      const maxDepthParam = url.searchParams.get('maxDepth')
      const maxDepth = maxDepthParam
        ? Math.min(Math.max(parseInt(maxDepthParam, 10) || 10, 1), 50)
        : 10

      const whereUsed = await ImpactAssessmentService.findWhereUsed(params.id, {
        maxDepth,
      })

      return {
        itemId: params.id,
        whereUsed,
        totalUsages: whereUsed.length,
      }
    }),
  ),
)

// =============================================
// Routes with :itemId parameter
// =============================================

// GET /api/items/:itemId/cad-files
app.get(
  '/:itemId/cad-files',
  adapt(
    apiHandler({}, async ({ request, params }) => {
      const { itemId } = params as { itemId: string }

      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId') || undefined
      const mainBranchId = url.searchParams.get('mainBranchId') || undefined
      const context = { branchId, mainBranchId }

      // 1. Fetch direct files from this item
      const directFiles = await FileService.listItemFilesAtContext(
        itemId,
        context,
        false,
      )

      const directCADFiles = directFiles
        .filter(
          (f) =>
            f.fileCategory === 'cad_model' && isViewableCAD(f.originalFileName),
        )
        .map((f) => ({
          id: f.id,
          fileName: f.originalFileName,
          fileType: f.originalFileName.toLowerCase().split('.').pop() || '',
          isPrimaryModel: f.isPrimaryModel,
          hasColors: (f as any).cadMetadata?.hasColors ?? false,
          source: 'direct' as const,
          sourceItemId: itemId,
          sourceItemNumber: null as string | null,
        }))

      // 2. Fetch "CAD Doc" relationships to find related Documents
      const relationships =
        await ItemRelationshipService.getRelationshipsWithDetails(
          itemId,
          'CAD Doc',
        )

      // 3. For each related Document, fetch its files
      const relatedCADFiles: Array<{
        id: string
        fileName: string
        fileType: string
        isPrimaryModel: boolean
        hasColors: boolean
        source: 'cad_doc'
        sourceItemId: string
        sourceItemNumber: string | null
      }> = []

      for (const rel of relationships) {
        if (!rel.targetItem) continue

        const docFiles = await FileService.listItemFilesAtContext(
          rel.targetId,
          context,
          false,
        )

        const viewable = docFiles
          .filter(
            (f) =>
              f.fileCategory === 'cad_model' &&
              isViewableCAD(f.originalFileName),
          )
          .map((f) => ({
            id: f.id,
            fileName: f.originalFileName,
            fileType: f.originalFileName.toLowerCase().split('.').pop() || '',
            isPrimaryModel: f.isPrimaryModel,
            hasColors: (f as any).cadMetadata?.hasColors ?? false,
            source: 'cad_doc' as const,
            sourceItemId: rel.targetId,
            sourceItemNumber: rel.targetItem!.itemNumber ?? null,
          }))

        relatedCADFiles.push(...viewable)
      }

      const allFiles = [...directCADFiles, ...relatedCADFiles]

      return {
        files: allFiles,
        directCount: directCADFiles.length,
        relatedCount: relatedCADFiles.length,
      }
    }),
  ),
)

// GET /api/items/:itemId/files
app.get(
  '/:itemId/files',
  adapt(
    apiHandler(
      { permission: ['documents', 'read'] },
      async ({ request, params }) => {
        const { itemId } = params as { itemId: string }

        // Parse query parameters for version context
        const url = new URL(request.url)
        const branchId = url.searchParams.get('branchId') || undefined
        const mainBranchId = url.searchParams.get('mainBranchId') || undefined

        // Use version-context-aware file listing if context provided
        const files = await FileService.listItemFilesAtContext(
          itemId,
          { branchId, mainBranchId },
          false,
        )

        return { files, count: files.length }
      },
    ),
  ),
)

// GET /api/items/:itemId/files/primary
app.get(
  '/:itemId/files/primary',
  adapt(
    apiHandler({ permission: ['documents', 'read'] }, async ({ params }) => {
      const { itemId } = params as { itemId: string }

      const file = await FileService.getPrimaryModel(itemId)

      if (!file) {
        return { hasPrimary: false, file: null }
      }

      return { hasPrimary: true, file }
    }),
  ),
)

// PUT /api/items/:itemId/files/primary
app.put(
  '/:itemId/files/primary',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const userId = user.id
      const { itemId } = params as { itemId: string }

      // Parse request body for fileId
      const body = await request.json()
      const { fileId } = body

      if (!fileId) {
        throw new ValidationError('fileId is required')
      }

      // Verify the file belongs to this item
      const file = await FileService.getFileMetadata(fileId)
      if (!file) {
        throw new NotFoundError('File', fileId)
      }

      if (file.itemId !== itemId) {
        throw new ValidationError('File does not belong to this item')
      }

      await FileService.setPrimaryModel(fileId, userId)

      return {
        success: true,
        message: 'Primary model set successfully',
        fileId,
      }
    }),
  ),
)

// POST /api/items/:itemId/files/upload
app.post(
  '/:itemId/files/upload',
  adapt(
    apiHandler(
      { permission: ['documents', 'update'] },
      async ({ request, params, user }) => {
        const { itemId } = params
        const userId = user.id

        // Parse multipart form data
        const formData = await request.formData()

        // Get branchId from form data (for version context)
        const branchId = formData.get('branchId')?.toString() || undefined

        const uploadedFiles: Array<any> = []

        // Process each file in the form data
        for (const [key, value] of formData.entries()) {
          if (value instanceof File) {
            // Convert File to Buffer
            const arrayBuffer = await value.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            // Get file metadata
            const metadata = {
              originalFileName: value.name,
              mimeType: value.type || 'application/octet-stream',
              size: value.size,
              description: formData.get(`${key}_description`)?.toString(),
            }

            // Upload file with branch context
            const fileRecord = await FileService.uploadFile({
              itemId,
              branchId,
              file: buffer,
              metadata,
              uploadedBy: userId,
            })

            uploadedFiles.push(fileRecord)
          }
        }

        if (uploadedFiles.length === 0) {
          throw new ValidationError('No files provided')
        }

        return created({
          files: uploadedFiles,
          count: uploadedFiles.length,
        })
      },
    ),
  ),
)

export default app
