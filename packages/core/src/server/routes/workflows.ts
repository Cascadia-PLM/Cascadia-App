// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { WorkflowService } from '@/lib/workflows/WorkflowService'
import { WorkflowApprovalService } from '@/lib/workflows/WorkflowApprovalService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created, parseQuery } from '@/lib/api/handler'

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
    apiHandler({ permission: ['workflows', 'create'] }, async ({ request }) => {
      const data = await request.json()

      const workflow = await WorkflowService.create({
        name: data.name,
        workflowType: data.workflowType || 'strict',
        description: data.description,
        applicableItemTypes: data.applicableItemTypes,
        states: data.states || [],
        transitions: data.transitions || [],
        isActive: data.isActive ?? true,
        // The lifecycle editor sends all of these; dropping them here made
        // its saves silently dishonest (every UI-created lifecycle landed
        // as 'Free' with no drivers/mappings/phases)
        lifecycleType: data.lifecycleType,
        drivers: data.drivers,
        changeActionMappings: data.changeActionMappings,
        revisionScheme: data.revisionScheme,
        phases: data.phases,
      })

      return created({ workflow })
    }),
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
    apiHandler<{ id: string }>(
      { permission: ['workflows', 'manage'] },
      async ({ params, request }) => {
        const data = await request.json()
        const { id } = params
        const workflow = await WorkflowService.update(id, {
          name: data.name,
          description: data.description,
          applicableItemTypes: data.applicableItemTypes,
          states: data.states,
          transitions: data.transitions,
          isActive: data.isActive,
          // Same passthrough as create: absent keys keep the stored value,
          // provided keys persist what the editor actually shows
          lifecycleType: data.lifecycleType,
          drivers: data.drivers,
          changeActionMappings: data.changeActionMappings,
          revisionScheme: data.revisionScheme,
          phases: data.phases,
        })
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
    apiHandler<{ id: string; stateId: string }>(
      { permission: ['workflows', 'manage'] },
      async ({ request, params, user }) => {
        const data = await request.json()

        if (!Array.isArray(data.approvers)) {
          throw new ValidationError('approvers must be an array')
        }

        const { id, stateId } = params
        const approvers = await WorkflowApprovalService.setStateApprovers(
          id,
          stateId,
          data.approvers,
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
    apiHandler<{ id: string; stateId: string }>(
      { permission: ['workflows', 'manage'] },
      async ({ request, params, user }) => {
        const data = await request.json()

        if (!data.type || !data.id) {
          throw new ValidationError('type and id are required')
        }

        const { id, stateId } = params
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
      },
    ),
  ),
)

// PATCH /api/workflows/:id/states/:stateId/approvers/:approverId
app.patch(
  '/:id/states/:stateId/approvers/:approverId',
  adapt(
    apiHandler<{ id: string; stateId: string; approverId: string }>(
      { permission: ['workflows', 'manage'] },
      async ({ request, params }) => {
        const data = await request.json()

        if (typeof data.isRequired !== 'boolean') {
          throw new ValidationError('isRequired must be a boolean')
        }

        const { approverId } = params
        const approver = await WorkflowApprovalService.updateStateApprover(
          approverId,
          data.isRequired,
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
