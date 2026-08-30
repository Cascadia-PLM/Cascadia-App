// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { BranchService } from '@/lib/services/BranchService'
import { ProgramService } from '@/lib/services/ProgramService'
import { DesignService } from '@/lib/services/DesignService'
import { CommitService } from '@/lib/services/CommitService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { NotFoundError, PermissionDeniedError } from '@/lib/errors'
import { requireBranchAccess } from '@/lib/auth/access'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { itemListSchema } from '@/lib/api/schemas'

const adapt = tagged('Branches')

const app = new Hono()

// GET /api/branches/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params
      const { branch } = await requireBranchAccess(user.id, id)
      return { branch }
    }),
  ),
)

/**
 * Branch flags. Both are tri-state on the wire: absent leaves the flag alone,
 * `true` and `false` mean lock/unlock. Archiving is one-way — `isArchived:
 * false` has never un-archived anything and the schema does not pretend it
 * does.
 */
const branchFlagsSchema = z.object({
  isLocked: z.boolean().optional(),
  isArchived: z.literal(true).optional(),
})

// PUT /api/branches/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof branchFlagsSchema>>(
      { body: branchFlagsSchema },
      async ({ params, body: data, user }) => {
        const { id } = params
        const branch = await BranchService.getById(id)
        if (!branch) throw new NotFoundError('Branch', id)

        const design = await DesignService.getById(branch.designId)
        if (!design) throw new NotFoundError('Design', branch.designId)

        // Need lead/admin access to lock/unlock
        if (design.programId) {
          const role = await ProgramService.getUserRole(
            user.id,
            design.programId,
          )
          if (role !== 'admin' && role !== 'lead') {
            throw new PermissionDeniedError('branch', 'update')
          }
        }

        if (data.isLocked === true) {
          await BranchService.lockBranch(id)
        } else if (data.isLocked === false) {
          await BranchService.unlockBranch(id)
        }

        if (data.isArchived === true) {
          await BranchService.archiveBranch(id)
        }

        const updatedBranch = await BranchService.getById(id)
        return { branch: updatedBranch }
      },
    ),
  ),
)

// GET /api/branches/:id/commits
app.get(
  '/:id/commits',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const { id } = params
      await requireBranchAccess(user.id, id)

      const url = new URL(request.url)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const since = url.searchParams.get('since')
      const until = url.searchParams.get('until')

      const commits = await CommitService.getHistory(id, {
        limit,
        offset,
        since: since ? new Date(since) : undefined,
        until: until ? new Date(until) : undefined,
      })

      return { commits }
    }),
  ),
)

// GET /api/branches/:id/items
app.get(
  '/:id/items',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const { id } = params
      await requireBranchAccess(user.id, id)

      const query = parseQuery(request, itemListSchema)

      const result = await VersionResolver.getBranchItems(id, {
        itemType: query.itemType,
        state: query.state,
        search: query.search,
        includeDeleted: query.includeDeleted,
        limit: query.limit,
        offset: query.offset,
      })

      return { items: result.items, total: result.total }
    }),
  ),
)

// GET /api/branches/:id/status
app.get(
  '/:id/status',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params
      await requireBranchAccess(user.id, id)

      const status = await BranchService.getBranchStatus(id)
      return { status }
    }),
  ),
)

export default app
