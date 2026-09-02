// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { ScopeGraphEdge, ScopeGraphNode } from '@/lib/api/scope-graph'
import type { BOMTreeNode, OrphanItem } from '@/lib/types/bom'
import {
  DesignService,
  designCreateSchema,
  designUpdateSchema,
  tagCreateSchema,
} from '@/lib/services/DesignService'
import { CommitGraphService } from '@/lib/services/CommitGraphService'
import { ProgramService } from '@/lib/services/ProgramService'
import { BranchService } from '@/lib/services/BranchService'
import { ItemService } from '@/lib/items/services/ItemService'
import { CrossDesignReferenceService } from '@/lib/services/CrossDesignReferenceService'
import { UsageService } from '@/lib/services/UsageService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { RequirementService } from '@/lib/services/RequirementService'
import { VerificationService } from '@/lib/services/VerificationService'
import {
  GapAnalysisService,
  gapAnalysisRequestSchema,
} from '@/lib/services/GapAnalysisService'
import { JobService } from '@/lib/jobs/JobService'
import { requirePermission } from '@/lib/auth/server'
import { likeContains } from '@/lib/db/like-pattern'
import { requireDesignAccess } from '@/lib/auth/access'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import {
  apiHandler,
  created,
  jsonResponse,
  parseQuery,
} from '@/lib/api/handler'
import {
  designNodeId,
  makeDesignNode,
  makeProgramNode,
  makeScopeEdge,
  makeScopeItemNode,
  programNodeId,
  scopeGraphQuerySchema,
  scopeGraphResponseSchema,
} from '@/lib/api/scope-graph'
import { serviceLogger } from '@/lib/logging/logger'
import { db } from '@/lib/db'
import { paginatedOrderBy } from '@/lib/db/paginated-order'
import {
  changeOrderAffectedItems,
  changeOrders,
  itemRelationships,
  items,
} from '@/lib/db/schema/items'
import { branchItems, branches } from '@/lib/db/schema/versioning'
import { users } from '@/lib/db/schema/users'
import { designs } from '@/lib/db/schema/designs'
import { notDeleted, notWorkingRevision } from '@/lib/db/filters'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Designs')

// ============================================
// Types
// ============================================

interface ECOSummary {
  id: string
  itemNumber: string
  name: string
  state: string
  reasonForChange: string
  itemCount: number
  owner: { id: string; name: string }
  createdAt: string
  submittedAt?: string
}

interface Item {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  modifiedAt: string
}

const cloneInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  programId: z.string().uuid().optional(),
  suffixItemNumbers: z.boolean().optional(),
})

/**
 * A design's own program members with `canManageDesigns` may act on it; anyone
 * else needs the global RBAC permission. Four routes ask exactly this question,
 * and it has to be answerable before a body is parsed, so it lives here rather
 * than as the first four lines of each handler.
 */
async function requireDesignManageOrPermission(
  designId: string,
  request: Request,
  userId: string,
  action: 'update' | 'delete',
) {
  const design = await DesignService.getById(designId)
  if (!design) throw new NotFoundError('Design', designId)

  if (design.programId) {
    const member = await ProgramService.getMember(design.programId, userId)
    if (member?.canManageDesigns) return
  }
  await requirePermission(request, 'designs', action)
}

/**
 * A new branch. Each kind needs different fields — an ECO branch needs the
 * change order, a workspace branch a name, a release branch a name and a source
 * tag — so this is a union on `branchType` rather than one object of optionals
 * checked three times inside the handler.
 */
const createBranchSchema = z.discriminatedUnion('branchType', [
  z.object({
    branchType: z.literal('eco'),
    changeOrderItemId: z.string().uuid(),
  }),
  z.object({
    branchType: z.literal('workspace'),
    name: z.string().min(1).max(200),
  }),
  z.object({
    branchType: z.literal('release'),
    name: z.string().min(1).max(200),
    sourceTagId: z.string().uuid(),
  }),
])

/**
 * Pulling a cross-design reference in. Either `refId` (the legacy single-XREF
 * form) or a non-empty `itemIds` chain — the handler used to check that with
 * an `if`, which is what a union says better.
 */
const pullInCrossReferenceSchema = z
  .object({
    refId: z.string().uuid().optional(),
    branchId: z.string().uuid().nullish(),
    suffixItemNumber: z.boolean().optional(),
    itemIds: z.array(z.string().uuid()).max(1000).optional(),
    parentBomRelationshipId: z.string().uuid().nullish(),
  })
  .refine((v) => Boolean(v.refId) || (v.itemIds?.length ?? 0) > 0, {
    message: 'Either refId or itemIds is required',
    path: ['itemIds'],
  })

const createCrossReferenceSchema = z.object({
  referencedItemId: z.string().uuid(),
  branchId: z.string().uuid().nullish(),
  notes: z.string().max(5000).optional(),
})

const app = new Hono()

// =============================================
// Static routes MUST come before parameterized
// =============================================

// GET /api/designs/families
//
// The family picker's feed. Naming a program is a program-scoped read — the
// same gate `GET /api/v1/change-orders` and `GET /api/v1/work-orders` make for
// their own `?programId=` filters — and the result is bounded by the caller's
// accessible designs either way, so the program-less branch is scoped too.
// Until this landed the handler passed the query string's programId straight
// to the service with no membership check, so any authenticated caller could
// read any program's family designs by naming its id.
//
// Refusing rather than returning an empty list is safe here for the reason the
// `?programId=` gates elsewhere are: `canAccessProgram` answers false for a
// program that does not exist exactly as it does for one the caller is not a
// member of, so the 403 confirms nothing about which ids are real.
app.get(
  '/families',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url, 'http://localhost')
      const programId = url.searchParams.get('programId')

      if (
        programId &&
        !(await AccessControlService.canAccessProgram(user.id, programId))
      ) {
        throw new PermissionDeniedError('program designs', 'read')
      }

      const families = await DesignService.getAvailableFamilies(
        programId,
        await AccessControlService.getAccessibleDesignIds(user.id),
      )

      return { families }
    }),
  ),
)

// =============================================
// Parameterized routes with :id
// =============================================

// GET /api/designs - pagination, sorting, filtering, optional type counts
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url, 'http://localhost')
      const programId = url.searchParams.get('programId')
      const designType = url.searchParams.get('designType') as
        'Engineering' | 'Library' | 'Family' | null
      const includeArchived = url.searchParams.get('includeArchived') === 'true'
      const includeHierarchy =
        url.searchParams.get('includeHierarchy') === 'true'
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const sortField = url.searchParams.get('sortField') || undefined
      const sortDirection = (url.searchParams.get('sortDirection') ||
        undefined) as 'asc' | 'desc' | undefined
      const includeCounts = url.searchParams.get('includeCounts') === 'true'
      const globalSearch = url.searchParams.get('globalSearch') || undefined

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

      // Hierarchy mode: no pagination, uses the hierarchy-aware method
      if (includeHierarchy) {
        const hierarchicalDesigns = await DesignService.listWithHierarchy({
          programId: programId || undefined,
          designType: designType || undefined,
          includeArchived,
        })

        const accessibleProgramIds =
          await AccessControlService.getAccessibleProgramIds(user.id)
        const hasBypass = await AccessControlService.hasCrossProgramAccess(
          user.id,
        )

        const filteredDesigns = hasBypass
          ? hierarchicalDesigns
          : hierarchicalDesigns.filter(
              (d) =>
                d.programId === null ||
                accessibleProgramIds!.includes(d.programId),
            )

        return { designs: filteredDesigns }
      }

      // Accessible program IDs (null = admin, array = specific programs)
      let programIds = await AccessControlService.getAccessibleProgramIds(
        user.id,
      )

      const filterByProgram = !!programId
      if (programId) {
        if (programIds === null) {
          programIds = [programId]
        } else if (programIds.includes(programId)) {
          programIds = [programId]
        }
      }

      const includeGlobalLibraries = !filterByProgram
      const includeUnassigned = !filterByProgram

      const mergedFilters: Record<
        string,
        string | Array<string> | { min?: number; max?: number }
      > = { ...columnFilters }
      if (designType) {
        mergedFilters.designType = [designType]
      }

      const result = await DesignService.search({
        programIds,
        limit,
        offset,
        sortField,
        sortDirection,
        columnFilters:
          Object.keys(mergedFilters).length > 0 ? mergedFilters : undefined,
        globalSearch,
        includeGlobalLibraries,
        includeUnassigned,
      })

      const response: Record<string, unknown> = {
        designs: result.items,
        total: result.total,
      }

      if (includeCounts) {
        const [designCount, familyCount, libraryCount] = await Promise.all([
          DesignService.search({
            programIds,
            limit: 1,
            columnFilters: { designType: ['Engineering'] },
            includeGlobalLibraries,
            includeUnassigned,
          }),
          DesignService.search({
            programIds,
            limit: 1,
            columnFilters: { designType: ['Family'] },
            includeGlobalLibraries,
            includeUnassigned,
          }),
          DesignService.search({
            programIds,
            limit: 1,
            columnFilters: { designType: ['Library'] },
            includeGlobalLibraries,
            includeUnassigned,
          }),
        ])
        response.counts = {
          design: designCount.total,
          family: familyCount.total,
          library: libraryCount.total,
        }
      }

      return response
    }),
  ),
)

