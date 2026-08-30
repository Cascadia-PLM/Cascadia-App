// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { ScopeGraphEdge, ScopeGraphNode } from '@/lib/api/scope-graph'
import {
  ProgramService,
  memberAddSchema,
  memberUpdateSchema,
  programCreateSchema,
  programUpdateSchema,
} from '@/lib/services/ProgramService'
import { CommitGraphService } from '@/lib/services/CommitGraphService'
import { DesignService } from '@/lib/services/DesignService'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { requirePermission } from '@/lib/auth/server'
import { NotFoundError, PermissionDeniedError } from '@/lib/errors'
import { db } from '@/lib/db'
import { items } from '@/lib/db/schema/items'
import { notDeleted } from '@/lib/db/filters'
import { apiHandler, created } from '@/lib/api/handler'
import {
  designNodeId,
  makeDesignNode,
  makeProgramNode,
  makeScopeEdge,
  programNodeId,
  scopeGraphResponseSchema,
} from '@/lib/api/scope-graph'

const adapt = tagged('Programs')

const app = new Hono()

// GET /api/programs - pagination, sorting, filtering, optional status counts
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
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

      // Accessible program IDs: null = admin (all programs), array = specific
      const programIds = await AccessControlService.getAccessibleProgramIds(
        user.id,
      )

      const result = await ProgramService.search({
        programIds,
        limit,
        offset,
        sortField,
        sortDirection,
        columnFilters,
        globalSearch,
      })

      const response: Record<string, unknown> = {
        programs: result.items,
        total: result.total,
      }

      if (includeCounts) {
        const [activeCount, onHoldCount, completedCount] = await Promise.all([
          ProgramService.search({
            programIds,
            limit: 1,
            columnFilters: { status: ['Active'] },
          }),
          ProgramService.search({
            programIds,
            limit: 1,
            columnFilters: { status: ['On Hold'] },
          }),
          ProgramService.search({
            programIds,
            limit: 1,
            columnFilters: { status: ['Completed'] },
          }),
        ])
        response.counts = {
          active: activeCount.total,
          onHold: onHoldCount.total,
          completed: completedCount.total,
        }
      }

      return response
    }),
  ),
)

/**
 * A program as returned by the create/read paths. Passthrough: the columns
 * beyond these are the table's own and are not part of the frozen contract.
 */
const programResponseSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
  })
  .passthrough()

// POST /api/programs
app.post(
  '/',
  adapt(
    apiHandler(
      {
        body: programCreateSchema,
        permission: ['programs', 'create'],
        openapi: {
          summary: 'Create a program',
          description:
            'Programs are the permission boundary: the creator is not made a ' +
            'member, so add members with POST /api/v1/programs/:id/members. ' +
            '`code` is unique system-wide.',
          responses: {
            201: { schema: z.object({ program: programResponseSchema }) },
          },
        },
      },
      async ({ body: data, user }) => {
        const program = await ProgramService.create(data, user.id)

        return created({ program })
      },
    ),
  ),
)

// GET /api/programs/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      // Programs are the permission boundary: detail reads require
      // membership (or the cross-program bypass inside canAccessProgram),
      // with programs:update as a narrower read-only fallback for custom
      // roles that may edit programs without holding the full bypass. The
      // fallback is deliberately NOT programs:read — every built-in role
      // has that, so it would expose any program's metadata (customer,
      // contract number) to any authenticated user by ID.
      const canAccess = await AccessControlService.canAccessProgram(
        user.id,
        params.id,
      )
      if (!canAccess) {
        await requirePermission(request, 'programs', 'update')
      }

      const program = await ProgramService.getById(params.id)
      if (!program) throw new NotFoundError('Program', params.id)

      // Include user's role if they're a member
      const userRole = await ProgramService.getUserRole(user.id, params.id)

      return { program: { ...program, userRole } }
    }),
  ),
)

// GET /api/programs/:id/graph — scope graph for the drill-down graph view.
// Program node + a design node per (non-archived) design in the program.
// Designs then expand further via GET /api/v1/designs/:id/graph.
app.get(
  '/:id/graph',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Get the scope graph for a program',
          description:
            'Returns the program as a graph node with its designs below it, plus aggregated per-item-type counts across those designs for the graph view type filter.',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
          responses: {
            200: { schema: scopeGraphResponseSchema },
          },
        },
      },
      async ({ params, request, user }) => {
        // Same access rule as GET /api/programs/:id
        const canAccess = await AccessControlService.canAccessProgram(
          user.id,
          params.id,
        )
        if (!canAccess) {
          await requirePermission(request, 'programs', 'update')
        }

        const program = await ProgramService.getById(params.id)
        if (!program) throw new NotFoundError('Program', params.id)

        const nodes: Array<ScopeGraphNode> = [makeProgramNode(program, 0)]
        const edges: Array<ScopeGraphEdge> = []

        const programDesigns = await DesignService.listByProgram(params.id)
        for (const design of programDesigns) {
          nodes.push(makeDesignNode(design, 1))
          edges.push(
            makeScopeEdge(programNodeId(params.id), designNodeId(design.id)),
          )
        }

        // Aggregated per-type counts across the program's designs, so the
        // type filter can be offered before any design is expanded.
        const designIds = programDesigns.map((d) => d.id)
        const typeCounts =
          designIds.length > 0
            ? await db
                .select({
                  itemType: items.itemType,
                  count: sql<number>`count(*)::int`,
                })
                .from(items)
                .where(
                  and(
                    inArray(items.designId, designIds),
                    eq(items.isCurrent, true),
                    notDeleted(),
                  ),
                )
                .groupBy(items.itemType)
                .orderBy(asc(items.itemType))
            : []

        return { nodes, edges, availableItemTypes: typeCounts }
      },
    ),
  ),
)

