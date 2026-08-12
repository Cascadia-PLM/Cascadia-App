// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { Document } from '@/lib/items/types/document'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Documents')

const app = new Hono()

// GET /api/documents/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['documents', 'read'] },
      async ({ params }) => {
        const { id } = params
        const document = await ItemService.findById(id)
        if (!document) throw new NotFoundError('Document', id)
        return { document }
      },
    ),
  ),
)

// PUT /api/documents/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['documents', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const document = await ItemService.update<Document>(
          params.id,
          data,
          user.id,
        )
        return { document }
      },
    ),
  ),
)

// DELETE /api/documents/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['documents', 'delete'] },
      async ({ params, user }) => {
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