/**
 * A design as returned by the create/read paths. Passthrough for the same
 * reason as `programResponseSchema` — the extra columns are not contract.
 */
const designResponseSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    programId: z.string().uuid().nullable(),
  })
  .passthrough()

const designIdParamSchema = z.object({ id: z.string().uuid() })

function parseDesignId(params: { id: string }): string {
  return designIdParamSchema.parse(params).id
}

// POST /api/designs
app.post(
  '/',
  adapt(
    apiHandler(
      {
        body: designCreateSchema,
        openapi: {
          summary: 'Create a design',
          description:
            'With `programId`, the caller needs the `canManageDesigns` flag on ' +
            'their membership of that program (or cross-program authority). ' +
            'Without one, the global `designs:create` permission. Creating a ' +
            'design also creates its `main` branch and initial commit.',
          responses: {
            201: { schema: z.object({ design: designResponseSchema }) },
          },
        },
      },
      async ({ body: data, request, user }) => {
        // If programId is provided, check user has permission in that program
        // (canManageDesigns member flag, or the cross-program bypass — this
        // endpoint used to lack the bypass its sibling create endpoint has).
        if (data.programId) {
          const hasBypass = await AccessControlService.hasCrossProgramAccess(
            user.id,
          )
          if (!hasBypass) {
            const member = await ProgramService.getMember(
              data.programId,
              user.id,
            )
            if (!member || !member.canManageDesigns) {
              throw new PermissionDeniedError('designs', 'create')
            }
          }
        } else {
          // Creating design without program requires global permission
          await requirePermission(request, 'designs', 'create')
        }

        const design = await DesignService.create(data, user.id)

        return created({ design })
      },
    ),
  ),
)

// GET /api/designs/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const designId = parseDesignId(params)
      const design = await DesignService.getById(designId)
      if (!design) throw new NotFoundError('Design', designId)

      // Was the cross-program bypass plus `ProgramService.canUserAccess`
      // written out inline, inside `if (design.programId)`. That is
      // `canAccessDesign` exactly — same bypass, same membership call, same
      // admission of a design carrying no program — so the shared helper says
      // it once and the null policy stays decided in one place.
      await requireDesignAccess(user.id, designId)

      const [defaultBranch, parent] = await Promise.all([
        DesignService.getDefaultBranch(designId),
        design.parentDesignId
          ? DesignService.getById(design.parentDesignId)
          : Promise.resolve(null),
      ])

      const parentDesign = parent
        ? { id: parent.id, code: parent.code, name: parent.name }
        : null

      return { design: { ...design, defaultBranch, parentDesign } }
    }),
  ),
)

// GET /api/designs/:id/graph — scope graph for the drill-down graph view.
// Design node + parent program (direction=up) + the design's top-level items
// (direction=down). Items nested under another returned candidate (target of a
// relationship whose source is also in the design and passes the type filter)
// are omitted — they surface step-by-step by expanding their parent through
// GET /api/v1/items/:id/graph.
app.get(
  '/:id/graph',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Get the scope graph for a design',
          description:
            'Returns the design as a graph node, its parent program above it, and the top-level items it contains below it. Filter contained items with itemTypes (comma-separated); nested items are expanded per-node via the item graph endpoint.',
          request: {
            params: designIdParamSchema,
            query: scopeGraphQuerySchema,
          },
          responses: {
            200: { schema: scopeGraphResponseSchema },
          },
        },
      },
      async ({ params, request, user }) => {
        const designId = parseDesignId(params)
        const { direction, itemTypes } = parseQuery(
          request,
          scopeGraphQuerySchema,
        )
        const itemTypeFilter = itemTypes?.split(',').filter(Boolean) ?? []

        const design = await DesignService.getById(designId)
        if (!design) throw new NotFoundError('Design', designId)
        await requireDesignAccess(user.id, designId)

        const nodes: Array<ScopeGraphNode> = []
        const edges: Array<ScopeGraphEdge> = []

        nodes.push(makeDesignNode(design, 0))

        // Parent program (upstream)
        if (direction !== 'down' && design.programId) {
          const program = await ProgramService.getById(design.programId)
          if (program) {
            nodes.push(makeProgramNode(program, 1))
            edges.push(
              makeScopeEdge(programNodeId(program.id), designNodeId(designId)),
            )
          }
        }

        // Contained items (downstream): current versions in this design.
        if (direction !== 'up') {
          const candidates = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              revision: items.revision,
              itemType: items.itemType,
              name: items.name,
              state: items.state,
              masterId: items.masterId,
            })
            .from(items)
            .where(
              and(
                eq(items.designId, designId),
                eq(items.isCurrent, true),
                notDeleted(),
                itemTypeFilter.length > 0
                  ? inArray(items.itemType, itemTypeFilter)
                  : undefined,
              ),
            )
            .orderBy(asc(items.itemNumber))

          // Top-level only: drop candidates that another candidate points at.
          //
          // A BOM line names one item *version*, and a merge does not re-point
          // the lines of parents it did not touch. Matching raw target ids
          // therefore stopped recognising a released child as nested — it
          // surfaced as a second root beside its own assembly — so targets are
          // compared by masterId, which survives the revision.
          const candidateIds = candidates.map((c) => c.id)
          const candidateIdByMaster = new Map(
            candidates.map((c) => [c.masterId, c.id] as const),
          )
          const nestedIds = new Set<string>()
          if (candidateIds.length > 0) {
            const internalRels = await db
              .select({ targetId: itemRelationships.targetId })
              .from(itemRelationships)
              .where(inArray(itemRelationships.sourceId, candidateIds))

            const targetIds = [
              ...new Set(internalRels.map((rel) => rel.targetId)),
            ]
            const targetMasters =
              targetIds.length > 0
                ? await db
                    .select({ id: items.id, masterId: items.masterId })
                    .from(items)
                    .where(inArray(items.id, targetIds))
                : []

            for (const target of targetMasters) {
              const nested = candidateIdByMaster.get(target.masterId)
              if (nested) {
                nestedIds.add(nested)
              }
            }
          }

          for (const item of candidates) {
            if (nestedIds.has(item.id)) continue
            nodes.push(makeScopeItemNode(item, 1))
            edges.push(makeScopeEdge(designNodeId(designId), item.id))
          }
        }

        // Unfiltered per-type counts so the client can offer every type
        // present in the design as a filter option.
        const typeCounts = await db
          .select({
            itemType: items.itemType,
            count: sql<number>`count(*)::int`,
          })
          .from(items)
          .where(
            and(
              eq(items.designId, designId),
              eq(items.isCurrent, true),
              notDeleted(),
            ),
          )
          .groupBy(items.itemType)
          .orderBy(asc(items.itemType))

        return { nodes, edges, availableItemTypes: typeCounts }
      },
    ),
  ),
)

// PUT /api/designs/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof designUpdateSchema>>(
      {
        access: ({ params, request, user }) =>
          requireDesignManageOrPermission(
            params.id,
            request,
            user.id,
            'update',
          ),
        body: designUpdateSchema,
      },
      async ({ params, body, user }) => {
        const updated = await DesignService.update(params.id, body, user.id)
        return { design: updated }
      },
    ),
  ),
)

// DELETE /api/designs/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) throw new NotFoundError('Design', designId)

      // Check permission
      if (design.programId) {
        const member = await ProgramService.getMember(design.programId, user.id)
        if (!member || !member.canManageDesigns) {
          await requirePermission(request, 'designs', 'delete')
        }
      } else {
        await requirePermission(request, 'designs', 'delete')
      }

      await DesignService.archive(designId, user.id)
      return { success: true }
    }),
  ),
)

