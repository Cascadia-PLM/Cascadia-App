// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { and, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm'
import { ZodError, z } from 'zod'
import { tagged } from '../adapter'
import type { ResourceType } from '@/lib/auth/permissions'
import type { BaseItem } from '@/lib/items/types/base'
import { requirePermission } from '@/lib/auth/server'
import { permissionService } from '@/lib/auth/permission-service'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import {
  ITEM_TYPE_RESOURCES,
  getResourceType,
  itemTypeToResource,
} from '@/lib/items/item-type-resources'
import { ItemService } from '@/lib/items/services/ItemService'
import { isBranchProtectionExempt } from '@/lib/items/branch-protection'
import { itemCreateRequestSchema } from '@/lib/items/item-create-request'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { enrichItemFromUrl } from '@/lib/items/enrichment/enrich-from-url'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { ImpactAssessmentService } from '@/lib/items/services/ImpactAssessmentService'
import { BranchService } from '@/lib/services/BranchService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { ModelVersionService } from '@/lib/services/ModelVersionService'
import { RequirementService } from '@/lib/services/RequirementService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { UsageService } from '@/lib/services/UsageService'
import {
  ImpactAnalysisService,
  impactAnalysisRequestSchema,
} from '@/lib/services/ImpactAnalysisService'
import {
  apiHandler,
  created,
  jsonResponse,
  parseQuery,
} from '@/lib/api/handler'
import {
  requireBranchAccess,
  requireDesignAccess,
  requireItemDesignAccess,
  requireItemIdsDesignAccess,
} from '@/lib/auth/access'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import {
  batchCreateRequestSchema,
  calculateLockDuration,
  createLockedStatus,
  createUnlockedStatus,
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
  branchItems,
  changeOrders,
  documents,
  itemRelationships,
  items,
  parts,
  physicalParts,
  requirements,
  tasks,
  users,
  vaultFiles,
  workOrders,
} from '@/lib/db/schema'
import { notDeleted } from '@/lib/db/filters'
import { designs } from '@/lib/db/schema/designs'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Items')

/**
 * Item types whose RBAC resource the user is allowed to read.
 * Exported for the enterprise-search results route, which gates the same way.
 */
export async function readableItemTypes(userId: string): Promise<Set<string>> {
  // Concurrent, not sequential: the checks are independent, and on a cold
  // permission cache an awaited loop costs one database round trip per item
  // type rather than one for the lot.
  const checks = await Promise.all(
    Object.entries(ITEM_TYPE_RESOURCES).map(
      async ([itemType, resource]) =>
        [
          itemType,
          await permissionService.canUser(userId, 'read', resource),
        ] as const,
    ),
  )
  return new Set(
    checks.filter(([, canRead]) => canRead).map(([itemType]) => itemType),
  )
}

type DesignScope = 'current' | 'all' | 'library'

/**
 * Query parameters for `GET /items/search`.
 *
 * `limit` is deliberately uncapped — the BOM target pickers already fetch 200
 * rows per scope, and bulk API-key clients page by raising it. It is still
 * validated as a positive integer, so `limit=-5` is a 400 rather than a
 * Postgres error and `limit=abc` no longer silently becomes the default.
 *
 * `limit` and `offset` are optional rather than defaulted here because the two
 * branches below have different natural page sizes (20 for the text search, 50
 * for the by-type search); each keeps its own fallback.
 *
 * Note this schema is intentionally non-strict. Unknown params are ignored
 * rather than rejected, because this is the frozen v1 contract and a 400 on an
 * unrecognised param would break third-party clients. Listing the accepted
 * params here — and in the OpenAPI snapshot CI enforces — is what makes a
 * misspelling like `type=` (instead of `types=`) reviewable.
 */
const itemSearchQuerySchema = z.object({
  q: z.string().min(1).optional(),
  itemType: z.string().min(1).optional(),
  types: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  designScope: z.enum(['current', 'all', 'library']).optional(),
  contextDesignId: z.string().min(1).optional(),
  designIds: z.string().min(1).optional(),
})

/**
 * The designs a search should look in, or `undefined` for no design filter.
 *
 * This is the *requested* scope only. It narrows within what the caller may
 * already read — the access scope is a second, independent filter passed as
 * `accessDesignIds`, so no value here can widen a search past the caller's
 * program memberships.
 *
 * A scope the caller asked for resolves to a list even when that list is
 * empty, and an empty list matches nothing downstream. "No designs matched"
 * must not fall through to "search every design" — that is how
 * `designScope=library` used to return the whole catalogue on an instance with
 * no Standard Library.
 */