// PUT /api/programs/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof programUpdateSchema>>(
      {
        // Program admins manage their own program; anyone else needs the
        // RBAC grant. Authorized before the body is parsed.
        access: async ({ params, request, user }) => {
          const userRole = await ProgramService.getUserRole(user.id, params.id)
          if (userRole !== 'admin') {
            await requirePermission(request, 'programs', 'update')
          }
        },
        body: programUpdateSchema,
      },
      async ({ params, body, user }) => {
        const program = await ProgramService.update(params.id, body, user.id)
        return { program }
      },
    ),
  ),
)

// DELETE /api/programs/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      // Check if user is an admin of the program AND has org-level permission
      const userRole = await ProgramService.getUserRole(user.id, params.id)
      if (userRole !== 'admin') {
        await requirePermission(request, 'programs', 'delete')
      }

      await ProgramService.delete(params.id)
      return { success: true }
    }),
  ),
)

// GET /api/programs/:id/history/graph
app.get(
  '/:id/history/graph',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const program = await ProgramService.getById(params.id)
      if (!program) {
        throw new NotFoundError('Program', params.id)
      }

      // Check access
      const hasBypass = await AccessControlService.hasCrossProgramAccess(
        user.id,
      )
      if (!hasBypass) {
        const canAccess = await ProgramService.canUserAccess(user.id, params.id)
        if (!canAccess) {
          throw new PermissionDeniedError('program history', 'read')
        }
      }

      // Parse query params
      const url = new URL(request.url, 'http://localhost')
      const designIdsParam = url.searchParams.get('designIds')
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const designIds = designIdsParam
        ? designIdsParam.split(',').filter(Boolean)
        : undefined

      return await CommitGraphService.buildProgramGraph(
        params.id,
        program,
        designIds,
        limit,
      )
    }),
  ),
)

// GET /api/programs/:id/members
app.get(
  '/:id/members',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      // Any member may see the team; cross-program authority bypasses via
      // canAccessProgram, and programs:update reads the team the same way
      // it reads the program itself.
      const canAccess = await AccessControlService.canAccessProgram(
        user.id,
        params.id,
      )
      if (!canAccess) {
        await requirePermission(request, 'programs', 'update')
      }

      const members = await ProgramService.listMembers(params.id)
      return { members }
    }),
  ),
)

// POST /api/programs/:id/members
app.post(
  '/:id/members',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof memberAddSchema>>(
      {
        // Program admins and leads manage the team; anyone else needs the
        // RBAC programs:manage grant (the Administrator role has it).
        // Authorized before the body is parsed, so outsiders get a 403 rather
        // than a schema tour.
        access: async ({ params, request, user }) => {
          const userRole = await ProgramService.getUserRole(user.id, params.id)
          if (userRole !== 'admin' && userRole !== 'lead') {
            await requirePermission(request, 'programs', 'manage')
          }
        },
        body: memberAddSchema,
      },
      async ({ params, body, user }) => {
        const userRole = await ProgramService.getUserRole(user.id, params.id)

        if (userRole === 'lead' && body.role === 'admin') {
          // A lead must not mint program admins — that is a privilege the
          // lead does not hold themselves.
          throw new PermissionDeniedError('program admin membership', 'grant')
        }

        const member = await ProgramService.addMember(
          params.id,
          body.userId,
          body.role,
          user.id,
        )

        return created({ member })
      },
    ),
  ),
)

// PUT /api/programs/:id/members/:userId
app.put(
  '/:id/members/:userId',
  adapt(
    apiHandler<
      { id: string; userId: string },
      z.infer<typeof memberUpdateSchema>
    >(
      {
        access: async ({ params, request, user }) => {
          const userRole = await ProgramService.getUserRole(user.id, params.id)
          if (userRole !== 'admin') {
            await requirePermission(request, 'programs', 'manage')
          }
        },
        // The same strict schema `updateMember` parses with. It still guards
        // the last admin against demotion and re-baselines flags on a role
        // change; only the parse moves out here.
        body: memberUpdateSchema,
      },
      async ({ params, body }) => {
        const member = await ProgramService.updateMember(
          params.id,
          params.userId,
          body,
        )
        return { member }
      },
    ),
  ),
)

// DELETE /api/programs/:id/members/:userId
app.delete(
  '/:id/members/:userId',
  adapt(
    apiHandler<{ id: string; userId: string }>(
      {},
      async ({ params, request, user }) => {
        const userRole = await ProgramService.getUserRole(user.id, params.id)
        if (userRole !== 'admin') {
          await requirePermission(request, 'programs', 'manage')
        }

        await ProgramService.removeMember(params.id, params.userId)
        return { success: true }
      },
    ),
  ),
)

export default app