// GET /api/designs/:id/details - Composite endpoint returning design with
// branches, tags, default branch, program, and parent design info.
app.get(
  '/:id/details',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) throw new NotFoundError('Design', designId)

      await requireDesignAccess(user.id, designId)

      const [branchList, tagList, programs] = await Promise.all([
        DesignService.getBranches(designId).catch((err) => {
          serviceLogger.error(
            { err, designId: designId },
            'Failed to fetch branches for design',
          )
          return []
        }),
        DesignService.listTags(designId).catch((err) => {
          serviceLogger.error(
            { err, designId: designId },
            'Failed to fetch tags for design',
          )
          return []
        }),
        ProgramService.listAll().catch((err) => {
          serviceLogger.error({ err }, 'Failed to fetch programs')
          return []
        }),
      ])

      const defaultBranch = await DesignService.getDefaultBranch(
        designId,
      ).catch((err) => {
        serviceLogger.error(
          { err, designId: designId },
          'Failed to fetch default branch for design',
        )
        return null
      })

      const program = design.programId
        ? programs.find((p: { id: string }) => p.id === design.programId)
        : null

      let parentDesign: { id: string; code: string; name: string } | null = null
      if (design.parentDesignId) {
        const parent = await DesignService.getById(design.parentDesignId).catch(
          () => null,
        )
        if (parent) {
          parentDesign = { id: parent.id, code: parent.code, name: parent.name }
        }
      }

      return {
        design: {
          ...design,
          defaultBranch,
          program,
          parentDesign,
        },
        branches: branchList,
        tags: tagList,
        programs,
      }
    }),
  ),
)

// GET /api/designs/:id/branches
app.get(
  '/:id/branches',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const designId = parseDesignId(params)
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      const url = new URL(request.url, 'http://localhost')
      const includeArchived = url.searchParams.get('includeArchived') === 'true'

      const branchesList = await DesignService.getBranches(
        designId,
        includeArchived,
      )

      return { branches: branchesList }
    }),
  ),
)

// POST /api/designs/:id/branches
app.post(
  '/:id/branches',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof createBranchSchema>>(
      {
        access: async ({ params, user }) => {
          const design = await DesignService.getById(params.id)
          if (!design) throw new NotFoundError('Design', params.id)
          await requireDesignAccess(user.id, params.id)
        },
        body: createBranchSchema,
      },
      async ({ params, body: data, user }) => {
        const designId = params.id

        // The discriminated union already guarantees each arm's own fields;
        // three sequential "X is required for Y branches" throws are gone.
        let branch
        switch (data.branchType) {
          case 'eco':
            branch = await BranchService.createEcoBranch(
              designId,
              data.changeOrderItemId,
              user.id,
            )
            break

          case 'workspace':
            branch = await BranchService.createWorkspaceBranch(
              designId,
              user.id,
              data.name,
            )
            break

          case 'release':
            branch = await BranchService.createReleaseBranch(
              designId,
              data.name,
              data.sourceTagId,
              user.id,
            )
            break
        }

        return created({ branch })
      },
    ),
  ),
)

// POST /api/designs/:id/clone
app.post(
  '/:id/clone',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof cloneInputSchema>>(
      { body: cloneInputSchema },
      async ({ body, params, user }) => {
        const { id: designId } = params
        // Validate source design exists
        const sourceDesign = await DesignService.getById(designId)
        if (!sourceDesign) {
          throw new NotFoundError('Design', designId)
        }

        // Check read access to source design
        await requireDesignAccess(user.id, designId)

        const input = body

        // Determine target program
        const targetProgramId = input.programId ?? sourceDesign.programId

        // Check create permission in target program
        if (targetProgramId) {
          const hasBypass = await AccessControlService.hasCrossProgramAccess(
            user.id,
          )
          if (!hasBypass) {
            const member = await ProgramService.getMember(
              targetProgramId,
              user.id,
            )
            if (!member || !member.canManageDesigns) {
              throw new PermissionDeniedError('design', 'create')
            }
          }
        }

        // Check for duplicate code
        const existing = await DesignService.getByCode(input.code)
        if (existing) {
          throw new ValidationError('Design code already exists', undefined, {
            field: 'code',
          })
        }

        // Cannot clone family or library designs
        if (sourceDesign.designType !== 'Engineering') {
          throw new ValidationError(
            `Cannot clone ${sourceDesign.designType} designs`,
          )
        }

        // Submit clone job
        const job = await JobService.submit(
          'design.clone',
          {
            sourceDesignId: designId,
            targetCode: input.code,
            targetName: input.name,
            targetDescription: input.description,
            targetProgramId: targetProgramId,
            userId: user.id,
            suffixItemNumbers: input.suffixItemNumbers,
          },
          user.id,
          { priority: 'high' },
        )

        return jsonResponse({ jobId: job.id }, 202)
      },
    ),
  ),
)

// GET /api/designs/:id/cross-references
app.get(
  '/:id/cross-references',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      const url = new URL(request.url, 'http://localhost')
      const branchId = url.searchParams.get('branch')

      const references =
        await CrossDesignReferenceService.getReferencesForDesign(
          designId,
          branchId,
        )

      return { references }
    }),
  ),
)

// POST /api/designs/:id/cross-references
app.post(
  '/:id/cross-references',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof pullInCrossReferenceSchema>>(
      { body: pullInCrossReferenceSchema },
      async ({ body, params, user }) => {
        const { id: designId } = params
        const design = await DesignService.getById(designId)
        if (!design) {
          throw new NotFoundError('Design', designId)
        }

        await requireDesignAccess(user.id, designId)

        const {
          refId,
          branchId,
          suffixItemNumber,
          itemIds,
          parentBomRelationshipId,
        } = body

        // If branchId is provided, validate it exists
        if (branchId) {
          const branch = await BranchService.getById(branchId)
          if (!branch) {
            throw new NotFoundError('Branch', branchId)
          }
        }

        // If refId provided, pull in the XREF record (remove cross-design reference)
        // pullInReference returns null if the reference was already removed (idempotent)
        let referencedItemId: string | undefined
        if (refId) {
          const pullInResult =
            await CrossDesignReferenceService.pullInReference(
              refId,
              branchId || null,
              user.id,
            )
          referencedItemId = pullInResult?.referencedItemId
        }

        // Determine the list of items to pull in
        // Chain mode: itemIds provided (topmost ancestor first, target last)
        // Legacy mode: just the single referenced item
        const chainItemIds: Array<string> =
          itemIds ?? (referencedItemId ? [referencedItemId] : [])

        if (chainItemIds.length === 0) {
          throw new ValidationError('No items to pull in')
        }

        // Fetch all chain items and assert IDs exist (items from DB always have IDs)
        const chainItems = await Promise.all(
          chainItemIds.map(async (id: string) => {
            const item = await ItemService.findById(id)
            if (!item || !item.id) throw new NotFoundError('Item', id)
            return item
          }),
        )

        const result = await db.transaction(async (tx) => {
          const targetMainBranch = await BranchService.getMainBranch(designId)
          if (!targetMainBranch) {
            throw new ValidationError('Target design has no main branch')
          }

          // Create usage copies for each item in the chain
          const usageCopyMap = new Map<string, string>() // originalItemId -> usageCopyId
          const createdUsages: Array<{ id: string; masterId: string }> = []

          for (const chainItem of chainItems) {
            // Check if a usage already exists for this item in this design
            const existingUsages = await UsageService.getUsagesOfDefinition(
              chainItem.id,
              {
                designId: designId,
              },
            )

            if (existingUsages.length > 0) {
              // Safe: guarded by existingUsages.length > 0
              usageCopyMap.set(chainItem.id, existingUsages[0]!.id)
            } else {
              const overrides: { itemNumber?: string } = {}
              if (suffixItemNumber && design.code) {
                overrides.itemNumber = `${chainItem.itemNumber}-${design.code}`
              }

              const usageResult = await UsageService.createUsage(
                {
                  definitionId: chainItem.id,
                  targetDesignId: designId,
                  ...(overrides.itemNumber ? { overrides } : {}),
                },
                user.id,
                tx,
              )

              usageCopyMap.set(chainItem.id, usageResult.usage.id)
              createdUsages.push(usageResult.usage)

              await tx.insert(branchItems).values({
                branchId: targetMainBranch.id,
                itemMasterId: usageResult.usage.masterId,
                currentItemId: usageResult.usage.id,
                baseItemId: usageResult.usage.id,
                changeType: null,
              })
            }
          }

          let relationshipsCreated = 0
          const chainItemIdSet = new Set(chainItemIds)

          // Find all BOM relationships between chain items (handles any topology: linear, star, etc.)
          const intraChainRels = await db
            .select()
            .from(itemRelationships)
            .where(
              and(
                inArray(itemRelationships.sourceId, chainItemIds),
                inArray(itemRelationships.targetId, chainItemIds),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          for (const rel of intraChainRels) {
            const parentUsageId = usageCopyMap.get(rel.sourceId)
            const childUsageId = usageCopyMap.get(rel.targetId)
            if (parentUsageId && childUsageId) {
              await tx.insert(itemRelationships).values({
                sourceId: parentUsageId,
                targetId: childUsageId,
                relationshipType: rel.relationshipType,
                quantity: rel.quantity,
                findNumber: rel.findNumber,
                referenceDesignator: rel.referenceDesignator,
                metadata: rel.metadata,
                isComposite: rel.isComposite,
                isDirected: rel.isDirected,
                multiplicityLower: rel.multiplicityLower,
                multiplicityUpper: rel.multiplicityUpper,
                usageAttributes: rel.usageAttributes,
                createdBy: user.id,
                modifiedBy: user.id,
              })
              relationshipsCreated++
            }
          }

          // For each chain item, create BOM rels from its usage copy to non-chain children
          // (these point to the original external items, not usage copies)
          for (const chainItemId of chainItemIds) {
            const usageId = usageCopyMap.get(chainItemId)!

            const allChildRels = await db
              .select()
              .from(itemRelationships)
              .where(
                and(
                  eq(itemRelationships.sourceId, chainItemId),
                  eq(itemRelationships.relationshipType, 'BOM'),
                ),
              )

            for (const rel of allChildRels) {
              // Skip children that are part of the chain (already handled above)
              if (chainItemIdSet.has(rel.targetId)) continue

              await tx.insert(itemRelationships).values({
                sourceId: usageId,
                targetId: rel.targetId,
                relationshipType: rel.relationshipType,
                quantity: rel.quantity,
                findNumber: rel.findNumber,
                referenceDesignator: rel.referenceDesignator,
                metadata: rel.metadata,
                isComposite: rel.isComposite,
                isDirected: rel.isDirected,
                multiplicityLower: rel.multiplicityLower,
                multiplicityUpper: rel.multiplicityUpper,
                usageAttributes: rel.usageAttributes,
                createdBy: user.id,
                modifiedBy: user.id,
              })
              relationshipsCreated++
            }
          }

          // If parentBomRelationshipId provided, update that BOM rel to point to
          // the topmost chain item's usage copy
          if (parentBomRelationshipId) {
            // Safe: chainItemIds is non-empty (validated above)
            const topmostUsageId = usageCopyMap.get(chainItemIds[0]!)
            if (topmostUsageId) {
              await tx
                .update(itemRelationships)
                .set({
                  targetId: topmostUsageId,
                  modifiedBy: user.id,
                })
                .where(eq(itemRelationships.id, parentBomRelationshipId))
              relationshipsCreated++
            }
          }

          return { items: createdUsages, relationshipsCreated }
        })

        return {
          pulledIn: true,
          items: result.items,
          relationshipsCreated: result.relationshipsCreated,
        }
      },
    ),
  ),
)

// PUT /api/designs/:id/cross-references
app.put(
  '/:id/cross-references',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof createCrossReferenceSchema>>(
      { body: createCrossReferenceSchema },
      async ({ body, params, user }) => {
        const { id: designId } = params
        const design = await DesignService.getById(designId)
        if (!design) {
          throw new NotFoundError('Design', designId)
        }

        await requireDesignAccess(user.id, designId)

        const { referencedItemId, branchId: inputBranchId, notes } = body

        const ref = await CrossDesignReferenceService.createReference(
          {
            referencingDesignId: designId,
            referencedItemId,
            branchId: inputBranchId || null,
            notes,
          },
          user.id,
        )

        return { reference: ref }
      },
    ),
  ),
)