async function resolveDesignScope(
  scope: DesignScope | null,
  contextDesignId: string | undefined,
  designIdsParam: string | undefined,
): Promise<Array<string> | undefined> {
  // Explicit designIds win (e.g. from the breadcrumb program filter)
  if (designIdsParam) return designIdsParam.split(',').filter(Boolean)
  if (!scope) return undefined

  switch (scope) {
    case 'current':
      return contextDesignId ? [contextDesignId] : []
    case 'library': {
      const stdLib = await DesignService.getStandardLibrary()
      return stdLib ? [stdLib.id] : []
    }
    // 'all' asks for no narrowing at all; the access scope still applies.
    case 'all':
      return undefined
  }
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

// Vault files attached to an item, rendered as leaf nodes hanging below it.
// Files are not items: they never enter the relationship walk and carry no
// expand state — the client renders them with a dedicated component.
interface FileGraphNode {
  id: string // vault file id
  type: 'fileNode'
  data: {
    fileId: string
    fileName: string
    fileSize: number
    mimeType: string
    fileCategory: string | null
    isPrimaryModel: boolean
    fileVersion: number
    level: number
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
    isPhysicalRelationship?: boolean // True for derived INSTANCE_OF/BUILDS edges
    isFileRelationship?: boolean // True for derived ATTACHED_FILE edges
  }
}

interface GraphData {
  nodes: Array<GraphNode | FileGraphNode>
  edges: Array<GraphEdge>
}

/**
 * Synthetic physical-domain edge types derived from columns rather than
 * stored relationships (physical_parts.partMasterId, work_orders.partId).
 * They are emitted in top-down display direction — part → instance and
 * part → work order — so the physical domain hangs below the design
 * domains and expanding a part downstream reveals it.
 */
const GRAPH_INSTANCE_OF = 'INSTANCE_OF'
const GRAPH_BUILDS = 'BUILDS'
/** Stored physical edges; always WO/PhysicalPart as edge source. */
const PHYSICAL_STORED_TYPES = ['Consumes', 'Produces', 'Evidences']
/**
 * Synthetic attachment edge from an item to a vault file it carries
 * (vault_files.itemId is a column, not a stored relationship). Emitted
 * top-down — item → file — so files hang below their owner and expanding
 * an item downstream reveals them. Opt-in via ?includeFiles=true.
 */
const GRAPH_ATTACHED_FILE = 'ATTACHED_FILE'

/** Display labels for derived edges (arrow reads source → target). */
const SYNTHETIC_EDGE_LABELS: Record<string, string> = {
  [GRAPH_INSTANCE_OF]: 'instance',
  [GRAPH_BUILDS]: 'built by',
  [GRAPH_ATTACHED_FILE]: 'file',
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

/**
 * An item row as the write paths return it. Passthrough because the
 * type-specific columns differ per item type and are merged in — the ones
 * named here are on every item, whatever its type, and a caller can rely on
 * them.
 */
const itemResponseSchema = z
  .object({
    id: z.string().uuid(),
    masterId: z.string().uuid(),
    itemNumber: z.string(),
    itemType: z.string(),
    revision: z.string(),
    state: z.string(),
  })
  .passthrough()

/**
 * A vault file row as the upload path returns it. Passthrough — the row
 * carries storage and CAD-metadata columns beyond the ones a caller needs.
 */
const vaultFileResponseSchema = z
  .object({
    id: z.string().uuid(),
    itemId: z.string().uuid(),
    branchId: z.string().uuid().nullable(),
    fileName: z.string(),
    originalFileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    fileHash: z.string().describe('SHA-256 of the stored bytes'),
    fileVersion: z.number().int(),
    isPrimaryModel: z.boolean().nullable(),
    isItemThumbnail: z.boolean(),
  })
  .passthrough()

/** The commit a branch write produces, as returned alongside the item. */
const commitSummarySchema = z
  .object({
    id: z.string().uuid(),
    message: z.string(),
  })
  .passthrough()

const app = new Hono()

// =============================================
// Static routes MUST come before parameterized
// =============================================

// GET /api/items/search
app.get(
  '/search',
  adapt(
    apiHandler(
      {
        openapi: {
          summary: 'Search items by free text or by item type',
          description:
            'Pass `q` for a ranked text search across item number and name, or `itemType` for a by-type search that also returns a `total`. `limit` is uncapped but must be a positive integer.',
          request: { query: itemSearchQuerySchema },
        },
      },
      async ({ request, user }) => {
        const {
          q,
          itemType,
          types,
          query,
          state,
          limit,
          offset,
          designScope,
          contextDesignId,
          designIds: designIdsParam,
        } = parseQuery(request, itemSearchQuerySchema)

        // If 'q' is provided, use searchByItemNumber for autocomplete
        if (q) {
          const requestedTypes = types?.split(',').filter(Boolean)

          // Restrict the search to item types the user can read. When the
          // full set is readable (every built-in role), pass the request
          // through unchanged.
          const readable = await readableItemTypes(user.id)
          let itemTypes = requestedTypes
          if (readable.size < Object.keys(ITEM_TYPE_RESOURCES).length) {
            itemTypes = (
              requestedTypes ?? Object.keys(ITEM_TYPE_RESOURCES)
            ).filter((t) => readable.has(t))
            if (itemTypes.length === 0) {
              return { items: [] }
            }
          }

          const designIds = await resolveDesignScope(
            designScope ?? null,
            contextDesignId,
            designIdsParam,
          )

          const searchResults = await ItemService.searchByItemNumber(q, {
            limit,
            offset,
            itemTypes,
            designIds,
            accessDesignIds: await AccessControlService.getAccessibleDesignIds(
              user.id,
            ),
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

        const typeResource = itemTypeToResource(itemType)
        if (typeResource) {
          await requirePermission(request, typeResource, 'read')
        }

        const designIds = await resolveDesignScope(
          designScope ?? null,
          contextDesignId,
          designIdsParam,
        )

        const results = await ItemService.search(itemType, {
          query,
          state,
          limit,
          offset,
          designIds,
          accessDesignIds: await AccessControlService.getAccessibleDesignIds(
            user.id,
          ),
        })

        // Enrich with design metadata
        const enrichedItems = await enrichWithDesignMetadata(
          results.items,
          contextDesignId,
        )

        return { items: enrichedItems, total: results.total }
      },
    ),
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

          // Released items get a branch working copy up front, same as the
          // single-item checkout route — edits must never target the shared
          // released row.
          const branch = await BranchService.getById(branchId)
          if (
            branch &&
            branch.branchType !== 'main' &&
            (await ChangeOrderService.inferChangeAction(
              item.itemType,
              item.state,
            )) === 'revise'
          ) {
            const [existingRow] = await db
              .select({ changeType: branchItems.changeType })
              .from(branchItems)
              .where(
                and(
                  eq(branchItems.branchId, branchId),
                  eq(branchItems.itemMasterId, item.masterId),
                ),
              )
              .limit(1)
            if (!existingRow || existingRow.changeType === null) {
              await ChangeOrderService.createRevisionWorkingCopy(
                item as unknown as typeof items.$inferSelect,
                branchId,
                user.id,
              )
            }
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

      // Gate every distinct item type up front, before any row is written —
      // a mixed batch must not half-apply and then 403.
      const requiredResources = new Set(
        requestItems.map((i) => getResourceType(i.itemType)),
      )
      for (const resource of requiredResources) {
        await requirePermission(request, resource, 'create')
      }

      // Writing directly to a protected branch is an admin override, not a
      // caller-supplied option.
      if (bypassBranchProtection) {
        await requirePermission(request, 'system', 'manage')
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
          const itemData = data as unknown as BaseItem & {
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

      // Verify branch exists and user has access
      await requireBranchAccess(user.id, branchId)

      // Resolve items first so type permissions are checked before any
      // deletion — a mixed batch must not half-apply and then 403.
      const resolvedItems = new Map<
        string,
        Awaited<ReturnType<typeof ItemService.findById>>
      >()
      const requiredResources = new Set<ResourceType>()
      for (const itemId of itemIds) {
        const item = await ItemService.findById(itemId)
        resolvedItems.set(itemId, item)
        if (item) {
          const resource = itemTypeToResource(item.itemType)
          if (resource) requiredResources.add(resource)
        }
      }
      for (const resource of requiredResources) {
        await requirePermission(request, resource, 'delete')
      }

      const deleted: Array<{ id: string; masterId: string }> = []
      const errors: Array<{ id: string; error: string; details?: string }> = []

      // Process each item
      for (const itemId of itemIds) {
        try {
          const item = resolvedItems.get(itemId) ?? null
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

      // Resolve item types first so permissions are checked before any
      // update — a mixed batch must not half-apply and then 403.
      const requiredResources = new Set<ResourceType>()
      for (const itemRequest of requestItems) {
        const item = await ItemService.findById(itemRequest.id)
        if (item) {
          const resource = itemTypeToResource(item.itemType)
          if (resource) requiredResources.add(resource)
        }
      }
      for (const resource of requiredResources) {
        await requirePermission(request, resource, 'update')
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
          const updatedItem = await ItemService.update(id, updateData, userId)
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
    apiHandler<{ filename: string }>({}, async ({ params }) => {
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
        | Record<
            string,
            string | Array<string> | { min?: number; max?: number }
          >
        | undefined
      const columnFiltersRaw = url.searchParams.get('columnFilters')
      if (columnFiltersRaw) {
        try {
          columnFilters = JSON.parse(columnFiltersRaw)
        } catch {
          // Invalid JSON — ignore
        }
      }

      // Type-scoped requests are gated on that type's read permission.
      // Untyped requests stay bounded by the design-access checks on each
      // path below (the no-design fallback defaults to Part and is gated
      // in place).
      if (itemType) {
        const typeResource = itemTypeToResource(itemType)
        if (typeResource) {
          await requirePermission(request, typeResource, 'read')
        }
      }

      // Resolve programId to designIds when no specific designId is set
      let resolvedDesignIds: Array<string> | undefined
      if (programId && !designId) {
        // Filtering by a program is a program-scoped read: a non-member
        // naming someone else's programId must be refused, not served.
        if (
          !(await AccessControlService.canAccessProgram(user.id, programId))
        ) {
          throw new PermissionDeniedError('program items', 'read')
        }
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

        const response: Record<string, unknown> = {
          items: result.items,
          total: result.total,
          context: contextDescription,
        }

        // Same rollup the explicit-version-context path above performs. It
        // was missing here, so a design-scoped list asking for counts got a
        // response with no `counts` key at all and rendered zeroes.
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

      // No designId — use regular search (with optional programId→designIds filter)
      if (!itemType) {
        // The fallback searches Parts when no type is given
        await requirePermission(request, 'parts', 'read')
      }
      // Nothing above narrowed this to a design the caller was checked
      // against, so the caller's own reach is the only bound left. Without
      // it this path listed every item in the instance.
      const accessDesignIds = await AccessControlService.getAccessibleDesignIds(
        user.id,
      )

      const result = await ItemService.search(itemType || 'Part', {
        query: search || globalSearch,
        state,
        limit,
        offset,
        designIds: resolvedDesignIds,
        accessDesignIds,
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
              accessDesignIds,
            }),
          ),
        )
        const counts: Record<string, number> = {}
        for (const [i, stateName] of stateNames.entries()) {
          counts[stateName] = countResults[i]!.total
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
    apiHandler(
      {
        openapi: {
          summary: 'Create an item of any type',
          description:
            'The body is the item type’s own schema plus an envelope of ' +
            '`branchId` and `commitMessage`; `itemType` selects which. ' +
            'Permission is checked against the resource that type maps to ' +
            '(`parts:create` for a Part, and so on).\n\n' +
            'The server-assigned fields — `id`, `masterId`, `isCurrent`, ' +
            '`createdAt`/`createdBy`, `modifiedAt`/`modifiedBy`, ' +
            '`lockedBy`/`lockedAt` — are absent from the schema below ' +
            'because sending them has no effect. A blank `itemNumber` is ' +
            'auto-generated, and an omitted `revision` is assigned from ' +
            'the type’s lifecycle — send one only to carry a source ' +
            'system’s.\n\n' +
            '`ChangeOrder` is not creatable here — an ECO is defined by the ' +
            'designs it affects, so it goes through ' +
            '`POST /api/v1/change-orders`. A `WorkInstruction` must name its ' +
            '`outputPartId` and takes that part’s design; any `designId` ' +
            'sent with it must agree.',
          request: { body: { schema: itemCreateRequestSchema } },
          responses: {
            201: {
              schema: z.object({
                item: itemResponseSchema,
                commit: commitSummarySchema.optional(),
              }),
              description:
                'The created item. `commit` is present only for a branch write.',
            },
          },
        },
      },
      async ({ request, user }) => {
        const data = await request.json()
        const { branchId, itemType, commitMessage, ...itemData } = data

        if (!itemType) {
          throw new ValidationError('itemType is required')
        }

        // Check permission based on item type
        const resourceType = getResourceType(itemType)
        await requirePermission(request, resourceType, 'create')

        // A work instruction has no design of its own — it borrows the one its
        // output part lives in, so parametric blocks, MBOM inheritance, and part
        // lookups all resolve in the right design. Resolved before the access
        // checks below so permission is evaluated against the design the work
        // instruction will actually land in, not one the caller supplied.
        if (itemType === 'WorkInstruction') {
          if (!itemData.outputPartId) {
            throw new ValidationError(
              'outputPartId is required: a work instruction must name the part it builds',
            )
          }
          const outputPart = await ItemService.findById(itemData.outputPartId)
          if (!outputPart || outputPart.itemType !== 'Part') {
            throw new NotFoundError('Part', itemData.outputPartId)
          }
          if (!outputPart.designId) {
            throw new ValidationError(
              `Part ${outputPart.itemNumber} is not in a design and cannot be a work instruction's output part`,
            )
          }
          itemData.designId = outputPart.designId
        }

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

          // createOnBranch takes the item's design from the branch, so an output
          // part living somewhere else would silently produce a work instruction
          // whose design and output part disagree.
          if (itemData.designId && itemData.designId !== branch.designId) {
            throw new ValidationError(
              'Output part belongs to a different design than the target branch',
            )
          }

          const result = await ItemService.createOnBranch(
            itemType,
            itemData,
            branchId,
            commitMessage || `Created ${itemType} ${itemData.itemNumber}`,
            user.id,
          )

          return created({ item: result.item, commit: result.commit })
        }

        // No branchId: create directly on main (pre-release phase).
        // This path historically skipped the design/program check entirely —
        // the branch path above has always had it — so any authenticated user
        // with the type-level create permission could write into any
        // program's designs.
        // A change order is defined by the designs it touches, and this route
        // has no way to take them — it creates one item. Creating one here left
        // an ECO linked to nothing, which is outside every program and so
        // visible to everyone; the `canCreateEco` check below it hung off
        // `itemData.designId`, which a real ECO never carries, and never ran.
        if (itemType === 'ChangeOrder') {
          throw new ValidationError(
            'Create change orders via POST /api/v1/change-orders, which takes the designs they affect',
          )
        }

        if (itemData.designId) {
          await requireDesignAccess(user.id, itemData.designId)
        }

        const item = await ItemService.create(itemType, itemData, user.id)

        return created({ item })
      },
    ),
  ),
)

// POST /api/items/enrich-from-url
// Parse a dropped web link into suggested field values + custom attributes.
// Returns { aiEnabled: false, link } when no AI provider is connected.
app.post(
  '/enrich-from-url',
  adapt(
    apiHandler(
      {
        openapi: {
          summary: 'Suggest item fields from a web link',
          request: {
            body: {
              schema: z.object({
                url: z.string().url(),
                itemType: z.enum(['Part', 'Tool']),
              }),
            },
          },
        },
      },
      async ({ request }) => {
        const body = await request.json()
        const { url, itemType } = body as {
          url?: unknown
          itemType?: unknown
        }

        if (typeof url !== 'string' || !url.trim()) {
          throw new ValidationError('url is required')
        }
        if (itemType !== 'Part' && itemType !== 'Tool') {
          throw new ValidationError('itemType must be "Part" or "Tool"')
        }

        // Gate on the same create permission used when creating the item.
        await requirePermission(request, getResourceType(itemType), 'create')

        return await enrichItemFromUrl({ url, itemType })
      },
    ),
  ),
)

// GET /api/items/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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

      // Check access if item is in a design. requireDesignAccess carries the
      // cross-program bypass — the previous inline membership check did not,
      // locking administrators out of items in programs they hadn't joined.
      if (baseItem.designId) {
        await requireDesignAccess(user.id, baseItem.designId)
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
        baseItem.masterId,
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
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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

// GET /api/items/:id/transitions
// Available lifecycle transitions for a Free-lifecycle item. Returns an
// empty list (with the lifecycleType) for ECO-controlled types so clients
// can hide the control.
app.get(
  '/:id/transitions',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params }) => {
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      const resource = itemTypeToResource(item.itemType)
      if (resource) {
        await requirePermission(request, resource, 'read')
      }

      return LifecycleService.getAvailableFreeTransitions(params.id)
    }),
  ),
)

// POST /api/items/:id/transition
// The only write path for manual item state changes: every transition a Free
// lifecycle declares, and the declared pre-release edges of a Driven lifecycle
// (review progress). The generic item update rejects state changes; released
// lineage is entered and left only at change-order release, and this endpoint
// refuses to cross that line.
app.post(
  '/:id/transition',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const body = await request.json()
      const toState = body.toState ?? body.toStateId
      if (!toState || typeof toState !== 'string') {
        throw new ValidationError('toState is required')
      }

      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      const resource = itemTypeToResource(item.itemType)
      if (resource) {
        await requirePermission(request, resource, 'update')
      }

      const transitioned = await LifecycleService.transitionFreeItem(
        params.id,
        toState,
        user.id,
        body.comments,
      )

      return { success: true, ...transitioned }
    }),
  ),
)

// DELETE /api/items/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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
        await ItemService.delete(params.id, user.id)
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
        item.masterId,
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
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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
        baseItem.masterId,
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
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
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
        item.masterId,
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
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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

      await CheckoutService.cancelCheckout(item.masterId, branchId, user.id)

      return { success: true }
    }),
  ),
)

// POST /api/items/:id/checkin
app.post(
  '/:id/checkin',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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

      await CheckoutService.checkin(item.masterId, branchId, user.id)

      return { success: true }
    }),
  ),
)

