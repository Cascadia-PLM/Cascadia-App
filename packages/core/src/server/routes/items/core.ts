// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  like,
  or,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../../adapter'
import { readableItemTypes } from './shared'
import { requirePermission } from '@/lib/auth/server'
import { likeContains } from '@/lib/db/like-pattern'
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
import { itemCreateRequestSchema } from '@/lib/items/item-create-request'
import { enrichItemFromUrl } from '@/lib/items/enrichment/enrich-from-url'
import { BranchService } from '@/lib/services/BranchService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { apiHandler, created, parseQuery } from '@/lib/api/handler'
import { itemUpdateSchemaFor } from '@/lib/api/schemas'
import { requireDesignAccess, requireItemAccess } from '@/lib/auth/access'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { db } from '@/lib/db'
import { accessScopeCondition, notDeleted } from '@/lib/db/filters'
import { items, vaultFiles } from '@/lib/db/schema'
import { designs } from '@/lib/db/schema/designs'

const adapt = tagged('Items')

/**
 * How many matching files `GET /by-filename/:filename` will answer with.
 *
 * `vault_files.file_name` has no index, so a broad term is a sequential scan
 * whose result set the caller chooses the size of. The cap bounds the response
 * only — the scope is already in the WHERE, so nothing withheld was ever in
 * the rows this trims.
 */
const BY_FILENAME_LIMIT = 100

/**
 * The envelope `POST /items` reads for itself: which type to create, which
 * branch to write on, and what to say in the commit. Everything else passes
 * through to `ItemService.create`, which parses it against the *type's* own
 * schema — the type is only known from this body, so a single static schema
 * here could not do that job.
 *
 * `PUT /items/:id` is the sibling case and stays an in-handler parse: its type
 * comes from the stored row, so the schema is not known until after a lookup.
 */
const createItemEnvelopeSchema = z
  .object({
    itemType: z.string().min(1, 'itemType is required').max(100),
    branchId: z.string().uuid().optional(),
    commitMessage: z.string().max(500).optional(),
  })
  .passthrough()

const app = new Hono()

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
 * `accessScope`, so no value here can widen a search past the caller's
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

/** The commit a branch write produces, as returned alongside the item. */
const commitSummarySchema = z
  .object({
    id: z.string().uuid(),
    message: z.string(),
  })
  .passthrough()

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
            accessScope: await AccessControlService.getAccessScope(user.id),
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
          accessScope: await AccessControlService.getAccessScope(user.id),
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