// DELETE /api/designs/:id/cross-references
app.delete(
  '/:id/cross-references',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      const url = new URL(request.url, 'http://localhost')
      const refId = url.searchParams.get('refId')
      const branchId = url.searchParams.get('branch')

      if (!refId) {
        throw new ValidationError('refId query parameter is required')
      }

      await CrossDesignReferenceService.removeReference(
        refId,
        branchId,
        user.id,
      )

      return { success: true }
    }),
  ),
)

// GET /api/designs/:id/ecos
app.get(
  '/:id/ecos',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      // Parse query params - use a base URL for relative paths
      const url = new URL(request.url, 'http://localhost')
      const statusFilter = url.searchParams.get('status')

      // Get all branches for this design
      const allBranches = await db
        .select()
        .from(branches)
        .where(eq(branches.designId, designId))

      // Filter to ECO branches and get their change order item IDs
      const ecoItemIds = allBranches
        .filter((b) => b.branchType === 'eco')
        .map((b) => b.changeOrderItemId)
        .filter((id): id is string => id !== null)

      if (ecoItemIds.length === 0) {
        return { ecos: [], total: 0 }
      }

      // Get ECO items
      let ecoItems = await db
        .select()
        .from(items)
        .where(inArray(items.id, ecoItemIds))

      // Apply status filter if provided
      if (statusFilter) {
        ecoItems = ecoItems.filter((item) => item.state === statusFilter)
      }

      if (ecoItems.length === 0) {
        return { ecos: [], total: 0 }
      }

      const ecoIds = ecoItems.map((e) => e.id)

      // Get change order details
      const ecoDetails = await db
        .select()
        .from(changeOrders)
        .where(inArray(changeOrders.itemId, ecoIds))

      const detailsMap = new Map(ecoDetails.map((d) => [d.itemId, d]))

      // Get affected item counts
      const affectedCounts = await db
        .select({
          changeOrderId: changeOrderAffectedItems.changeOrderId,
          count: sql<number>`count(*)::int`,
        })
        .from(changeOrderAffectedItems)
        .where(inArray(changeOrderAffectedItems.changeOrderId, ecoIds))
        .groupBy(changeOrderAffectedItems.changeOrderId)

      const countMap = new Map(
        affectedCounts.map((c) => [c.changeOrderId, c.count]),
      )

      // Get owner info
      const ownerIds = ecoItems
        .map((e) => e.createdBy)
        .filter((id): id is string => !!id)
      const uniqueOwnerIds = [...new Set(ownerIds)]

      const ownersResult =
        uniqueOwnerIds.length > 0
          ? await db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, uniqueOwnerIds))
          : []

      const ownerMap = new Map(
        ownersResult.map((o) => [
          o.id,
          { id: o.id, name: o.name ?? 'Unknown' },
        ]),
      )

      // Build response
      const ecos: Array<ECOSummary> = ecoItems.map((eco) => {
        const details = detailsMap.get(eco.id)
        return {
          id: eco.id,
          itemNumber: eco.itemNumber,
          name: eco.name ?? '',
          state: eco.state,
          reasonForChange: details?.reasonForChange ?? '',
          itemCount: countMap.get(eco.id) ?? 0,
          owner: ownerMap.get(eco.createdBy || '') || {
            id: '',
            name: 'Unknown',
          },
          createdAt: eco.createdAt.toISOString(),
          submittedAt: details?.submittedAt?.toISOString(),
        }
      })

      return { ecos, total: ecos.length }
    }),
  ),
)

// GET /api/designs/:id/history/graph
/**
 * Query params for the commit graph.
 *
 * `limit` reaches buildCommitGraph's commit query directly, and was
 * `parseInt(... || '50', 10)` — so `?limit=abc` passed NaN into a LIMIT clause
 * and `?limit=100000` was honoured. The UI only ever asks for 50.
 */
const commitGraphQuerySchema = z.object({
  branchId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

app.get(
  '/:id/history/graph',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      // Check access via design access control (handles the cross-program bypass)
      await requireDesignAccess(user.id, design.id)

      const { branchId, limit } = parseQuery(request, commitGraphQuerySchema)
      const selectedBranchId = branchId ?? null

      // Build the graph data
      const graphData = await CommitGraphService.buildCommitGraph(
        designId,
        selectedBranchId,
        limit,
      )

      return graphData
    }),
  ),
)