// GET /api/items/:id/checkout
app.get(
  '/:id/checkout',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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
        item.masterId,
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
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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

      // Checking out a Released item to a branch creates the working copy
      // up front, so every subsequent content edit (fields, relationships,
      // work-instruction steps) targets the branch-local copy — never the
      // shared released row. Rows already tracking a working copy are left
      // alone.
      // "Released" is whatever state the lifecycle revises from, not the
      // literal name — inferChangeAction reads the mappings.
      const branch = await BranchService.getById(branchId)
      if (
        branch &&
        branch.branchType !== 'main' &&
        (await ChangeOrderService.inferChangeAction(
          item.itemType,
          item.state,
        )) === 'revise'
      ) {
        const [existingRow] = await db
          .select({ changeType: branchItems.changeType })
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, branchId),
              eq(branchItems.itemMasterId, item.masterId),
            ),
          )
          .limit(1)
        if (!existingRow || existingRow.changeType === null) {
          await ChangeOrderService.createRevisionWorkingCopy(
            item as unknown as typeof items.$inferSelect,
            branchId,
            user.id,
          )
        }
      }

      const branchItem = await CheckoutService.checkout(
        { itemMasterId: item.masterId, branchId },
        user.id,
      )

      return created({ branchItem })
    }),
  ),
)

