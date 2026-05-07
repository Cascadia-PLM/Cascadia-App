import { Hono } from 'hono'
import { adapt } from '../adapter'
import type { WorkOrderStatus } from '@/lib/items/types/work-order'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { WorkInstructionExecutionService } from '@/lib/services/WorkInstructionExecutionService'
import {
  workOrderCreateSchema,
  workOrderUpdateSchema,
} from '@/lib/items/types/work-order'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'

const app = new Hono()

// GET /api/work-orders
app.get(
  '/',
  adapt(
    apiHandler({ permission: ['work_orders', 'read'] }, async ({ request }) => {
      const url = new URL(request.url)
      const status = url.searchParams.get('status') || undefined
      const partId = url.searchParams.get('partId') || undefined
      const search = url.searchParams.get('search') || undefined
      const programId = url.searchParams.get('programId') || undefined
      const limit = url.searchParams.get('limit')
        ? parseInt(url.searchParams.get('limit')!)
        : undefined
      const offset = url.searchParams.get('offset')
        ? parseInt(url.searchParams.get('offset')!)
        : undefined

      const result = await WorkOrderService.search({
        status,
        partId,
        search,
        programId,
        limit,
        offset,
      })

      return result
    }),
  ),
)

// POST /api/work-orders
app.post(
  '/',
  adapt(
    apiHandler(
      { permission: ['work_orders', 'create'] },
      async ({ request, user }) => {
        const body = await request.json()
        const data = workOrderCreateSchema.parse(body)

        const workOrder = await WorkOrderService.create(data, user.id)

        return new Response(JSON.stringify({ data: { workOrder } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ),
  ),
)

// GET /api/work-orders/:id
app.get(
  '/:id',
  adapt(
    apiHandler({ permission: ['work_orders', 'read'] }, async ({ params }) => {
      const workOrder = await WorkOrderService.findById(params.id)
      if (!workOrder) {
        throw new NotFoundError('Work Order', params.id)
      }

      return { workOrder }
    }),
  ),
)

// PUT /api/work-orders/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['work_orders', 'update'] },
      async ({ params, request, user }) => {
        const body = await request.json()
        const data = workOrderUpdateSchema.parse(body)

        const workOrder = await WorkOrderService.update(
          params.id,
          data,
          user.id,
        )

        return { workOrder }
      },
    ),
  ),
)

// DELETE /api/work-orders/:id
app.delete(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['work_orders', 'delete'] },
      async ({ params }) => {
        await WorkOrderService.delete(params.id)

        return { success: true }
      },
    ),
  ),
)

// GET /api/work-orders/:id/executions
app.get(
  '/:id/executions',
  adapt(
    apiHandler(
      { permission: ['work_orders', 'read'] },
      async ({ params, request }) => {
        const url = new URL(request.url)
        const limit = url.searchParams.get('limit')
          ? parseInt(url.searchParams.get('limit')!)
          : undefined
        const offset = url.searchParams.get('offset')
          ? parseInt(url.searchParams.get('offset')!)
          : undefined

        const result = await WorkInstructionExecutionService.listByWorkOrder(
          params.id,
          { limit, offset },
        )

        return result
      },
    ),
  ),
)

// PUT /api/work-orders/:id/status
app.put(
  '/:id/status',
  adapt(
    apiHandler(
      { permission: ['work_orders', 'update'] },
      async ({ params, request, user }) => {
        const body = await request.json()
        const { status } = body as Partial<{ status: WorkOrderStatus }>

        if (
          !status ||
          !['Not Started', 'In Progress', 'Complete', 'Cancelled'].includes(
            status,
          )
        ) {
          throw new ValidationError('Invalid status value')
        }

        const workOrder = await WorkOrderService.updateStatus(
          params.id,
          status,
          user.id,
        )

        return { workOrder }
      },
    ),
  ),
)

export default app