// GET /api/designs/:id/items
app.get(
  '/:id/items',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      // Parse query params
      const url = new URL(request.url, 'http://localhost')
      const search = url.searchParams.get('search')
      const type = url.searchParams.get('type')
      const stateFilter = url.searchParams.get('state')
      const limit = parseInt(url.searchParams.get('limit') || '100', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)

      // Parse version context params
      const tagId = url.searchParams.get('tag')
      const commitId = url.searchParams.get('commit')
      // Note: branch param available via url.searchParams.get('branch') for future use

      // Check if this is a historical view (tag or commit)
      const isHistoricalView = tagId || commitId

      let result: Array<Item> = []
      let total = 0

      if (isHistoricalView) {
        // Use VersionResolver for historical views
        const context = tagId
          ? { type: 'tag' as const, tagId }
          : { type: 'commit' as const, commitId: commitId! }

        const historicalResult = await VersionResolver.getItemsAtContext(
          designId,
          context,
          {
            itemType: type || undefined,
            state: stateFilter || undefined,
            search: search || undefined,
            limit,
            offset,
          },
        )

        result = historicalResult.items.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          modifiedAt: item.modifiedAt.toISOString(),
        }))

        total = historicalResult.total
      } else {
        // Build query conditions for current/branch view
        const conditions = [
          eq(items.designId, designId),
          eq(items.isCurrent, true),
        ]

        if (type) {
          conditions.push(eq(items.itemType, type))
        }

        if (stateFilter) {
          conditions.push(eq(items.state, stateFilter))
        }

        if (search) {
          // ILIKE, not LIKE: the historical view of this same endpoint goes
          // through VersionResolver, which is case-insensitive. The two paths
          // disagreed until now.
          const pattern = likeContains(search)
          conditions.push(
            or(ilike(items.itemNumber, pattern), ilike(items.name, pattern))!,
          )
        }

        // Get total count
        const countResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(items)
          .where(and(...conditions))

        total = Number(countResult[0]?.count || 0)

        // Get items
        const itemList = await db
          .select({
            id: items.id,
            itemNumber: items.itemNumber,
            name: items.name,
            revision: items.revision,
            state: items.state,
            itemType: items.itemType,
            modifiedAt: items.modifiedAt,
          })
          .from(items)
          .where(and(...conditions))
          .orderBy(...paginatedOrderBy(asc(items.itemNumber), items.id))
          .limit(limit)
          .offset(offset)

        result = itemList.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          modifiedAt: item.modifiedAt.toISOString(),
        }))
      }

      return { items: result, total }
    }),
  ),
)

/** Body of POST /designs/:id/items — add an item to a design. */
const designItemAddSchema = z.object({
  itemId: z.string().uuid(),
  mode: z.enum(['usage_copy', 'cross_design_ref']).default('usage_copy'),
  suffixItemNumber: z.boolean().optional(),
  branchId: z.string().uuid().optional(),
})

// POST /api/designs/:id/items
app.post(
  '/:id/items',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof designItemAddSchema>>(
      { body: designItemAddSchema },
      async ({ params, user, body }) => {
        const { id: designId } = params
        const design = await DesignService.getById(designId)
        if (!design) {
          throw new NotFoundError('Design', designId)
        }

        await requireDesignAccess(user.id, designId)

        const { itemId, suffixItemNumber, mode, branchId } = body

        // Verify the root item exists
        const rootItem = await ItemService.findById(itemId)
        if (!rootItem) {
          throw new NotFoundError('Item', itemId)
        }

        // Cross-design reference mode: a lightweight link instead of a copy
        if (mode === 'cross_design_ref') {
          const ref = await CrossDesignReferenceService.createReference(
            {
              referencingDesignId: designId,
              referencedItemId: itemId,
              branchId: branchId ?? null,
            },
            user.id,
          )
          return {
            reference: {
              id: ref.id,
              referencedItemId: ref.referencedItemId,
              sourceDesignId: ref.sourceDesignId,
            },
          }
        }

        // Usage-copy mode (default): the whole multi-entity write lives in
        // the service — one transaction over usage creation, branch tracking,
        // and BOM-edge remapping.
        const result = await UsageService.createUsageSubtree(
          {
            rootItemId: itemId,
            targetDesignId: designId,
            suffixItemNumber,
            branchId,
          },
          user.id,
        )

        return {
          items: result.items,
          relationshipsCreated: result.relationshipsCreated,
        }
      },
    ),
  ),
)

// DELETE /api/designs/:id/items
app.delete(
  '/:id/items',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      // Get item ID from query params
      const url = new URL(request.url, 'http://localhost')
      const itemId = url.searchParams.get('itemId')

      if (!itemId) {
        throw new ValidationError('itemId query parameter is required')
      }

      // Verify the item exists and belongs to this design
      const item = await ItemService.findById(itemId)
      if (!item) {
        throw new NotFoundError('Item', itemId)
      }

      if (item.designId !== designId) {
        throw new ValidationError('Item does not belong to this design')
      }

      // Remove from structure by setting inDesignStructure = false
      // The item remains in the design but moves to the orphan list
      await db
        .update(items)
        .set({
          inDesignStructure: false,
          modifiedBy: user.id,
          modifiedAt: new Date(),
        })
        .where(eq(items.id, itemId))

      return { success: true }
    }),
  ),
)

// PATCH /api/designs/:id/items
app.patch(
  '/:id/items',
  adapt(
    apiHandler<{ id: string }, { itemId: string }>(
      { body: z.object({ itemId: z.string().uuid() }) },
      async ({ body, params, user }) => {
        const { id: designId } = params
        const design = await DesignService.getById(designId)
        if (!design) {
          throw new NotFoundError('Design', designId)
        }

        await requireDesignAccess(user.id, designId)

        const { itemId } = body

        // Verify the item exists and belongs to this design
        const item = await ItemService.findById(itemId)
        if (!item) {
          throw new NotFoundError('Item', itemId)
        }

        if (item.designId !== designId) {
          throw new ValidationError('Item does not belong to this design')
        }

        // Add back to structure by setting inDesignStructure = true
        await db
          .update(items)
          .set({
            inDesignStructure: true,
            modifiedBy: user.id,
            modifiedAt: new Date(),
          })
          .where(eq(items.id, itemId))

        return { success: true }
      },
    ),
  ),
)

// GET /api/designs/:id/members
app.get(
  '/:id/members',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      // Only family designs can have members
      if (design.designType !== 'Family') {
        throw new ValidationError('Only family designs can have members')
      }

      await requireDesignAccess(user.id, designId)

      const members = await DesignService.getMembers(designId)

      return { members }
    }),
  ),
)

// POST /api/designs/:id/members
app.post(
  '/:id/members',
  adapt(
    apiHandler<{ id: string }, { designId: string }>(
      { body: z.object({ designId: z.string().uuid() }) },
      async ({ body, params, request, user }) => {
        const { id: familyDesignId } = params
        const familyDesign = await DesignService.getById(familyDesignId)
        if (!familyDesign) {
          throw new NotFoundError('Design', familyDesignId)
        }

        // Only family designs can have members
        if (familyDesign.designType !== 'Family') {
          throw new ValidationError('Only family designs can have members')
        }

        await requireDesignManageOrPermission(
          familyDesignId,
          request,
          user.id,
          'update',
        )

        const { designId } = body

        // Verify the design to be added exists and is in the same program
        const designToAdd = await DesignService.getById(designId)
        if (!designToAdd) {
          throw new ValidationError('Design not found', undefined, {
            field: 'designId',
          })
        }

        // Use setParent which handles validation
        const updated = await DesignService.setParent(
          designId,
          familyDesignId,
          user.id,
        )

        return { design: updated }
      },
    ),
  ),
)

// DELETE /api/designs/:id/members
app.delete(
  '/:id/members',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id: familyDesignId } = params
      const familyDesign = await DesignService.getById(familyDesignId)
      if (!familyDesign) {
        throw new NotFoundError('Design', familyDesignId)
      }

      // Check permission
      if (familyDesign.programId) {
        const member = await ProgramService.getMember(
          familyDesign.programId,
          user.id,
        )
        if (!member || !member.canManageDesigns) {
          await requirePermission(request, 'designs', 'update')
        }
      } else {
        await requirePermission(request, 'designs', 'update')
      }

      // Get designId from query params or body
      const url = new URL(request.url, 'http://localhost')
      const designId = url.searchParams.get('designId')

      if (!designId) {
        throw new ValidationError(
          'designId query parameter is required',
          undefined,
          { field: 'designId' },
        )
      }

      // Verify the design exists and is a child of this family
      const childDesign = await DesignService.getById(designId)
      if (!childDesign) {
        throw new ValidationError('Design not found', undefined, {
          field: 'designId',
        })
      }

      if (childDesign.parentDesignId !== familyDesignId) {
        throw new ValidationError(
          'Design is not a member of this family',
          undefined,
          {
            field: 'designId',
          },
        )
      }

      // Remove from family
      await DesignService.removeFromFamily(designId, user.id)

      return new Response(null, { status: 204 })
    }),
  ),
)

// GET /api/designs/:id/status
app.get(
  '/:id/status',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      // Get protection status
      const protection = await DesignService.getProtectionStatus(designId)

      // Get available branch types based on protection
      const branchOptions =
        await BranchService.getAvailableBranchTypes(designId)

      return {
        protection,
        branchOptions,
      }
    }),
  ),
)

