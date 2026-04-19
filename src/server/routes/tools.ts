import { Hono } from 'hono'
import { adapt } from '../adapter'
import type { Tool } from '@/lib/items/types/tool'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/tools/:id
app.get(
  '/:id',
  adapt(
    apiHandler({ permission: ['tools', 'read'] }, async ({ params }) => {
      const tool = await ItemService.findById(params.id)
      if (!tool) throw new NotFoundError('Tool', params.id)
      return { tool }
    }),
  ),
)

// PUT /api/tools/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['tools', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const tool = await ItemService.update<Tool>(params.id, data, user.id)
        return { tool }
      },
    ),
  ),
)

// DELETE /api/tools/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({ permission: ['tools', 'delete'] }, async ({ params }) => {
      await ItemService.delete(params.id)
      return { success: true }
    }),
  ),
)

export default app
