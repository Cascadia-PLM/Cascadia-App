// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { Task } from '@/lib/items/types/task'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
import { taskUpdateSchema } from '@/lib/api/schemas'
import { requireItemAccess } from '@/lib/auth/access'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Tasks')

const app = new Hono()

// GET /api/tasks/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['tasks', 'read'] },
      async ({ params, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        const task = await ItemService.findById(id)
        if (!task) throw new NotFoundError('Task', id)
        return { task }
      },
    ),
  ),
)

// PUT /api/tasks/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['tasks', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: taskUpdateSchema,
      },
      // The schema permits `null` where the column is nullable, which the
      // Task interface spells as an absent optional; both the service and the
      // type handler read null as "clear the column".
      async ({ params, body, user }) => {
        const task = await ItemService.update<Task>(
          params.id,
          body as Partial<Task>,
          user.id,
        )
        return { task }
      },
    ),
  ),
)

// DELETE /api/tasks/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['tasks', 'delete'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