// GET /api/designs/:id/structure
app.get(
  '/:id/structure',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const { id: designId } = params
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      // Parse version context from query params
      const url = new URL(request.url, 'http://localhost')
      const branchId = url.searchParams.get('branch')
      const tagId = url.searchParams.get('tag')
      const commitId = url.searchParams.get('commit')
      const expandExternal = url.searchParams.get('expandExternal') !== 'false' // default true

      // Get main branch for this design
      const mainBranch = await BranchService.getMainBranch(designId)

      // Check if this is a historical view (tag or commit)
      // For historical views, use VersionResolver to get items at that point in time
      const isHistoricalView = tagId || commitId

      // Get items via branchItems to respect version context
      // For ECO branches, we need to merge ECO changes with main branch items
      let allItems: Array<{
        id: string
        itemNumber: string
        name: string | null
        revision: string
        state: string
        itemType: string
        inDesignStructure: boolean | null
        designId: string | null
        masterId: string
      }> = []

      // For ECO branches, we need to track main branch item IDs for relationship queries
      // and build a masterId -> resolvedItemId mapping for resolving relationships
      let mainBranchItemIds: Array<string> = []
      const masterIdToResolvedItemId = new Map<string, string>()
      // Map from main branch itemId -> masterId (for resolving relationships)
      const mainItemIdToMasterId = new Map<string, string>()

      // Handle historical views (tag or commit) using VersionResolver
      if (isHistoricalView) {
        const context = tagId
          ? { type: 'tag' as const, tagId }
          : { type: 'commit' as const, commitId: commitId! }

        const historicalResult = await VersionResolver.getItemsAtContext(
          designId,
          context,
        )

        allItems = historicalResult.items.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          inDesignStructure: item.inDesignStructure,
          designId: item.designId,
          masterId: item.masterId,
        }))

        // Build masterId mappings for historical items so relationships can be resolved
        // BOM relationships are stored with main branch item IDs, so we need to:
        // 1. Get main branch item IDs for relationship queries
        // 2. Map masterId -> historical item ID for resolution
        if (mainBranch) {
          const mainBranchItemsResult = await db
            .select({
              currentItemId: branchItems.currentItemId,
              itemMasterId: branchItems.itemMasterId,
            })
            .from(branchItems)
            .where(eq(branchItems.branchId, mainBranch.id))

          mainBranchItemIds = mainBranchItemsResult
            .map((bi) => bi.currentItemId)
            .filter((id): id is string => id !== null)

          // Build mappings: main branch itemId -> masterId, masterId -> historical itemId
          for (const bi of mainBranchItemsResult) {
            if (bi.currentItemId && bi.itemMasterId) {
              mainItemIdToMasterId.set(bi.currentItemId, bi.itemMasterId)
            }
          }
          for (const item of allItems) {
            masterIdToResolvedItemId.set(item.masterId, item.id)
          }
        }
      } else {
        // Determine which branch to use for filtering
        // Default to main branch if no context specified
        let targetBranchId = branchId
        if (!targetBranchId && mainBranch) {
          targetBranchId = mainBranch.id
        }

        if (targetBranchId) {
          // Check if this is an ECO branch (not main)
          const isEcoBranch = mainBranch && targetBranchId !== mainBranch.id

          if (isEcoBranch) {
            // For ECO branches: merge ECO changes on top of main branch
            // 1. Get all items from main branch
            const mainBranchItemsResult = await db
              .select({
                currentItemId: branchItems.currentItemId,
                itemMasterId: branchItems.itemMasterId,
              })
              .from(branchItems)
              .where(eq(branchItems.branchId, mainBranch.id))

            // 2. Get items specific to this ECO branch (working copies)
            const ecoBranchItemsResult = await db
              .select({
                currentItemId: branchItems.currentItemId,
                itemMasterId: branchItems.itemMasterId,
              })
              .from(branchItems)
              .where(eq(branchItems.branchId, targetBranchId))

            // 3. Build a map of masterId -> itemId, preferring ECO versions
            // Also track main branch item IDs for relationship queries
            mainBranchItemIds = mainBranchItemsResult
              .map((bi) => bi.currentItemId)
              .filter((id): id is string => id !== null)

            // First add all main branch items to the resolution map
            // Also build mainItemIdToMasterId for resolving relationships
            for (const bi of mainBranchItemsResult) {
              if (bi.currentItemId && bi.itemMasterId) {
                masterIdToResolvedItemId.set(bi.itemMasterId, bi.currentItemId)
                mainItemIdToMasterId.set(bi.currentItemId, bi.itemMasterId)
              }
            }

            // Then override with ECO branch items (these take precedence)
            for (const bi of ecoBranchItemsResult) {
              if (bi.currentItemId && bi.itemMasterId) {
                masterIdToResolvedItemId.set(bi.itemMasterId, bi.currentItemId)
              }
            }

            // 4. Fetch all resolved items
            const resolvedItemIds = Array.from(
              masterIdToResolvedItemId.values(),
            )
            if (resolvedItemIds.length > 0) {
              allItems = await db
                .select({
                  id: items.id,
                  itemNumber: items.itemNumber,
                  name: items.name,
                  revision: items.revision,
                  state: items.state,
                  itemType: items.itemType,
                  inDesignStructure: items.inDesignStructure,
                  designId: items.designId,
                  masterId: items.masterId,
                })
                .from(items)
                .where(inArray(items.id, resolvedItemIds))
            }
          } else {
            // For main: the item set is the *union* of two sources keyed by
            // masterId — branch_items overlaid on the design's current items —
            // not whichever one happens to be non-empty first.
            //
            // Items created directly on main never get a branch_items row, so
            // "branch_items, else fall back to isCurrent" showed all of them
            // right up until the first ECO merge inserted a row, and from then
            // on showed only the single item that merge released.
            const branchItemsResult = await db
              .select({
                currentItemId: branchItems.currentItemId,
                itemMasterId: branchItems.itemMasterId,
              })
              .from(branchItems)
              .where(eq(branchItems.branchId, targetBranchId))

            const trackedItemIds = branchItemsResult
              .map((bi) => bi.currentItemId)
              .filter((id): id is string => id !== null)

            const itemColumns = {
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              masterId: items.masterId,
            }

            // Baseline: the design's current items. Working copies are excluded
            // so a branch's unreleased drafts cannot be served as main's
            // contents (the same guard VersionResolver.getReleasedItems uses).
            const baselineItems = await db
              .select(itemColumns)
              .from(items)
              .where(
                and(
                  eq(items.designId, designId),
                  eq(items.isCurrent, true),
                  notDeleted(),
                  notWorkingRevision(),
                ),
              )

            const trackedItems =
              trackedItemIds.length > 0
                ? await db
                    .select(itemColumns)
                    .from(items)
                    .where(inArray(items.id, trackedItemIds))
                : []

            // branch_items wins per masterId — it is the explicit record of
            // what this branch points at, where isCurrent is only a global flag.
            const resolvedByMaster = new Map<
              string,
              (typeof baselineItems)[0]
            >()
            for (const item of baselineItems) {
              resolvedByMaster.set(item.masterId, item)
            }
            for (const item of trackedItems) {
              resolvedByMaster.set(item.masterId, item)
            }

            allItems = Array.from(resolvedByMaster.values())

            // Build masterId mappings for relationship resolution. Every item
            // in the set needs one: resolveItemId() re-points a BOM line that
            // still names a superseded revision onto the current one, and it
            // can only do that for masters it knows about.
            for (const item of allItems) {
              masterIdToResolvedItemId.set(item.masterId, item.id)
              mainItemIdToMasterId.set(item.id, item.masterId)
            }
            mainBranchItemIds = allItems.map((i) => i.id)
          }
        } else {
          // Fallback: get isCurrent items for the design (legacy behavior)
          allItems = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              masterId: items.masterId,
            })
            .from(items)
            .where(and(eq(items.designId, designId), eq(items.isCurrent, true)))
        }
      } // end else (!isHistoricalView)

      // Get all BOM relationships where source is in this design
      // If expandExternal=true, target can be from any design (cross-design references)
      const itemIds = allItems.map((i) => i.id)

      // Build a reverse map from itemId -> masterId for all items
      const itemIdToMasterId = new Map<string, string>()
      for (const item of allItems) {
        itemIdToMasterId.set(item.id, item.masterId)
      }

      // For historical views and ECO branches, relationships might be stored with
      // different item version IDs. We need to find all item versions that share
      // masterIds with our items, then query relationships using those IDs.
      const masterIds = allItems.map((i) => i.masterId)

      // Get ALL item versions that share these masterIds (to find relationships)
      const allVersionsWithMasterIds =
        masterIds.length > 0
          ? await db
              .select({ id: items.id, masterId: items.masterId })
              .from(items)
              .where(inArray(items.masterId, masterIds))
          : []

      // Build comprehensive ID lists for relationship queries
      const allItemIdsForRelationships = allVersionsWithMasterIds.map(
        (i) => i.id,
      )

      // Also add main branch IDs if available
      const relationshipQueryIds = [
        ...new Set([
          ...allItemIdsForRelationships,
          ...mainBranchItemIds,
          ...itemIds,
        ]),
      ]

      // Build masterId lookup for all item versions (for relationship resolution)
      for (const item of allVersionsWithMasterIds) {
        if (!mainItemIdToMasterId.has(item.id)) {
          mainItemIdToMasterId.set(item.id, item.masterId)
        }
      }

      let relationships =
        relationshipQueryIds.length > 0
          ? await db
              .select()
              .from(itemRelationships)
              .where(
                and(
                  inArray(itemRelationships.sourceId, relationshipQueryIds),
                  // Only filter targetId if NOT expanding external (legacy behavior)
                  ...(expandExternal
                    ? []
                    : [
                        inArray(
                          itemRelationships.targetId,
                          relationshipQueryIds,
                        ),
                      ]),
                  eq(itemRelationships.relationshipType, 'BOM'),
                ),
              )
          : []

      // Find external target IDs (items from other designs)
      const externalTargetIds = relationships
        .map((r) => r.targetId)
        .filter((id) => !itemIds.includes(id))

      // Fetch external items with their design info
      let externalItems =
        externalTargetIds.length > 0
          ? await db
              .select({
                id: items.id,
                itemNumber: items.itemNumber,
                name: items.name,
                revision: items.revision,
                state: items.state,
                itemType: items.itemType,
                inDesignStructure: items.inDesignStructure,
                designId: items.designId,
                designCode: designs.code,
                designName: designs.name,
              })
              .from(items)
              .leftJoin(designs, eq(items.designId, designs.id))
              .where(inArray(items.id, externalTargetIds))
          : []

      // Recursively expand external items' children (for cross-design BOM traversal)
      // This allows viewing the full tree when parts reference items from other designs
      if (expandExternal && externalItems.length > 0) {
        const allExternalItemIds = new Set(externalItems.map((i) => i.id))
        const allExternalItems = [...externalItems]
        let currentExternalIds = [...externalTargetIds]
        const maxDepth = 10 // Prevent infinite loops
        let depth = 0

        while (currentExternalIds.length > 0 && depth < maxDepth) {
          depth++

          // Fetch BOM relationships where source is one of the current external items
          const externalRelationships = await db
            .select()
            .from(itemRelationships)
            .where(
              and(
                inArray(itemRelationships.sourceId, currentExternalIds),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          if (externalRelationships.length === 0) break

          // Add these relationships to the main list
          relationships = [...relationships, ...externalRelationships]

          // Find new external targets we haven't seen yet
          const newExternalTargetIds = externalRelationships
            .map((r) => r.targetId)
            .filter(
              (id) => !itemIds.includes(id) && !allExternalItemIds.has(id),
            )

          if (newExternalTargetIds.length === 0) break

          // Fetch these new external items
          const newExternalItems = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              designCode: designs.code,
              designName: designs.name,
            })
            .from(items)
            .leftJoin(designs, eq(items.designId, designs.id))
            .where(inArray(items.id, newExternalTargetIds))

          // Add to our collections
          for (const item of newExternalItems) {
            allExternalItemIds.add(item.id)
            allExternalItems.push(item)
          }

          // Continue with these new external items in the next iteration
          currentExternalIds = newExternalTargetIds
        }

        // Update externalItems with all discovered external items
        externalItems = allExternalItems
      }

      // Build design map for external items
      const externalDesignMap = new Map(
        externalItems.map((item) => [
          item.id,
          { code: item.designCode, name: item.designName },
        ]),
      )

      // Build a map of children for each item
      // For ECO branches, we need to resolve relationship IDs through masterId mapping
      const childrenMap = new Map<
        string,
        Array<{
          childId: string
          relationshipId: string
          quantity?: number
          findNumber?: number
        }>
      >()
      const hasParent = new Set<string>()

      // Helper to resolve an item ID to the correct version (main or ECO working copy)
      const resolveItemId = (itemId: string): string => {
        // If we're viewing an ECO branch, resolve through masterId
        if (mainItemIdToMasterId.size > 0) {
          const masterId = mainItemIdToMasterId.get(itemId)
          if (masterId) {
            const resolvedId = masterIdToResolvedItemId.get(masterId)
            if (resolvedId) return resolvedId
          }
        }
        // Otherwise return the original ID
        return itemId
      }

      // Track which source-target pairs we've already added to avoid duplicates
      // (same relationship can exist across multiple item versions)
      const addedRelationships = new Set<string>()

      // A BOM line belongs to the item version that owns it, but the query
      // above deliberately reaches across every version sharing a masterId:
      // checkout creates a working copy *without* copying its lines, so on an
      // ECO branch they are still owned by the version it was checked out
      // from. A version's BOM is therefore its own rows when it has any, and
      // its master's other versions' rows only when it has none. Without that
      // first half a released revision that dropped a line would show it
      // again, resurrected from the row its superseded version still owns.
      const relationshipsBySource = new Map<string, typeof relationships>()
      for (const rel of relationships) {
        const resolvedSourceId = resolveItemId(rel.sourceId)
        const owned = relationshipsBySource.get(resolvedSourceId)
        if (owned) {
          owned.push(rel)
        } else {
          relationshipsBySource.set(resolvedSourceId, [rel])
        }
      }

      for (const [resolvedSourceId, sourceRels] of relationshipsBySource) {
        const ownRels = sourceRels.filter(
          (r) => r.sourceId === resolvedSourceId,
        )
        const effectiveRels = ownRels.length > 0 ? ownRels : sourceRels

        for (const rel of effectiveRels) {
          const resolvedTargetId = resolveItemId(rel.targetId)

          // Deduplicate by resolved source-target pair
          const relKey = `${resolvedSourceId}:${resolvedTargetId}`
          if (addedRelationships.has(relKey)) continue
          addedRelationships.add(relKey)

          if (!childrenMap.has(resolvedSourceId)) {
            childrenMap.set(resolvedSourceId, [])
          }
          childrenMap.get(resolvedSourceId)!.push({
            childId: resolvedTargetId,
            relationshipId: rel.id,
            quantity: rel.quantity ? Number(rel.quantity) : undefined,
            findNumber: rel.findNumber ?? undefined,
          })
          hasParent.add(resolvedTargetId)
        }
      }

      // Create item lookup map (includes both local and external items)
      const itemMap = new Map([
        ...allItems.map(
          (i) =>
            [
              i.id,
              {
                ...i,
                designCode: undefined as string | undefined,
                designName: undefined as string | undefined,
              },
            ] as const,
        ),
        ...externalItems.map(
          (i) =>
            [
              i.id,
              {
                ...i,
                designCode: i.designCode ?? undefined,
                designName: i.designName ?? undefined,
              },
            ] as const,
        ),
      ])

      // Build tree nodes recursively
      const buildNode = (
        itemId: string,
        visitedSet: Set<string>,
      ): BOMTreeNode | null => {
        if (visitedSet.has(itemId)) return null // Prevent cycles
        const item = itemMap.get(itemId)
        if (!item) return null

        visitedSet.add(itemId)

        // Check if this is an external item (from a different design)
        const isExternal = item.designId !== designId
        const designInfo = isExternal ? externalDesignMap.get(itemId) : null

        const children = childrenMap.get(itemId) || []
        const childNodes = children
          .map((c) => {
            const node = buildNode(c.childId, new Set(visitedSet))
            if (node) {
              node.quantity = c.quantity
              node.findNumber = c.findNumber
              node.relationshipId = c.relationshipId
            }
            return node
          })
          .filter((n): n is BOMTreeNode => n !== null)

        return {
          itemId: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          children: childNodes.length > 0 ? childNodes : undefined,
          // Cross-design reference fields
          designId: item.designId,
          designCode: designInfo?.code ?? (item as any).designCode ?? undefined,
          designName: designInfo?.name ?? (item as any).designName ?? undefined,
          isExternal,
        }
      }

      // =====================================================================
      // Cross-design references: fetch and add as additional root items
      // =====================================================================
      const crossRefs =
        await CrossDesignReferenceService.getReferencesForDesign(
          designId,
          branchId,
        )

      // Build a set of cross-ref item IDs and a map of itemId -> crossRefId
      const crossRefItemIds = new Set<string>()
      const crossRefIdMap = new Map<string, string>() // referencedItemId -> crossRef.id

      for (const ref of crossRefs) {
        if (ref.inDesignStructure !== false) {
          crossRefItemIds.add(ref.referencedItemId)
          crossRefIdMap.set(ref.referencedItemId, ref.id)
        }
      }

      // Fetch cross-referenced items with design info (if any exist)
      if (crossRefItemIds.size > 0) {
        // Resolve cross-ref items to their latest released version
        // (XREFs store specific item version IDs which may become stale)
        const resolvedCrossRefItems =
          await VersionResolver.resolveRelationshipTargets(
            Array.from(crossRefItemIds),
            { type: 'released', designId: designId },
          )

        // Rebuild crossRefItemIds and crossRefIdMap with resolved IDs
        const originalCrossRefIdMap = new Map(crossRefIdMap)
        crossRefItemIds.clear()
        crossRefIdMap.clear()
        for (const [originalId, resolvedItem] of resolvedCrossRefItems) {
          crossRefItemIds.add(resolvedItem.id)
          const crossRefId = originalCrossRefIdMap.get(originalId)
          if (crossRefId) {
            crossRefIdMap.set(resolvedItem.id, crossRefId)
          }
        }

        // Fetch resolved items with design info
        const resolvedItemIds = Array.from(crossRefItemIds)
        if (resolvedItemIds.length > 0) {
          const crossRefItems = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              masterId: items.masterId,
              designCode: designs.code,
              designName: designs.name,
            })
            .from(items)
            .leftJoin(designs, eq(items.designId, designs.id))
            .where(inArray(items.id, resolvedItemIds))

          // Add to itemMap and externalDesignMap
          for (const item of crossRefItems) {
            itemMap.set(item.id, {
              ...item,
              designCode: item.designCode ?? undefined,
              designName: item.designName ?? undefined,
            })
            if (item.designCode || item.designName) {
              externalDesignMap.set(item.id, {
                code: item.designCode,
                name: item.designName,
              })
            }
          }
        }

        // Fetch BOM children of cross-referenced items for subtree expansion
        let crossRefCurrentIds = Array.from(crossRefItemIds)
        const allCrossRefExternalIds = new Set(crossRefItemIds)
        let depth = 0
        const maxCrossRefDepth = 10

        while (crossRefCurrentIds.length > 0 && depth < maxCrossRefDepth) {
          depth++

          const childRels = await db
            .select()
            .from(itemRelationships)
            .where(
              and(
                inArray(itemRelationships.sourceId, crossRefCurrentIds),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          if (childRels.length === 0) break

          // Add relationships
          for (const rel of childRels) {
            const relKey = `${rel.sourceId}:${rel.targetId}`
            if (!addedRelationships.has(relKey)) {
              addedRelationships.add(relKey)
              if (!childrenMap.has(rel.sourceId)) {
                childrenMap.set(rel.sourceId, [])
              }
              childrenMap.get(rel.sourceId)!.push({
                childId: rel.targetId,
                relationshipId: rel.id,
                quantity: rel.quantity ? Number(rel.quantity) : undefined,
                findNumber: rel.findNumber ?? undefined,
              })
              hasParent.add(rel.targetId)
            }
          }

          // Find new external targets
          const newTargetIds = childRels
            .map((r) => r.targetId)
            .filter(
              (id) => !itemIds.includes(id) && !allCrossRefExternalIds.has(id),
            )

          if (newTargetIds.length === 0) break

          const newItems = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              masterId: items.masterId,
              designCode: designs.code,
              designName: designs.name,
            })
            .from(items)
            .leftJoin(designs, eq(items.designId, designs.id))
            .where(inArray(items.id, newTargetIds))

          for (const item of newItems) {
            allCrossRefExternalIds.add(item.id)
            itemMap.set(item.id, {
              ...item,
              designCode: item.designCode ?? undefined,
              designName: item.designName ?? undefined,
            })
            if (item.designCode || item.designName) {
              externalDesignMap.set(item.id, {
                code: item.designCode,
                name: item.designName,
              })
            }
          }

          crossRefCurrentIds = newTargetIds
        }
      }

      // Find root items: Parts with inDesignStructure=true and no parent
      const roots: Array<BOMTreeNode> = []
      for (const item of allItems) {
        // Root items are Parts that are marked as in-structure and have no parent BOM relationship
        if (
          !hasParent.has(item.id) &&
          item.itemType === 'Part' &&
          item.inDesignStructure !== false
        ) {
          const node = buildNode(item.id, new Set())
          if (node) {
            roots.push(node)
          }
        }
      }

      // Add cross-design references as roots
      for (const refItemId of crossRefItemIds) {
        const node = buildNode(refItemId, new Set())
        if (node) {
          node.isCrossDesignRef = true
          node.crossReferenceId = crossRefIdMap.get(refItemId)
          roots.push(node)
        }
      }

      // Sort roots by item number
      roots.sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

      // Find orphan items: Items not in the BOM structure
      // - Parts with inDesignStructure=false (removed from structure)
      // - Documents and Requirements (never in BOM structure)
      // Note: Child parts (those with a parent) are NOT orphans - they're managed via their parent
      const orphans: Array<OrphanItem> = allItems
        .filter((item) => {
          // Non-Part items are always orphans
          if (item.itemType !== 'Part') return true
          // Parts with inDesignStructure=false are orphans
          if (item.inDesignStructure === false) return true
          // Parts that are children (have a parent) are NOT orphans
          return false
        })
        .map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
        }))
        .sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

      return { roots, orphans }
    }),
  ),
)