// GET /api/items/:id/edit-context
// Where does the edit lock for this item version live? Returns the branch
// carrying the lock (the working-copy branch, or unprotected main), current
// lock holder, and protection state — everything a detail page needs to
// drive its Edit button.
app.get(
  '/:id/edit-context',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Item', params.id)
      }

      const branchInfo = await ItemService.getItemBranchInfo(params.id)
      let lockBranchId: string | null = branchInfo?.branchId ?? null
      let branchType: string | null = branchInfo?.branchType ?? null
      let isMainProtected = false

      if (!branchInfo && item.designId) {
        // Exempt types (work instructions) take the lock on main regardless of
        // protection — they are editable there by design, so reporting main as
        // protected would push the client into a revise-through-an-ECO dialog
        // for an item that needs no ECO.
        isMainProtected = (await isBranchProtectionExempt(item.itemType))
          ? false
          : await BranchService.isMainBranchProtected(item.designId)
        if (!isMainProtected) {
          const mainBranch = await BranchService.getMainBranch(item.designId)
          lockBranchId = mainBranch?.id ?? null
          branchType = lockBranchId ? 'main' : null
        }
      }

      let checkedOutBy: {
        id: string
        name: string | null
        email: string
      } | null = null
      if (lockBranchId) {
        const status = await CheckoutService.getCheckoutStatus(
          item.masterId,
          lockBranchId,
        )
        checkedOutBy = status.checkedOutBy ?? null
      }

      return {
        editContext: {
          lockBranchId,
          branchType,
          isBranchLocked: branchInfo?.isLocked ?? false,
          isMainProtected,
          checkedOutBy,
          state: item.state,
          designId: item.designId ?? null,
        },
      }
    }),
  ),
)