// GET /api/items/by-filename/:filename
app.get(
  '/by-filename/:filename',
  adapt(
    apiHandler<{ filename: string }>(
      {
        // `file_name` carries no index, so every call is a sequential scan of
        // `vault_files` that any authenticated account can ask for as often as
        // it likes. A stricter bucket than the default API limiter caps that
        // without narrowing the path parameter, which would be a v1 contract
        // change on an endpoint whose only callers are external.
        rateLimit: { windowMs: 60_000, maxRequests: 60 },
      },
      async ({ params, user }) => {
        const { filename } = params

        // Every "found nothing" answer is this one, whether the filename does
        // not exist or every match sits behind the caller's boundary. An
        // outsider learning that a file exists — or how many copies of it do —
        // is the disclosure this route was making.
        const noMatches = {
          items: [],
          exactMatch: null,
          message: 'No items found with matching filename',
        }

        // Resolved before anything is read, because the scope is now part of
        // the query rather than a filter over its results. An out-of-scope row
        // is unrepresentable here, not fetched and then dropped — which is
        // also what makes the LIMIT below safe: bolting a cap onto a
        // post-filter shape would truncate to 100 rows and then filter to
        // possibly zero, silently emptying a legitimate caller's result.
        //
        // A filename search spans types, so an unreadable type is filtered out
        // rather than 403ing the whole request — the convention the item list
        // and search already follow. An empty readable set compiles to `false`
        // and correctly reaches nothing.
        const [accessScope, readableTypes] = await Promise.all([
          AccessControlService.getAccessScope(user.id),
          readableItemTypes(user.id),
        ])

        const exactMatch = or(
          eq(vaultFiles.fileName, filename),
          eq(vaultFiles.originalFileName, filename),
        )!
        const conditions = [
          or(
            exactMatch,
            like(vaultFiles.fileName, likeContains(filename)),
            like(vaultFiles.originalFileName, likeContains(filename)),
          )!,
          isNull(vaultFiles.deletedAt),
          eq(items.isCurrent, true),
          // Matches GET /items/:id, which reads through `ItemService.findById`
          // and so never answers for a soft-deleted row.
          notDeleted(),
          inArray(items.itemType, [...readableTypes]),
        ]
        // `accessScopeCondition` owns the per-type rule, including the ECO
        // link table and the design-less admission — this route no longer
        // carries a second copy of either.
        const inScope = accessScopeCondition(accessScope)
        if (inScope) conditions.push(inScope)

        const rows = await db
          .select({
            fileId: vaultFiles.id,
            fileName: vaultFiles.fileName,
            originalFileName: vaultFiles.originalFileName,
            itemId: vaultFiles.itemId,
            item: getTableColumns(items),
          })
          .from(vaultFiles)
          .innerJoin(items, eq(vaultFiles.itemId, items.id))
          .where(and(...conditions))
          // Exact matches first so the one the caller most likely meant
          // survives the cap; the rest is a stable tiebreak.
          .orderBy(desc(exactMatch), vaultFiles.uploadedAt, vaultFiles.id)
          .limit(BY_FILENAME_LIMIT + 1)

        if (rows.length === 0) return noMatches

        // An availability bound, not an authorization one: everything above
        // the cap was already inside the caller's boundary.
        const truncated = rows.length > BY_FILENAME_LIMIT
        const visibleFiles = truncated ? rows.slice(0, BY_FILENAME_LIMIT) : rows

        // One item can carry several matching files; dedupe in the order the
        // ORDER BY produced.
        const byId = new Map(visibleFiles.map((r) => [r.item.id, r.item]))
        const exactRow = visibleFiles.find(
          (r) => r.fileName === filename || r.originalFileName === filename,
        )

        // Counts come from the returned set: a total that still included
        // withheld rows would size what the caller cannot see.
        return {
          items: [...byId.values()],
          exactMatch: exactRow?.item ?? null,
          totalMatches: visibleFiles.length,
          truncated,
          matchingFiles: visibleFiles.map(
            ({ fileId, fileName, originalFileName, itemId }) => ({
              fileId,
              fileName,
              originalFileName,
              itemId,
            }),
          ),
        }
      },
    ),
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
      const accessScope = await AccessControlService.getAccessScope(user.id)

      const result = await ItemService.search(itemType || 'Part', {
        query: search || globalSearch,
        state,
        limit,
        offset,
        designIds: resolvedDesignIds,
        accessScope,
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
              accessScope,
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
          // documented-not-enforced: the schema is a union derived from
          // every registered item type, and the real check lives in
          // ItemService.create, which parses the remainder against that
          // type's own schema and raises a ValidationError naming the type.
          // Running it here as well would duplicate the check and lose that
          // message.
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
        body: createItemEnvelopeSchema,
      },
      async ({ request, body, user }) => {
        const { branchId, itemType, commitMessage, ...rest } = body
        // Everything past the envelope is the *type's* to validate, and
        // `ItemService.create`/`createOnBranch` do that against the registered
        // schema. Naming the shape here keeps the handler's own reads honest
        // without asserting a validation this route cannot perform.
        const itemData = rest as Record<string, string | undefined> &
          Parameters<typeof ItemService.create>[1]

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

/** Body of `POST /items/enrich-from-url`. */
const enrichFromUrlSchema = z.object({
  url: z.string().url(),
  itemType: z.enum(['Part', 'Tool']),
})

// POST /api/items/enrich-from-url
// Parse a dropped web link into suggested field values + custom attributes.
// Returns { aiEnabled: false, link } when no AI provider is connected.
app.post(
  '/enrich-from-url',
  adapt(
    apiHandler(
      {
        body: enrichFromUrlSchema,
        openapi: {
          summary: 'Suggest item fields from a web link',
        },
      },
      async ({ body: { url, itemType }, request, user }) => {
        // Gate on the same create permission used when creating the item.
        await requirePermission(request, getResourceType(itemType), 'create')

        // `user.id` so the extraction's token spend is attributed to whoever
        // dropped the link, rather than going unrecorded. `request.signal` so
        // a user who navigates away mid-extraction actually cancels the model
        // call: the extraction accepted a signal and no caller supplied one,
        // which left the abort path dead code.
        return await enrichItemFromUrl({
          url,
          itemType,
          userId: user.id,
          signal: request.signal,
        })
      },
    ),
  ),
)

// GET /api/items/:id
//
// Gate first, then the dispatched read tuple — the shape the rest of the
// `/items/:id/*` family settled on. This route hand-rolled
// `if (designId) requireDesignAccess(...)` instead, which is not the same
// check: `items.design_id` is NULL on every ChangeOrder, on an Issue whose
// only axis is `issues.program_id`, and on every WorkOrder and PhysicalPart,
// so on those four types the branch never ran and authentication plus a read
// verb was the entire gate. `requireItemAccess` dispatches all four and
// otherwise ends in the identical `requireDesignAccess` call, so the nine
// design-carrying types are unaffected.
//
// `getResourceType` replaces `itemTypeToResource` for the same reason
// `detail.ts` made the swap: it is fail-closed, so an unknown item type
// charges `parts` rather than skipping the check entirely.
//
// The gate now runs BEFORE the existence lookup, matching `detail.ts`. One
// consequence, for soft-deleted rows only: `requireItemAccess` deliberately
// does not filter them while `ItemService.findById` does, so an unreachable
// soft-deleted id answers 403 where it used to answer 404. A reachable one
// still answers 404. `findById` stays — `requireItemAccess` returns only the
// bare `items` row and `PersistedItem` is not assignable to it.
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const branchName = url.searchParams.get('branch')
      const commitId = url.searchParams.get('commit')
      const tagId = url.searchParams.get('tag')

      const subject = await requireItemAccess(user.id, params.id)
      await requirePermission(
        request,
        getResourceType(subject.itemType),
        'read',
      )

      const baseItem = await ItemService.findById(params.id)
      if (!baseItem) {
        throw new NotFoundError('Item', params.id)
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
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Update an item',
          description:
            'The body is validated against the update schema of the stored ' +
            'item’s own type — resolved at request time, so no single static ' +
            'schema can be documented here. Type-invalid values are rejected ' +
            'with 400 and `fieldErrors`; fields outside the type’s schema ' +
            '(including server-managed columns) are stripped. See the ' +
            'per-type `*UpdateSchema` shapes in the type-specific routes. ' +
            'All schemas accept `commitMessage` for branch saves.',
        },
      },
      async ({ request, params, user }) => {
        await requireItemAccess(user.id, params.id)
        const url = new URL(request.url)
        const branchId = url.searchParams.get('branchId')

        const raw: unknown = await request.json()

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

        // Validated in-handler rather than via the static `body:` option
        // because the schema depends on the stored item's type, which is only
        // known after the lookup above. Both write paths below receive only
        // what the type's schema admits.
        const parseResult = itemUpdateSchemaFor(item.itemType).safeParse(raw)
        if (!parseResult.success) {
          throw ValidationError.fromZodError(parseResult.error)
        }
        const { commitMessage, ...changes } = parseResult.data as Record<
          string,
          unknown
        > & { commitMessage?: string }

        // A program is an authorization boundary, not an ordinary column:
        // moving a row into a program publishes it to that program's members.
        // The `requireItemAccess` above answered for where the row sits now,
        // so the destination needs its own check — the rule
        // `PUT /api/v1/work-orders/:id` already applies on its own route, and
        // this is the generic route it never reached. Two types' update
        // schemas carry the field (Issue and WorkOrder), and this covers both
        // rather than either one twice. Clearing it is not gated: that only
        // narrows the row's reach, to cross-program authority.
        if (
          typeof changes.programId === 'string' &&
          !(await AccessControlService.canAccessProgram(
            user.id,
            changes.programId,
          ))
        ) {
          throw new PermissionDeniedError('program items', 'update')
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
      },
    ),
  ),
)

// GET /api/items/:id/transitions
// Available lifecycle transitions for a Free-lifecycle item. Returns an
// empty list (with the lifecycleType) for ECO-controlled types so clients
// can hide the control.
app.get(
  '/:id/transitions',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      await requireItemAccess(user.id, params.id)
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
const itemTransitionSchema = z.object({
  toState: z.string().min(1).optional(),
  // Legacy alias still sent by older clients.
  toStateId: z.string().min(1).optional(),
  comments: z.string().max(5000).optional(),
})

app.post(
  '/:id/transition',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof itemTransitionSchema>>(
      { body: itemTransitionSchema },
      async ({ request, params, user, body }) => {
        await requireItemAccess(user.id, params.id)
        const toState = body.toState ?? body.toStateId
        if (!toState) {
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
      },
    ),
  ),
)

// DELETE /api/items/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      await requireItemAccess(user.id, params.id)
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

export default app