// GET /api/designs/:id/tags
app.get(
  '/:id/tags',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const designId = parseDesignId(params)
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      await requireDesignAccess(user.id, designId)

      const tagsList = await DesignService.listTags(designId)

      return { tags: tagsList }
    }),
  ),
)

// POST /api/designs/:id/tags
app.post(
  '/:id/tags',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof tagCreateSchema>>(
      {
        // Cross-program authority, or program admin/lead, can tag a design.
        access: async ({ params, user }) => {
          const design = await DesignService.getById(params.id)
          if (!design) throw new NotFoundError('Design', params.id)
          if (!design.programId) return
          if (await AccessControlService.hasCrossProgramAccess(user.id)) return

          const role = await ProgramService.getUserRole(
            user.id,
            design.programId,
          )
          if (role !== 'admin' && role !== 'lead') {
            throw new PermissionDeniedError('design tags', 'create')
          }
        },
        body: tagCreateSchema,
      },
      async ({ body, params, user }) => {
        const designId = params.id
        const tag = await DesignService.createTag(designId, body, user.id)

        return created({ tag })
      },
    ),
  ),
)

// =============================================
// Routes with :designId parameter
// =============================================

// POST /api/designs/:designId/gap-analysis
app.post(
  '/:designId/gap-analysis',
  adapt(
    apiHandler<{ designId: string }, z.infer<typeof gapAnalysisRequestSchema>>(
      {
        // The five analysis routes below read a whole design — its
        // requirements, their coverage and the gaps between them — and none of
        // them declared an instance gate, so a member of any program could
        // enumerate another program's requirements by naming its design id.
        // The services behind them take a designId and check nothing
        // themselves.
        access: ({ params, user }) =>
          requireDesignAccess(user.id, params.designId),
        body: gapAnalysisRequestSchema,
      },
      async ({ body, params }) => {
        const result = await GapAnalysisService.analyze({
          designId: params.designId,
          ...body,
        })

        return result
      },
    ),
  ),
)

