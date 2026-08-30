// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { Tool } from '@/lib/items/types/tool'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
import { toolUpdateSchema } from '@/lib/api/schemas'
import { requireItemAccess } from '@/lib/auth/access'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Tools')

const app = new Hono()

// GET /api/tools/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['tools', 'read'] },
      async ({ params, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        const tool = await ItemService.findById(id)
        if (!tool) throw new NotFoundError('Tool', id)
        return { tool }
      },
    ),
  ),
)

// PUT /api/tools/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['tools', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: toolUpdateSchema,
      },
      // The schema permits `null` where the column is nullable, which the
      // Tool interface spells as an absent optional; both the service and the
      // type handler read null as "clear the column".
      async ({ params, body, user }) => {
        const tool = await ItemService.update<Tool>(
          params.id,
          body as Partial<Tool>,
          user.id,
        )
        return { tool }
      },
    ),
  ),
)

// DELETE /api/tools/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['tools', 'delete'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
