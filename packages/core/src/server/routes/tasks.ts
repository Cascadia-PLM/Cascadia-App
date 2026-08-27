// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { Task } from '@/lib/items/types/task'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
import { requireItemDesignAccess } from '@/lib/auth/access'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Tasks')

const app = new Hono()

async function requireTaskAccess(userId: string, id: string) {
  z.string().uuid().parse(id)
  const task = await ItemService.findById(id)
  if (!task || task.itemType !== 'Task') throw new NotFoundError('Task', id)
  await requireItemDesignAccess(userId, task)
  return task
}

// GET /api/tasks/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['tasks', 'read'] },
      async ({ params, user }) => {
        const task = await requireTaskAccess(user.id, params.id)
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
      { permission: ['tasks', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        await requireTaskAccess(user.id, params.id)
        const task = await ItemService.update<Task>(params.id, data, user.id)
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
        await requireTaskAccess(user.id, params.id)
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