// DELETE /api/items/:id/checkout
app.delete(
  '/:id/checkout',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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

      // Check access to branch/design (parity with the other checkout routes)
      await requireBranchAccess(user.id, branchId)

      await CheckoutService.cancelCheckout(item.masterId, branchId, user.id)

      return { success: true }
    }),
  ),
)

// GET /api/items/:id/graph
app.get(
  '/:id/graph',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request }) => {
      const url = new URL(request.url)
      const depth = parseInt(url.searchParams.get('depth') || '2', 10)
      const direction = url.searchParams.get('direction') || 'all' // 'all', 'outgoing', 'incoming'
      const relationshipTypes =
        url.searchParams.get('types')?.split(',').filter(Boolean) || []
      const includeUsages = url.searchParams.get('includeUsages') !== 'false' // Default to true
      // Attached vault files are opt-in so existing graph consumers keep
      // their item-only shape.
      const includeFiles = url.searchParams.get('includeFiles') === 'true'
      // Branch context for file visibility only (mirrors the Files tab:
      // branch-agnostic files plus files uploaded on the viewed branch).
      const fileBranchId = url.searchParams.get('branch')

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
        isPhysicalRelationship?: boolean
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
              definitionItemNumber = definition.itemNumber
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

        // Every row of this item's lineage. A stored edge names one item
        // *version*, and the row rendered here is often not the one it names,
        // so both the relationship walk below and the physical bridge further
        // down need to know which other rows stand for the same item.
        const lineageVersionIds = item.masterId
          ? (
              await db
                .select({ id: items.id })
                .from(items)
                .where(and(eq(items.masterId, item.masterId), notDeleted()))
            ).map((row) => row.id)
          : []
        const otherVersionIds = lineageVersionIds.filter((id) => id !== itemId)

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

        // Incoming edges pinned to another row of this lineage.
        //
        // A merge re-points only the lines owned by the items the change
        // order touched, so an assembly it never touched keeps naming the row
        // the release superseded. Matching the rendered row alone, expanding a
        // released revision upstream therefore found nothing that used it —
        // the revision looked unused the moment it was released. The lines are
        // read off the lineage's other rows and rendered against this one,
        // exactly as the physical bridge below already does for its own types.
        if (direction !== 'outgoing' && otherVersionIds.length > 0) {
          const pinnedIncoming = await db
            .select()
            .from(itemRelationships)
            .where(inArray(itemRelationships.targetId, otherVersionIds))

          for (const rel of pinnedIncoming) {
            // The physical bridge owns its own types, with its own flagging.
            if (PHYSICAL_STORED_TYPES.includes(rel.relationshipType)) continue
            if (
              relationshipTypes.length > 0 &&
              !relationshipTypes.includes(rel.relationshipType)
            ) {
              continue
            }

            collectedRelationships.push({
              sourceId: rel.sourceId,
              targetId: itemId,
              relationshipType: rel.relationshipType,
              quantity: rel.quantity,
              referenceDesignator: rel.referenceDesignator,
              findNumber: rel.findNumber,
              isUsageRelationship: false,
            })

            if (!processedItemIds.has(rel.sourceId)) {
              itemsToProcess.push({
                itemId: rel.sourceId,
                level: level + 1,
              })
            }
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

        // ---- Physical domain (work orders and physical parts) ----
        // Two gaps the stored-edge walk above cannot cover: derived links
        // (physical_parts.partMasterId, work_orders.partId are columns, not
        // relationships), and stored Consumes/Produces/Evidences edges that
        // pin an exact part *version row* other than the one rendered here.
        const typeAllowed = (relationshipType: string) =>
          relationshipTypes.length === 0 ||
          relationshipTypes.includes(relationshipType)

        const collectPhysical = (
          sourceId: string,
          targetId: string,
          relationshipType: string,
          quantity: string | null = null,
        ) => {
          collectedRelationships.push({
            sourceId,
            targetId,
            relationshipType,
            quantity,
            referenceDesignator: null,
            findNumber: null,
            isPhysicalRelationship:
              relationshipType === GRAPH_INSTANCE_OF ||
              relationshipType === GRAPH_BUILDS,
          })
          const relatedId = sourceId === itemId ? targetId : sourceId
          if (!processedItemIds.has(relatedId)) {
            itemsToProcess.push({ itemId: relatedId, level: level + 1 })
          }
        }

        if (item.itemType === 'WorkOrder') {
          // Bridge up to the exact part version this WO builds.
          if (direction !== 'outgoing' && typeAllowed(GRAPH_BUILDS)) {
            const [wo] = await db
              .select({ partId: workOrders.partId })
              .from(workOrders)
              .where(eq(workOrders.itemId, itemId))
              .limit(1)
            if (wo?.partId) {
              collectPhysical(wo.partId, itemId, GRAPH_BUILDS)
            }
          }
        } else if (item.itemType === 'PhysicalPart') {
          // Bridge up to the part this instance instantiates: the as-built
          // pin when recorded, else the lineage's current version.
          if (direction !== 'outgoing' && typeAllowed(GRAPH_INSTANCE_OF)) {
            const [pp] = await db
              .select({
                partMasterId: physicalParts.partMasterId,
                asBuiltItemId: physicalParts.asBuiltItemId,
              })
              .from(physicalParts)
              .where(eq(physicalParts.itemId, itemId))
              .limit(1)
            if (pp) {
              const [part] = pp.asBuiltItemId
                ? await db
                    .select({ id: items.id })
                    .from(items)
                    .where(and(eq(items.id, pp.asBuiltItemId), notDeleted()))
                    .limit(1)
                : await db
                    .select({ id: items.id })
                    .from(items)
                    .where(
                      and(
                        eq(items.masterId, pp.partMasterId),
                        eq(items.itemType, 'Part'),
                        eq(items.isCurrent, true),
                        notDeleted(),
                      ),
                    )
                    .limit(1)
              if (part) {
                collectPhysical(part.id, itemId, GRAPH_INSTANCE_OF)
              }
            }
          }
        } else if (item.masterId) {
          // Versioned design item: pick up stored physical edges pinned to
          // any OTHER version row of its lineage, re-pointed onto this
          // rendered row (matches ThreadService's lineage handling).
          if (direction !== 'outgoing' && otherVersionIds.length > 0) {
            const pinnedEdges = await db
              .select()
              .from(itemRelationships)
              .where(
                and(
                  inArray(itemRelationships.targetId, otherVersionIds),
                  inArray(
                    itemRelationships.relationshipType,
                    PHYSICAL_STORED_TYPES,
                  ),
                ),
              )
            for (const rel of pinnedEdges) {
              if (!typeAllowed(rel.relationshipType)) continue
              collectPhysical(
                rel.sourceId,
                itemId,
                rel.relationshipType,
                rel.quantity,
              )
            }
          }

          if (item.itemType === 'Part' && direction !== 'incoming') {
            // Physical instances of this lineage (units and lots).
            if (typeAllowed(GRAPH_INSTANCE_OF)) {
              const instances = await db
                .select({ itemId: physicalParts.itemId })
                .from(physicalParts)
                .innerJoin(items, eq(items.id, physicalParts.itemId))
                .where(
                  and(
                    eq(physicalParts.partMasterId, item.masterId),
                    notDeleted(),
                  ),
                )
              for (const instance of instances) {
                collectPhysical(itemId, instance.itemId, GRAPH_INSTANCE_OF)
              }
            }

            // Work orders building any version of this lineage.
            if (typeAllowed(GRAPH_BUILDS) && lineageVersionIds.length > 0) {
              const buildingWos = await db
                .select({ itemId: workOrders.itemId })
                .from(workOrders)
                .innerJoin(items, eq(items.id, workOrders.itemId))
                .where(
                  and(
                    inArray(workOrders.partId, lineageVersionIds),
                    notDeleted(),
                  ),
                )
              for (const wo of buildingWos) {
                collectPhysical(itemId, wo.itemId, GRAPH_BUILDS)
              }
            }
          }
        }

        // ---- Attached vault files ----
        // Files hang off the canonical (first-rendered) row of an item, so
        // the listing matches what the item's Files tab shows when the user
        // clicks through. Like item edges, files sit one level below their
        // owner: frontier items (level === depth) contribute none — their
        // files appear when the node is drilled down (expanded) instead.
        if (
          includeFiles &&
          !existingNodeId &&
          direction !== 'incoming' &&
          level < depth &&
          typeAllowed(GRAPH_ATTACHED_FILE)
        ) {
          const fileConditions = [
            eq(vaultFiles.itemId, itemId),
            eq(vaultFiles.isLatestVersion, true),
            isNull(vaultFiles.deletedAt),
            // Generated thumbnails are internal artifacts, not attachments
            or(
              isNull(vaultFiles.fileCategory),
              ne(vaultFiles.fileCategory, 'thumbnail'),
            ),
          ]
          if (fileBranchId) {
            fileConditions.push(
              or(
                isNull(vaultFiles.branchId),
                eq(vaultFiles.branchId, fileBranchId),
              ),
            )
          }

          const attachedFiles = await db
            .select()
            .from(vaultFiles)
            .where(and(...fileConditions))

          for (const file of attachedFiles) {
            graphData.nodes.push({
              id: file.id,
              type: 'fileNode',
              data: {
                fileId: file.id,
                fileName: file.originalFileName,
                fileSize: file.fileSize,
                mimeType: file.mimeType,
                fileCategory: file.fileCategory,
                isPrimaryModel: file.isPrimaryModel ?? false,
                fileVersion: file.fileVersion,
                level: level + 1,
              },
              position: { x: 0, y: 0 },
            })
            // File edges skip the second-pass remap below: each file
            // belongs to exactly one item row, canonical here since
            // !existingNodeId, and file nodes need no key bookkeeping.
            graphData.edges.push({
              id: `${itemId}-${file.id}-${GRAPH_ATTACHED_FILE}`,
              source: itemId,
              target: file.id,
              label: SYNTHETIC_EDGE_LABELS[GRAPH_ATTACHED_FILE],
              data: {
                relationshipType: GRAPH_ATTACHED_FILE,
                isFileRelationship: true,
              },
            })
          }
        }
      }

      // Enrich cross-design nodes with design codes
      const crossDesignIds = new Set<string>()
      for (const node of graphData.nodes) {
        if (node.type === 'itemNode' && node.data.isCrossDesign) {
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
          if (node.type === 'itemNode' && node.data.isCrossDesign) {
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
            label: rel.isUsageRelationship
              ? 'usage of'
              : (SYNTHETIC_EDGE_LABELS[rel.relationshipType] ??
                rel.relationshipType),
            data: {
              relationshipType: rel.relationshipType,
              quantity: rel.quantity,
              referenceDesignator: rel.referenceDesignator,
              findNumber: rel.findNumber,
              isUsageRelationship: rel.isUsageRelationship ?? false,
              isPhysicalRelationship: rel.isPhysicalRelationship ?? false,
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
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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
        if (!tag) throw new NotFoundError('Tag', tagId)
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
        item.masterId,
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
    apiHandler<{ id: string }>({}, async ({ params, request }) => {
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
    apiHandler<{ id: string }>({}, async ({ params }) => {
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
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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

        // Stealing another user's lock is an admin override
        await requirePermission(request, 'system', 'manage')
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
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      z.string().uuid().parse(params.id)
      const url = new URL(request.url)
      const relationshipType = url.searchParams.get('type') || undefined
      const branchId = url.searchParams.get('branch') || undefined

      const source = await ItemService.findById(params.id)
      if (!source) throw new NotFoundError('Item', params.id)
      await requirePermission(request, getResourceType(source.itemType), 'read')
      await requireItemDesignAccess(user.id, source)

      if (branchId) {
        z.string().uuid().parse(branchId)
        const branchAccess = await requireBranchAccess(user.id, branchId)
        if (source.designId !== branchAccess.designId) {
          throw new ValidationError(
            'Branch belongs to a different design than the source item',
          )
        }
      }

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

      const targetsById = await requireItemIdsDesignAccess(
        user.id,
        relationships.map((relationship) => relationship.targetItem!.id),
      )
      const targetResources = new Set(
        [...targetsById.values()].map((item) => getResourceType(item.itemType)),
      )
      for (const resource of targetResources) {
        await requirePermission(request, resource, 'read')
      }

      return { relationships }
    }),
  ),
)

/**
 * One edge, added to the item named in the path. The batch equivalent is
 * `POST /api/v1/relationships/batch-create`.
 */
const addRelationshipSchema = z.object({
  targetId: z.string().uuid(),
  relationshipType: z
    .string()
    .describe('e.g. `BOM`, `Document`, `Satisfies`, `Consumes`'),
  quantity: z
    .union([z.number(), z.string()])
    .optional()
    .describe(
      'Stored as text, so a string arrives verbatim — BOM quantities are ' +
        'not all integers.',
    ),
  referenceDesignator: z.string().optional(),
  findNumber: z.number().optional(),
})

// POST /api/items/:id/relationships
app.post(
  '/:id/relationships',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Add a relationship from this item',
          description:
            'The path item is the edge source. `(sourceId, targetId, ' +
            'relationshipType)` is unique, so re-adding an existing edge ' +
            'fails rather than duplicating it.',
          request: {
            params: z.object({ id: z.string().uuid() }),
            body: { schema: addRelationshipSchema },
          },
          responses: {
            201: { schema: z.object({ success: z.boolean() }) },
          },
        },
      },
      async ({ params, request, user }) => {
        z.string().uuid().parse(params.id)
        const data = addRelationshipSchema.parse(await request.json())
        const itemsById = await requireItemIdsDesignAccess(user.id, [
          params.id,
          data.targetId,
        ])
        const source = itemsById.get(params.id)!
        const target = itemsById.get(data.targetId)!
        await requirePermission(
          request,
          getResourceType(source.itemType),
          'update',
        )
        await requirePermission(
          request,
          getResourceType(target.itemType),
          'read',
        )

        await ItemService.addRelationship(
          params.id,
          data.targetId,
          data.relationshipType,
          user.id,
          {
            quantity:
              data.quantity === undefined ? undefined : String(data.quantity),
            referenceDesignator: data.referenceDesignator,
            findNumber: data.findNumber,
          },
        )

        return created({ success: true })
      },
    ),
  ),
)

// GET /api/items/:id/satisfied-requirements
app.get(
  '/:id/satisfied-requirements',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const { id } = params
      z.string().uuid().parse(id)
      const source = await ItemService.findById(id)
      if (!source) throw new NotFoundError('Item', id)
      await requirePermission(request, getResourceType(source.itemType), 'read')
      await requireItemDesignAccess(user.id, source)
      await requirePermission(request, 'requirements', 'read')

      const satisfiedRequirements =
        await RequirementService.getRequirementsSatisfiedBy(id)
      await requireItemIdsDesignAccess(
        user.id,
        satisfiedRequirements.map((requirement) => requirement.id),
      )

      return { requirements: satisfiedRequirements }
    }),
  ),
)

