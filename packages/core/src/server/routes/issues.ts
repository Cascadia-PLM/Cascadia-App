// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { Issue } from '@/lib/items/types/issue'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
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
      async ({ params }) => {
        const { id } = params
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
      { permission: ['issues', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const issue = await ItemService.update<Issue>(params.id, data, user.id)
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
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
