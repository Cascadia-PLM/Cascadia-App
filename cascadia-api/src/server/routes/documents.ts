// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { Document } from '@cascadia/commons/items/types/document'
import { ItemService } from '@/items/services/ItemService'
import { NotFoundError } from '@/errors'
import { apiHandler } from '@/api/handler'
import { documentUpdateSchema } from '@/api/schemas'
import { requireItemAccess } from '@/auth/access'
// Register item types (server-side version)
import '@/items/registerItemTypes.server'

const adapt = tagged('Documents')

const app = new Hono()

// GET /api/documents/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
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
      {
        permission: ['documents', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: documentUpdateSchema,
      },
      // The schema permits `null` where the column is nullable, which the
      // Document interface spells as an absent optional.
      async ({ params, body, user }) => {
        const document = await ItemService.update<Document>(
          params.id,
          body as Partial<Document>,
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
        await requireItemAccess(user.id, params.id)
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

export default app