// POST /api/items/:id/sync-properties
app.post(
  '/:id/sync-properties',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
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
    apiHandler<{ id: string }>(
      { permission: ['parts', 'read'] },
      async ({ request, params, user }) => {
        const { id } = params

        // Resolve the thumbnail: user-designated image first, then generated
        const thumbnailFileId = await FileService.getItemThumbnailFileId(id)
        if (!thumbnailFileId) {
          return new Response(null, { status: 404 })
        }

        const thumbnailFile = await FileService.getFileMetadata(thumbnailFileId)
        if (!thumbnailFile) {
          return new Response(null, { status: 404 })
        }

        // Content-addressed validator: changing the designated image changes the
        // hash, so clients pick up a new thumbnail on their next revalidation.
        const etag = `"${thumbnailFile.fileHash}"`

        // Never echo back an arbitrary stored MIME type - thumbnails render
        // inline, so restrict to raster image types
        const mimeType =
          thumbnailFile.mimeType.startsWith('image/') &&
          !thumbnailFile.mimeType.includes('svg')
            ? thumbnailFile.mimeType
            : 'image/png'

        const headers = {
          'Content-Type': mimeType,
          ETag: etag,
          // Authenticated content: never store in a shared cache, and always
          // revalidate so a newly set thumbnail is not served stale
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        }

        if (request.headers.get('if-none-match') === etag) {
          return new Response(null, { status: 304, headers })
        }

        const data = await FileService.downloadFile(thumbnailFileId, user.id)

        return new Response(new Uint8Array(data), {
          headers: {
            ...headers,
            'Content-Length': data.length.toString(),
          },
        })
      },
    ),
  ),
)

