// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { WorkflowService } from '@/lib/workflows/WorkflowService'
import { WorkflowApprovalService } from '@/lib/workflows/WorkflowApprovalService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler, created, parseQuery } from '@/lib/api/handler'
import {
  stateApproverInputSchema,
  stateApproverPatchSchema,
  stateApproversReplaceSchema,
  workflowDefinitionCreateSchema,
  workflowDefinitionUpdateSchema,
} from '@/lib/api/schemas'

const adapt = tagged('Workflows')

const app = new Hono()

// GET /api/workflows
app.get(
  '/',
  adapt(
    apiHandler({ permission: ['workflows', 'read'] }, async ({ request }) => {
      const url = new URL(request.url)
      const isActive = url.searchParams.get('isActive')
      // Coarse filter: 'workflow' = Driving change-order workflows,
      // 'lifecycle' = Driven/Free item lifecycles (resolved via
      // lifecycleType, not the legacy definitionType field)
      const kind = url.searchParams.get('type') as
        'lifecycle' | 'workflow' | null
      // Validated, not parseInt: garbage used to become NaN and slice to an
      // empty page. The 100 default predates the freeze and is kept — the
      // OpenAPI snapshot is the authority on per-endpoint defaults.
      const { limit, offset } = parseQuery(
        request,
        z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      )

      const allWorkflows = await WorkflowService.list({
        isActive:
          isActive === 'true' ? true : isActive === 'false' ? false : undefined,
        kind: kind || undefined,
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
    apiHandler(
      {
        permission: ['workflows', 'create'],
        body: workflowDefinitionCreateSchema,
      },
      async ({ body }) => {
        const workflow = await WorkflowService.create({
          ...body,
          workflowType: body.workflowType ?? 'strict',
          states: body.states ?? [],
          transitions: body.transitions ?? [],
          isActive: body.isActive ?? true,
        })

        return created({ workflow })
      },
    ),
  ),
)

// GET /api/workflows/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
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
    apiHandler<{ id: string }, z.infer<typeof workflowDefinitionUpdateSchema>>(
      {
        permission: ['workflows', 'manage'],
        body: workflowDefinitionUpdateSchema,
      },
      // Absent keys keep the stored value; provided keys persist what the
      // editor actually shows.
      async ({ params, body }) => {
        const workflow = await WorkflowService.update(params.id, body)
        return { workflow }
      },
    ),
  ),
)

// DELETE /api/workflows/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['workflows', 'manage'] },
      async ({ params }) => {
        const { id } = params
        await WorkflowService.delete(id)
        return { success: true }
      },
    ),
  ),
)

// GET /api/workflows/:id/approvers
app.get(
  '/:id/approvers',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const approvers = await WorkflowApprovalService.getAllStateApprovers(id)

      return { approvers }
    }),
  ),
)

// GET /api/workflows/:id/states/:stateId/approvers
app.get(
  '/:id/states/:stateId/approvers',
  adapt(
    apiHandler<{ id: string; stateId: string }>({}, async ({ params }) => {
      const { id, stateId } = params
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
    apiHandler<
      { id: string; stateId: string },
      z.infer<typeof stateApproversReplaceSchema>
    >(
      {
        permission: ['workflows', 'manage'],
        body: stateApproversReplaceSchema,
      },
      async ({ body, params, user }) => {
        const { id, stateId } = params
        const approvers = await WorkflowApprovalService.setStateApprovers(
          id,
          stateId,
          body.approvers,
          user.id,
        )

        return { approvers }
      },
    ),
  ),
)

// POST /api/workflows/:id/states/:stateId/approvers
app.post(
  '/:id/states/:stateId/approvers',
  adapt(
    apiHandler<
      { id: string; stateId: string },
      z.infer<typeof stateApproverInputSchema>
    >(
      {
        permission: ['workflows', 'manage'],
        body: stateApproverInputSchema,
      },
      async ({ body, params, user }) => {
        const { id, stateId } = params
        const approver = await WorkflowApprovalService.addStateApprover(
          id,
          stateId,
          body,
          user.id,
        )

        return created({ approver })
      },
    ),
  ),
)

// PATCH /api/workflows/:id/states/:stateId/approvers/:approverId
app.patch(
  '/:id/states/:stateId/approvers/:approverId',
  adapt(
    apiHandler<
      { id: string; stateId: string; approverId: string },
      z.infer<typeof stateApproverPatchSchema>
    >(
      {
        permission: ['workflows', 'manage'],
        body: stateApproverPatchSchema,
      },
      async ({ body, params }) => {
        const approver = await WorkflowApprovalService.updateStateApprover(
          params.approverId,
          body.isRequired,
        )

        return { approver }
      },
    ),
  ),
)

// DELETE /api/workflows/:id/states/:stateId/approvers/:approverId
app.delete(
  '/:id/states/:stateId/approvers/:approverId',
  adapt(
    apiHandler<{ id: string; stateId: string; approverId: string }>(
      { permission: ['workflows', 'manage'] },
      async ({ params }) => {
        const { approverId } = params
        await WorkflowApprovalService.removeStateApprover(approverId)

        return { success: true }
      },
    ),
  ),
)

// POST /api/workflows/:id/validate
app.post(
  '/:id/validate',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
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
