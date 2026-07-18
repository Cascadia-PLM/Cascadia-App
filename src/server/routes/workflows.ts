import { Hono } from 'hono'
import { tagged } from '../adapter'
import { WorkflowService } from '@/lib/workflows/WorkflowService'
import { WorkflowApprovalService } from '@/lib/workflows/WorkflowApprovalService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'

const adapt = tagged('Workflows')

const app = new Hono()

// GET /api/workflows
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request }) => {
      const url = new URL(request.url)
      const isActive = url.searchParams.get('isActive')
      const definitionType = url.searchParams.get('type') as
        | 'lifecycle'
        | 'workflow'
        | null
      const limit = Math.min(
        parseInt(url.searchParams.get('limit') || '100', 10),
        500,
      )
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)

      const allWorkflows = await WorkflowService.list({
        isActive:
          isActive === 'true' ? true : isActive === 'false' ? false : undefined,
        definitionType: definitionType || undefined,
      })

      // Apply pagination (service doesn't support it natively)
      const workflows = allWorkflows.slice(offset, offset + limit)

      return { workflows, total: allWorkflows.length }
    }),
  ),
)

// POST /api/workflows
app.post(
  '/',
  adapt(
    apiHandler({ permission: ['workflows', 'create'] }, async ({ request }) => {
      const data = await request.json()

      const workflow = await WorkflowService.create({
        name: data.name,
        definitionType: data.definitionType || 'lifecycle',
        workflowType: data.workflowType || 'strict',
        description: data.description,
        applicableItemTypes: data.applicableItemTypes,
        states: data.states || [],
        transitions: data.transitions || [],
        isActive: data.isActive ?? true,
      })

      return created({ workflow })
    }),
  ),
)

// GET /api/workflows/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { id } = params as { id: string }
      const workflow = await WorkflowService.getById(id)
      if (!workflow) throw new NotFoundError('Workflow', id)
      return { workflow }
    }),
  ),
)

// PUT /api/workflows/:id
app.put(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, request }) => {
      const data = await request.json()
      const { id } = params as { id: string }
      const workflow = await WorkflowService.update(id, {
        name: data.name,
        description: data.description,
        applicableItemTypes: data.applicableItemTypes,
        states: data.states,
        transitions: data.transitions,
        isActive: data.isActive,
      })
      return { workflow }
    }),
  ),
)

// DELETE /api/workflows/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { id } = params as { id: string }
      await WorkflowService.delete(id)
      return { success: true }
    }),
  ),
)

// GET /api/workflows/:id/approvers
app.get(
  '/:id/approvers',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { id } = params as { id: string }
      const approvers = await WorkflowApprovalService.getAllStateApprovers(id)

      return { approvers }
    }),
  ),
)

// GET /api/workflows/:id/states/:stateId/approvers
app.get(
  '/:id/states/:stateId/approvers',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { id, stateId } = params as { id: string; stateId: string }
      const approvers = await WorkflowApprovalService.getStateApprovers(
        id,
        stateId,
      )

      return { approvers }
    }),
  ),
)

// PUT /api/workflows/:id/states/:stateId/approvers
app.put(
  '/:id/states/:stateId/approvers',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const data = await request.json()

      if (!Array.isArray(data.approvers)) {
        throw new ValidationError('approvers must be an array')
      }

      const { id, stateId } = params as { id: string; stateId: string }
      const approvers = await WorkflowApprovalService.setStateApprovers(
        id,
        stateId,
        data.approvers,
        user.id,
      )

      return { approvers }
    }),
  ),
)

// POST /api/workflows/:id/states/:stateId/approvers
app.post(
  '/:id/states/:stateId/approvers',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const data = await request.json()

      if (!data.type || !data.id) {
        throw new ValidationError('type and id are required')
      }

      const { id, stateId } = params as { id: string; stateId: string }
      const approver = await WorkflowApprovalService.addStateApprover(
        id,
        stateId,
        {
          type: data.type,
          id: data.id,
          isRequired: data.isRequired ?? true,
        },
        user.id,
      )

      return created({ approver })
    }),
  ),
)

// PATCH /api/workflows/:id/states/:stateId/approvers/:approverId
app.patch(
  '/:id/states/:stateId/approvers/:approverId',
  adapt(
    apiHandler({}, async ({ request, params }) => {
      const data = await request.json()

      if (typeof data.isRequired !== 'boolean') {
        throw new ValidationError('isRequired must be a boolean')
      }

      const { approverId } = params as { approverId: string }
      const approver = await WorkflowApprovalService.updateStateApprover(
        approverId,
        data.isRequired,
      )

      return { approver }
    }),
  ),
)

// DELETE /api/workflows/:id/states/:stateId/approvers/:approverId
app.delete(
  '/:id/states/:stateId/approvers/:approverId',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { approverId } = params as { approverId: string }
      await WorkflowApprovalService.removeStateApprover(approverId)

      return { success: true }
    }),
  ),
)

// POST /api/workflows/:id/validate
app.post(
  '/:id/validate',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { id } = params as { id: string }
      const workflow = await WorkflowService.getById(id)

      if (!workflow) {
        throw new NotFoundError('Workflow', id)
      }

      const validation = WorkflowService.validateDefinition(workflow)

      return { validation }
    }),
  ),
)

export default app