// POST /api/items/:id/unlock
app.post(
  '/:id/unlock',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
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
    apiHandler<{ id: string }>({}, async ({ params, request }) => {
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
    apiHandler<{ itemId: string }>({}, async ({ request, params }) => {
      const { itemId } = params

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
          hasColors: f.cadMetadata?.hasColors ?? false,
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
            hasColors: f.cadMetadata?.hasColors ?? false,
            source: 'cad_doc' as const,
            sourceItemId: rel.targetId,
            sourceItemNumber: rel.targetItem!.itemNumber,
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

const modelVersionFileSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  fileType: z.string(),
  hasColors: z.boolean(),
  isPrimaryModel: z.boolean(),
  fileSize: z.number(),
  uploadedAt: z.string(),
  source: z.enum(['direct', 'cad_doc']),
  sourceItemId: z.string().uuid(),
  sourceItemNumber: z.string().nullable(),
})

const modelVersionEntrySchema = z.object({
  key: z.string(),
  kind: z.enum(['current', 'branch', 'historical']),
  itemId: z.string().uuid(),
  revision: z.string(),
  state: z.string(),
  modifiedAt: z.string(),
  branch: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      branchType: z.string(),
      changeOrderItemId: z.string().uuid().nullable(),
      changeOrderNumber: z.string().nullable(),
    })
    .nullable(),
  files: z.array(modelVersionFileSchema),
  file: modelVersionFileSchema.nullable(),
})

// GET /api/items/:itemId/model-versions
app.get(
  '/:itemId/model-versions',
  adapt(
    apiHandler<{ itemId: string }>(
      {
        openapi: {
          summary: "List an item's versions with their viewable 3D models",
          description:
            "Enumerates the released version, active branch working versions, and historical revisions of the item's master, each resolved to every viewable CAD model that version context offers — from the version row itself and from the Documents it links as CAD Docs. `files` is ordered so the first entry is the model that context displays by default, which `file` repeats. Powers the 3D comparison overlay on the part detail page.",
          request: { params: z.object({ itemId: z.string().uuid() }) },
          responses: {
            200: {
              schema: z.object({
                versions: z.array(modelVersionEntrySchema),
              }),
            },
          },
        },
      },
      async ({ params, user }) => {
        const { itemId } = params

        const itemRow = await db
          .select()
          .from(items)
          .where(eq(items.id, itemId))
          .limit(1)
          .then((r) => r.at(0))
        if (!itemRow) {
          throw new NotFoundError('Item', itemId)
        }
        if (itemRow.designId) {
          await requireDesignAccess(user.id, itemRow.designId)
        }

        const versions = await ModelVersionService.listForItem(itemRow)
        return { versions }
      },
    ),
  ),
)

// GET /api/items/:itemId/files
app.get(
  '/:itemId/files',
  adapt(
    apiHandler<{ itemId: string }>(
      { permission: ['documents', 'read'] },
      async ({ request, params }) => {
        const { itemId } = params

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
    apiHandler<{ itemId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params }) => {
        const { itemId } = params

        const file = await FileService.getPrimaryModel(itemId)

        if (!file) {
          return { hasPrimary: false, file: null }
        }

        return { hasPrimary: true, file }
      },
    ),
  ),
)

/** Body of the two designation endpoints below. */
const designateFileSchema = z.object({
  fileId: z
    .string()
    .uuid()
    .describe('A file already uploaded to this item. Must belong to it.'),
})

/** What both designation endpoints return. */
const designateFileResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  fileId: z.string().uuid(),
})

