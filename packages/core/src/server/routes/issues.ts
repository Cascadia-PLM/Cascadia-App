// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { Issue } from '@/lib/items/types/issue'
import { ItemService } from '@/lib/items/services/ItemService'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { NotFoundError, PermissionDeniedError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
import { issueUpdateSchema } from '@/lib/api/schemas'
import { requireItemAccess } from '@/lib/auth/access'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Issues')

const app = new Hono()

// GET /api/issues/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['issues', 'read'] },
      async ({ params, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        const issue = await ItemService.findById(id)
        if (!issue) throw new NotFoundError('Issue', id)
        return { issue }
      },
    ),
  ),
)

// PUT /api/issues/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['issues', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: issueUpdateSchema,
      },
      // The schema permits `null` where the column is nullable, which the
      // Issue interface spells as an absent optional; both the service and the
      // type handler read null as "clear the column".
      async ({ params, body, user }) => {
        const changes = body as Partial<Issue>

        // Setting the program is a write *into* the destination program: the
        // `access` gate above answered for the issue where it sits now, not
        // for where it is being moved to. Clearing it needs no such check —
        // that only narrows the row's reach, to cross-program authority.
        if (
          changes.programId &&
          !(await AccessControlService.canAccessProgram(
            user.id,
            changes.programId,
          ))
        ) {
          throw new PermissionDeniedError('program issues', 'update')
        }

        const issue = await ItemService.update<Issue>(
          params.id,
          changes,
          user.id,
        )
        return { issue }
      },
    ),
  ),
)

// DELETE /api/issues/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['issues', 'delete'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
