import { Hono } from 'hono'
import { adapt } from '../adapter'
import type { Document } from '@/lib/items/types/document'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/documents/:id
app.get(
  '/:id',
  adapt(
    apiHandler({ permission: ['documents', 'read'] }, async ({ params }) => {
      const document = await ItemService.findById(params.id)
      if (!document) throw new NotFoundError('Document', params.id)
      return { document }
    }),
  ),
)

// PUT /api/documents/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
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
    apiHandler({ permission: ['documents', 'delete'] }, async ({ params }) => {
      await ItemService.delete(params.id)
      return { success: true }
    }),
  ),
)

export default app