// PUT /api/items/:itemId/files/primary
app.put(
  '/:itemId/files/primary',
  adapt(
    apiHandler<{ itemId: string }>(
      {
        openapi: {
          summary: "Designate an item's primary 3D model",
          description:
            'The primary model is the one the 3D viewer opens by default. ' +
            'Designates an already-uploaded file — upload with ' +
            'POST /api/v1/items/:itemId/files/upload first.',
          request: {
            params: z.object({ itemId: z.string().uuid() }),
            body: { schema: designateFileSchema },
          },
          responses: { 200: { schema: designateFileResponseSchema } },
        },
      },
      async ({ request, params, user }) => {
        const userId = user.id
        const { itemId } = params

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
      },
    ),
  ),
)

// GET /api/items/:itemId/files/thumbnail - which file is the designated thumbnail
app.get(
  '/:itemId/files/thumbnail',
  adapt(
    apiHandler<{ itemId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params }) => {
        const file = await FileService.getDesignatedThumbnail(params.itemId)

        return { hasThumbnail: file !== null, file }
      },
    ),
  ),
)

// PUT /api/items/:itemId/files/thumbnail - designate an uploaded image as the thumbnail
app.put(
  '/:itemId/files/thumbnail',
  adapt(
    apiHandler<{ itemId: string }>(
      {
        permission: ['documents', 'update'],
        openapi: {
          summary: "Designate an uploaded image as the item's thumbnail",
          description:
            'Overrides the thumbnail generated from the CAD model. ' +
            'DELETE the same path to revert to the generated one.',
          request: {
            params: z.object({ itemId: z.string().uuid() }),
            body: { schema: designateFileSchema },
          },
          responses: { 200: { schema: designateFileResponseSchema } },
        },
      },
      async ({ request, params, user }) => {
        const { itemId } = params

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

        await FileService.setItemThumbnail(fileId, user.id)

        return {
          success: true,
          message: 'Thumbnail set successfully',
          fileId,
        }
      },
    ),
  ),
)

// DELETE /api/items/:itemId/files/thumbnail - revert to the generated thumbnail
app.delete(
  '/:itemId/files/thumbnail',
  adapt(
    apiHandler<{ itemId: string }>(
      { permission: ['documents', 'update'] },
      async ({ params, user }) => {
        await FileService.clearItemThumbnail(params.itemId, user.id)

        return { success: true, message: 'Thumbnail cleared' }
      },
    ),
  ),
)

/**
 * The multipart contract, as a schema.
 *
 * The handler takes every part whose value is a file, whatever it is named,
 * and reads two sibling parts per file by convention. The client sends
 * `file0`, `file1`, … so that is what is named here; `catchall` is what
 * carries the rest, and is the honest description of "any name works".
 */
const fileUploadFormSchema = z
  .object({
    file0: z
      .file()
      .optional()
      .describe('First file. Repeat as file1, file2, …'),
    file0_description: z
      .string()
      .optional()
      .describe('Description stored against `file0`.'),
    file0_isThumbnail: z
      .enum(['true', 'false'])
      .optional()
      .describe('`true` designates `file0` as the item thumbnail.'),
    branchId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Attach the files in this ECO branch’s version context. Omitted, ' +
          'they attach on main.',
      ),
  })
  .catchall(z.union([z.string(), z.file()]))

// POST /api/items/:itemId/files/upload
app.post(
  '/:itemId/files/upload',
  adapt(
    apiHandler<{ itemId: string }>(
      {
        permission: ['documents', 'update'],
        rateLimit: 'upload',
        openapi: {
          summary: 'Upload one or more files to an item',
          description:
            '`multipart/form-data`. Every part carrying a file is uploaded; ' +
            'the part name is free, and the client uses `file0`, `file1`, ' +
            'and so on. Two optional parts hang off each file part by name: ' +
            '`<name>_description` and `<name>_isThumbnail` (the string `true`). ' +
            'A single `branchId` part applies to the whole request. ' +
            'Uploading a STEP or IGES file does not convert it — call ' +
            'POST /api/v1/files/:fileId/convert with the returned id.',
          request: {
            params: z.object({ itemId: z.string().uuid() }),
            body: {
              schema: fileUploadFormSchema,
              mediaType: 'multipart/form-data',
            },
          },
          responses: {
            201: {
              schema: z.object({
                files: z.array(vaultFileResponseSchema),
                count: z.number().int(),
              }),
            },
          },
        },
      },
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
              isItemThumbnail:
                formData.get(`${key}_isThumbnail`)?.toString() === 'true',
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