// GET /api/designs/:designId/gap-analysis
app.get(
  '/:designId/gap-analysis',
  adapt(
    apiHandler<{ designId: string }>(
      {
        access: ({ params, user }) =>
          requireDesignAccess(user.id, params.designId),
      },
      async ({ params }) => {
        const { designId } = params

        // GET request runs with default settings
        const result = await GapAnalysisService.analyze({ designId })

        return result
      },
    ),
  ),
)

// GET /api/designs/:designId/requirements-coverage
app.get(
  '/:designId/requirements-coverage',
  adapt(
    apiHandler<{ designId: string }>(
      {
        access: ({ params, user }) =>
          requireDesignAccess(user.id, params.designId),
      },
      async ({ params }) => {
        const { designId } = params
        const coverage = await RequirementService.getCoverage(designId)

        return coverage
      },
    ),
  ),
)

// GET /api/designs/:designId/test-coverage
app.get(
  '/:designId/test-coverage',
  adapt(
    apiHandler<{ designId: string }>(
      {
        access: ({ params, user }) =>
          requireDesignAccess(user.id, params.designId),
      },
      async ({ params }) => {
        const { designId } = params
        const coverage = await VerificationService.getTestCoverage(designId)

        return { coverage }
      },
    ),
  ),
)

// GET /api/designs/:designId/verification-gaps
app.get(
  '/:designId/verification-gaps',
  adapt(
    apiHandler<{ designId: string }>(
      {
        access: ({ params, user }) =>
          requireDesignAccess(user.id, params.designId),
      },
      async ({ params }) => {
        const { designId } = params
        const gaps = await VerificationService.getVerificationGaps(designId)

        return { gaps }
      },
    ),
  ),
)

export default app
