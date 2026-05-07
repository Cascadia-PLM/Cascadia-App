import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { Task } from '@/lib/items/types/task'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Tasks')

const app = new Hono()

// GET /api/tasks/:id
app.get(
  '/:id',
  adapt(
    apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
      const task = await ItemService.findById(params.id)
      if (!task) throw new NotFoundError('Task', params.id)
      return { task }
    }),
  ),
)

// PUT /api/tasks/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['parts', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
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
    apiHandler({ permission: ['parts', 'delete'] }, async ({ params }) => {
      await ItemService.delete(params.id)
      return { success: true }
    }),
  ),
)

export default app
