// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { LifecycleDefinitionService } from '@/lib/lifecycles/LifecycleDefinitionService'
import { ApprovalService } from '@/lib/lifecycles/ApprovalService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler, created, parseQuery } from '@/lib/api/handler'
import {
  stateApproverInputSchema,
  stateApproverPatchSchema,
  stateApproversReplaceSchema,
  workflowDefinitionCreateSchema,
  workflowDefinitionUpdateSchema,
} from '@/lib/api/schemas'

/**
 * The lifecycle-definition routes: the definitions, their state approvers,
 * and validation. Mounted twice — at `/api/v1/lifecycles`, the canonical
 * path, and at `/api/v1/workflows`, the path they shipped under, which
 * stays as a deprecated alias because v1 is additive-only (remediation plan
 * CM-24). One handler behind each pair; the response keys (`workflows`,
 * `workflow`) keep their v1 spelling on both mounts and are on the v2
 * backlog. The permission resource is `lifecycles` (CM-27).
 */
export function lifecycleDefinitionRoutes(options: {
  /** The OpenAPI tag this mount's operations carry. */
  tag: string
  /** Marks every operation deprecated in the spec: the alias mount. */
  deprecated?: boolean
}) {
  const adapt = tagged(options.tag)
  const deprecated = options.deprecated ? true : undefined
  const app = new Hono()

  // GET /
  app.get(
    '/',
    adapt(
      apiHandler(
        {
          permission: ['lifecycles', 'read'],
          openapi: { summary: 'List lifecycle definitions', deprecated },
        },
        async ({ request }) => {
          const url = new URL(request.url)
          const isActive = url.searchParams.get('isActive')
          // Coarse filter: 'workflow' = Driving change-order workflows,
          // 'lifecycle' = Driven/Free item lifecycles
          const kind = url.searchParams.get('type') as
            'lifecycle' | 'workflow' | null
          // Validated, not parseInt: garbage used to become NaN and slice to
          // an empty page. The 100 default predates the freeze and is kept —
          // the OpenAPI snapshot is the authority on per-endpoint defaults.
          const { limit, offset, lifecycleType } = parseQuery(
            request,
            z.object({
              limit: z.coerce.number().int().min(1).max(500).default(100),
              offset: z.coerce.number().int().min(0).default(0),
              // Beside `?type=`, the model's own kinds by name.
              lifecycleType: z.enum(['Free', 'Driven', 'Driving']).optional(),
            }),
          )

          const allWorkflows = await LifecycleDefinitionService.list({
            isActive:
              isActive === 'true'
                ? true
                : isActive === 'false'
                  ? false
                  : undefined,
            kind: kind || undefined,
            lifecycleType,
          })

          // Apply pagination (service doesn't support it natively)
          const workflows = allWorkflows.slice(offset, offset + limit)

          return { workflows, total: allWorkflows.length }
        },
      ),
    ),
  )

  // POST /
  app.post(
    '/',
    adapt(
      apiHandler(
        {
          permission: ['lifecycles', 'create'],
          body: workflowDefinitionCreateSchema,
          openapi: { summary: 'Create a lifecycle definition', deprecated },
        },
        async ({ body }) => {
          const workflow = await LifecycleDefinitionService.create({
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

  // GET /:id
  app.get(
    '/:id',
    adapt(
      apiHandler<{ id: string }>(
        { openapi: { summary: 'Get a lifecycle definition', deprecated } },
        async ({ params }) => {
          const { id } = params
          const workflow = await LifecycleDefinitionService.getById(id)
          if (!workflow) throw new NotFoundError('Workflow', id)
          return { workflow }
        },
      ),
    ),
  )

  // PUT /:id
  app.put(
    '/:id',
    adapt(
      apiHandler<
        { id: string },
        z.infer<typeof workflowDefinitionUpdateSchema>
      >(
        {
          permission: ['lifecycles', 'manage'],
          body: workflowDefinitionUpdateSchema,
          openapi: { summary: 'Update a lifecycle definition', deprecated },
        },
        // Absent keys keep the stored value; provided keys persist what the
        // editor actually shows.
        async ({ params, body }) => {
          const workflow = await LifecycleDefinitionService.update(
            params.id,
            body,
          )
          return { workflow }
        },
      ),
    ),
  )

  // DELETE /:id
  app.delete(
    '/:id',
    adapt(
      apiHandler<{ id: string }>(
        {
          permission: ['lifecycles', 'manage'],
          openapi: { summary: 'Delete a lifecycle definition', deprecated },
        },
        async ({ params }) => {
          const { id } = params
          await LifecycleDefinitionService.delete(id)
          return { success: true }
        },
      ),
    ),
  )

  // GET /:id/approvers
  app.get(
    '/:id/approvers',
    adapt(
      apiHandler<{ id: string }>(
        {
          openapi: {
            summary: 'List the approvers of every state of a definition',
            deprecated,
          },
        },
        async ({ params }) => {
          const { id } = params
          const approvers = await ApprovalService.getAllStateApprovers(id)
          return { approvers }
        },
      ),
    ),
  )

  // GET /:id/states/:stateId/approvers
  app.get(
    '/:id/states/:stateId/approvers',
    adapt(
      apiHandler<{ id: string; stateId: string }>(
        { openapi: { summary: 'List the approvers of a state', deprecated } },
        async ({ params }) => {
          const { id, stateId } = params
          const approvers = await ApprovalService.getStateApprovers(id, stateId)
          return { approvers }
        },
      ),
    ),
  )

  // PUT /:id/states/:stateId/approvers
  app.put(
    '/:id/states/:stateId/approvers',
    adapt(
      apiHandler<
        { id: string; stateId: string },
        z.infer<typeof stateApproversReplaceSchema>
      >(
        {
          permission: ['lifecycles', 'manage'],
          body: stateApproversReplaceSchema,
          openapi: { summary: 'Replace the approvers of a state', deprecated },
        },
        async ({ body, params, user }) => {
          const { id, stateId } = params
          const approvers = await ApprovalService.setStateApprovers(
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

  // POST /:id/states/:stateId/approvers
  app.post(
    '/:id/states/:stateId/approvers',
    adapt(
      apiHandler<
        { id: string; stateId: string },
        z.infer<typeof stateApproverInputSchema>
      >(
        {
          permission: ['lifecycles', 'manage'],
          body: stateApproverInputSchema,
          openapi: { summary: 'Add an approver to a state', deprecated },
        },
        async ({ body, params, user }) => {
          const { id, stateId } = params
          const approver = await ApprovalService.addStateApprover(
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

  // PATCH /:id/states/:stateId/approvers/:approverId
  app.patch(
    '/:id/states/:stateId/approvers/:approverId',
    adapt(
      apiHandler<
        { id: string; stateId: string; approverId: string },
        z.infer<typeof stateApproverPatchSchema>
      >(
        {
          permission: ['lifecycles', 'manage'],
          body: stateApproverPatchSchema,
          openapi: { summary: 'Update a state approver', deprecated },
        },
        async ({ body, params }) => {
          const approver = await ApprovalService.updateStateApprover(
            params.approverId,
            body.isRequired,
          )
          return { approver }
        },
      ),
    ),
  )

  // DELETE /:id/states/:stateId/approvers/:approverId
  app.delete(
    '/:id/states/:stateId/approvers/:approverId',
    adapt(
      apiHandler<{ id: string; stateId: string; approverId: string }>(
        {
          permission: ['lifecycles', 'manage'],
          openapi: { summary: 'Remove a state approver', deprecated },
        },
        async ({ params }) => {
          const { approverId } = params
          await ApprovalService.removeStateApprover(approverId)
          return { success: true }
        },
      ),
    ),
  )

  // POST /:id/validate
  app.post(
    '/:id/validate',
    adapt(
      apiHandler<{ id: string }>(
        { openapi: { summary: 'Validate a lifecycle definition', deprecated } },
        async ({ params }) => {
          const { id } = params
          const workflow = await LifecycleDefinitionService.getById(id)

          if (!workflow) {
            throw new NotFoundError('Workflow', id)
          }

          const validation =
            LifecycleDefinitionService.validateDefinition(workflow)

          return { validation }
        },
      ),
    ),
  )

  return app
}
