// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { WorkOrderStatus } from '@/lib/items/types/work-order'
import { WorkOrderService } from '@/lib/services/WorkOrderService'
import { WorkOrderInstructionService } from '@/lib/services/WorkOrderInstructionService'
import { InstructionExecutionService } from '@/lib/services/InstructionExecutionService'
import { ParametricResolutionService } from '@/lib/services/ParametricResolutionService'
import {
  WorkOrderMaterialService,
  consumeMaterialSchema,
  produceUnitsSchema,
} from '@/lib/services/WorkOrderMaterialService'
import { QualificationService } from '@/lib/services/QualificationService'
import {
  instantiateInstructionSchema,
  reorderInstructionsSchema,
  skipInstructionSchema,
  startExecutionSchema,
  updateInstructionSchema,
  workOrderCreateSchema,
  workOrderUpdateSchema,
} from '@/lib/items/types/work-order'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { apiHandler } from '@/lib/api/handler'

const adapt = tagged('Work Orders')

const app = new Hono()

// GET /api/work-orders
app.get(
  '/',
  adapt(
    apiHandler(
      { permission: ['work_orders', 'read'] },
      async ({ request, user }) => {
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

        // Naming a program is a program-scoped read; the access scope bounds
        // the list either way, so omitting every filter cannot mean "no
        // scoping at all".
        if (
          programId &&
          !(await AccessControlService.canAccessProgram(user.id, programId))
        ) {
          throw new PermissionDeniedError('program work orders', 'read')
        }

        const result = await WorkOrderService.search({
          status,
          partId,
          search,
          programId,
          accessProgramIds: await AccessControlService.getAccessibleProgramIds(
            user.id,
          ),
          limit,
          offset,
        })

        return result
      },
    ),
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
    apiHandler<{ id: string }>(
      { permission: ['work_orders', 'read'] },
      async ({ params }) => {
        const { id } = params
        const workOrder = await WorkOrderService.findById(id)
        if (!workOrder) {
          throw new NotFoundError('Work Order', id)
        }

        return { workOrder }
      },
    ),
  ),
)

// PUT /api/work-orders/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
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
    apiHandler<{ id: string }>(
      { permission: ['work_orders', 'delete'] },
      async ({ params, user }) => {
        await WorkOrderService.delete(params.id, user.id)

        return { success: true }
      },
    ),
  ),
)

// =====================================================================
// Traveler — instances of work instruction templates inside this order.
// See docs/features/work-order-traveler.md.
// =====================================================================

// GET /api/work-orders/:id/instructions — the traveler, in sequence
app.get(
  '/:id/instructions',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['work_orders', 'read'],
        openapi: {
          summary:
            'List the traveler: instruction instances with derived status and progress',
        },
      },
      async ({ params }) => {
        const instructions = await WorkOrderInstructionService.list(params.id)
        return { instructions }
      },
    ),
  ),
)

// POST /api/work-orders/:id/instructions — instantiate a template
app.post(
  '/:id/instructions',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['work_orders', 'update'],
        openapi: {
          summary:
            'Add a traveler line: instantiate a work instruction template (frozen snapshot)',
          request: { body: { schema: instantiateInstructionSchema } },
        },
      },
      async ({ params, request, user }) => {
        const input = instantiateInstructionSchema.parse(await request.json())
        const instruction = await WorkOrderInstructionService.instantiate(
          params.id,
          input,
          user.id,
        )
        return new Response(JSON.stringify({ data: { instruction } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ),
  ),
)

// POST /api/work-orders/:id/instructions/populate — build the traveler
// from part attachments across the order part's BOM
app.post(
  '/:id/instructions/populate',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['work_orders', 'update'],
        openapi: {
          summary:
            "Populate the traveler from templates attached to the order's part and its BOM tree",
        },
      },
      async ({ params, user }) => {
        const result = await WorkOrderInstructionService.populate(
          params.id,
          user.id,
        )
        return {
          created: result.created,
          skipped: result.skipped,
        }
      },
    ),
  ),
)

// PUT /api/work-orders/:id/instructions — reorder the traveler
app.put(
  '/:id/instructions',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Reorder traveler lines',
          request: { body: { schema: reorderInstructionsSchema } },
        },
      },
      async ({ params, request }) => {
        const { instructions } = reorderInstructionsSchema.parse(
          await request.json(),
        )
        const result = await WorkOrderInstructionService.reorder(
          params.id,
          instructions,
        )
        return { instructions: result }
      },
    ),
  ),
)

// GET /api/work-orders/:id/instructions/:instructionId
app.get(
  '/:id/instructions/:instructionId',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      { permission: ['work_orders', 'read'] },
      async ({ params }) => {
        const instruction = await WorkOrderInstructionService.get(
          params.id,
          params.instructionId,
        )
        return { instruction }
      },
    ),
  ),
)

// PATCH /api/work-orders/:id/instructions/:instructionId — requiredCount
app.patch(
  '/:id/instructions/:instructionId',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      {
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Update how many completed runs a traveler line needs',
          request: { body: { schema: updateInstructionSchema } },
        },
      },
      async ({ params, request }) => {
        const { requiredCount } = updateInstructionSchema.parse(
          await request.json(),
        )
        const instruction =
          await WorkOrderInstructionService.updateRequiredCount(
            params.id,
            params.instructionId,
            requiredCount,
          )
        return { instruction }
      },
    ),
  ),
)

// POST /api/work-orders/:id/instructions/:instructionId/skip
app.post(
  '/:id/instructions/:instructionId/skip',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      {
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Skip a traveler line (audited; requires a reason)',
          request: { body: { schema: skipInstructionSchema } },
        },
      },
      async ({ params, request, user }) => {
        const { reason } = skipInstructionSchema.parse(await request.json())
        const instruction = await WorkOrderInstructionService.skip(
          params.id,
          params.instructionId,
          user.id,
          reason,
        )
        return { instruction }
      },
    ),
  ),
)

// POST /api/work-orders/:id/instructions/:instructionId/unskip
app.post(
  '/:id/instructions/:instructionId/unskip',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      { permission: ['work_orders', 'update'] },
      async ({ params }) => {
        const instruction = await WorkOrderInstructionService.unskip(
          params.id,
          params.instructionId,
        )
        return { instruction }
      },
    ),
  ),
)

// POST /api/work-orders/:id/instructions/:instructionId/refresh — re-snapshot
app.post(
  '/:id/instructions/:instructionId/refresh',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      {
        permission: ['work_orders', 'update'],
        openapi: {
          summary:
            'Re-freeze a traveler line from its template (only while unexecuted)',
        },
      },
      async ({ params }) => {
        const instruction = await WorkOrderInstructionService.refreshSnapshot(
          params.id,
          params.instructionId,
        )
        return { instruction }
      },
    ),
  ),
)

// DELETE /api/work-orders/:id/instructions/:instructionId
app.delete(
  '/:id/instructions/:instructionId',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      { permission: ['work_orders', 'update'] },
      async ({ params }) => {
        await WorkOrderInstructionService.remove(
          params.id,
          params.instructionId,
        )
        return { success: true }
      },
    ),
  ),
)

// GET /api/work-orders/:id/instructions/:instructionId/resolve-parametric
app.get(
  '/:id/instructions/:instructionId/resolve-parametric',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      {
        permission: ['work_orders', 'read'],
        openapi: {
          summary:
            "Resolve the snapshot's parametric blocks against current part data",
        },
      },
      async ({ params }) => {
        const line = await WorkOrderInstructionService.getLineRow(
          params.id,
          params.instructionId,
        )
        const resolved = await ParametricResolutionService.resolveSteps(
          line.snapshot.steps,
        )
        return { resolved }
      },
    ),
  ),
)

// =====================================================================
// Executions — runs of traveler lines.
// Start/update/complete need only work_instructions:read so technician
// seats can record work; sign-off stays a work_orders supervisory action.
// =====================================================================

// GET /api/work-orders/:id/instructions/:instructionId/executions
app.get(
  '/:id/instructions/:instructionId/executions',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request }) => {
        await WorkOrderInstructionService.getLineRow(
          params.id,
          params.instructionId,
        )
        const url = new URL(request.url)
        const limit = url.searchParams.get('limit')
          ? parseInt(url.searchParams.get('limit')!)
          : undefined
        const offset = url.searchParams.get('offset')
          ? parseInt(url.searchParams.get('offset')!)
          : undefined
        return InstructionExecutionService.listByLine(params.instructionId, {
          limit,
          offset,
        })
      },
    ),
  ),
)

// POST /api/work-orders/:id/instructions/:instructionId/executions — start/resume
app.post(
  '/:id/instructions/:instructionId/executions',
  adapt(
    apiHandler<{ id: string; instructionId: string }>(
      {
        permission: ['work_instructions', 'read'],
        openapi: {
          summary:
            'Start (or resume) a run of a traveler line; auto-starts a Not Started order',
          request: { body: { schema: startExecutionSchema } },
        },
      },
      async ({ params, request, user }) => {
        await WorkOrderInstructionService.getLineRow(
          params.id,
          params.instructionId,
        )
        const body = await request.json().catch(() => ({}))
        const { unitLabel } = startExecutionSchema.parse(body)

        const { execution, resumed } = await InstructionExecutionService.start(
          params.instructionId,
          user.id,
          unitLabel,
        )

        if (resumed) {
          return { execution, resumed: true }
        }
        return new Response(
          JSON.stringify({ data: { execution, resumed: false } }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      },
    ),
  ),
)

// GET /api/work-orders/:id/executions — every run for this order
app.get(
  '/:id/executions',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['work_orders', 'read'] },
      async ({ params, request }) => {
        const url = new URL(request.url)
        const limit = url.searchParams.get('limit')
          ? parseInt(url.searchParams.get('limit')!)
          : undefined
        const offset = url.searchParams.get('offset')
          ? parseInt(url.searchParams.get('offset')!)
          : undefined

        const result = await InstructionExecutionService.listByWorkOrder(
          params.id,
          { limit, offset },
        )

        return result
      },
    ),
  ),
)

// GET /api/work-orders/:id/executions/:executionId
app.get(
  '/:id/executions/:executionId',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params }) => {
        const execution =
          await InstructionExecutionService.findByIdForWorkOrder(
            params.executionId,
            params.id,
          )
        return { execution }
      },
    ),
  ),
)

// PUT /api/work-orders/:id/executions/:executionId — step data / progress
app.put(
  '/:id/executions/:executionId',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
        const body = await request.json()
        const { stepData, currentStepIndex } = body as {
          stepData?: { blockId: string; value: unknown }
          currentStepIndex?: number
        }

        let execution

        if (stepData) {
          execution = await InstructionExecutionService.updateStepData(
            params.executionId,
            stepData.blockId,
            stepData.value,
          )
        }

        if (currentStepIndex !== undefined) {
          execution = await InstructionExecutionService.updateProgress(
            params.executionId,
            currentStepIndex,
          )
        }

        return { execution }
      },
    ),
  ),
)

// POST /api/work-orders/:id/executions/:executionId/complete
app.post(
  '/:id/executions/:executionId/complete',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request, user }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
        const body = await request.json().catch(() => ({}))
        const { notes } = body as { notes?: string }

        const execution = await InstructionExecutionService.complete(
          params.executionId,
          user.id,
          notes,
        )

        return { execution }
      },
    ),
  ),
)

// POST /api/work-orders/:id/executions/:executionId/abandon
app.post(
  '/:id/executions/:executionId/abandon',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      {
        permission: ['work_instructions', 'read'],
        openapi: {
          summary: 'Abandon an in-progress run (kept as an Incomplete record)',
        },
      },
      async ({ params, request, user }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
        const body = await request.json().catch(() => ({}))
        const { notes } = body as { notes?: string }

        const execution = await InstructionExecutionService.abandon(
          params.executionId,
          user.id,
          notes,
        )

        return { execution }
      },
    ),
  ),
)

// POST /api/work-orders/:id/executions/:executionId/resubmit
// Permission is read-level: the service enforces that only the original
// executor (a technician seat) can resubmit their rejected run.
app.post(
  '/:id/executions/:executionId/resubmit',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, user }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
        const execution = await InstructionExecutionService.resubmitForApproval(
          params.executionId,
          user.id,
        )

        return { execution }
      },
    ),
  ),
)

// GET /api/work-orders/:id/executions/:executionId/sign-off
app.get(
  '/:id/executions/:executionId/sign-off',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      { permission: ['work_orders', 'read'] },
      async ({ params }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
        const signOffs = await InstructionExecutionService.getSignOff(
          params.executionId,
        )

        return { signOffs }
      },
    ),
  ),
)

// POST /api/work-orders/:id/executions/:executionId/sign-off
app.post(
  '/:id/executions/:executionId/sign-off',
  adapt(
    apiHandler<{ id: string; executionId: string }>(
      { permission: ['work_orders', 'update'] },
      async ({ params, request, user }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
        const body = await request.json()
        // `decision` is untrusted input, so it is typed as `unknown` until the
        // check below narrows it. Casting it to the union up front would assert
        // the very thing this handler is validating.
        const { decision, comments } = body as {
          decision?: unknown
          comments?: string
        }

        if (decision !== 'approved' && decision !== 'rejected') {
          throw new ValidationError('Decision must be "approved" or "rejected"')
        }

        if (decision === 'rejected' && !comments) {
          throw new ValidationError('Comments are required when rejecting')
        }

        const execution = await InstructionExecutionService.submitSignOff(
          params.executionId,
          user.id,
          decision,
          comments,
        )

        return { execution }
      },
    ),
  ),
)

// GET /api/work-orders/:id/materials — consumed material lines
app.get(
  '/:id/materials',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['work_orders', 'read'] },
      async ({ params }) => {
        const materials = await WorkOrderMaterialService.list(params.id)
        return { materials }
      },
    ),
  ),
)

// POST /api/work-orders/:id/materials — consume material (register-on-consumption)
app.post(
  '/:id/materials',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Consume material on a work order',
          request: { body: { schema: consumeMaterialSchema } },
        },
      },
      async ({ params, request, user }) => {
        const input = consumeMaterialSchema.parse(await request.json())
        const materials = await WorkOrderMaterialService.consume(
          params.id,
          input,
          user.id,
        )
        return { materials }
      },
    ),
  ),
)

// DELETE /api/work-orders/:id/materials/:edgeId — remove a material line
app.delete(
  '/:id/materials/:edgeId',
  adapt(
    apiHandler<{ id: string; edgeId: string }>(
      { permission: ['work_orders', 'update'] },
      async ({ params, user }) => {
        const materials = await WorkOrderMaterialService.remove(
          params.id,
          params.edgeId,
          user.id,
        )
        return { materials }
      },
    ),
  ),
)

// GET /api/work-orders/:id/produced — units this WO produced
app.get(
  '/:id/produced',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['work_orders', 'read'] },
      async ({ params }) => {
        const produced = await WorkOrderMaterialService.listProduced(params.id)
        return { produced }
      },
    ),
  ),
)

// POST /api/work-orders/:id/produce — record produced serials
app.post(
  '/:id/produce',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Record serials produced by a work order',
          request: { body: { schema: produceUnitsSchema } },
        },
      },
      async ({ params, request, user }) => {
        const { serialNumbers } = produceUnitsSchema.parse(await request.json())
        const produced = await WorkOrderMaterialService.produce(
          params.id,
          serialNumbers,
          user.id,
        )
        return { produced }
      },
    ),
  ),
)

// GET /api/work-orders/:id/qualification — requirement satisfaction rollup
app.get(
  '/:id/qualification',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['work_orders', 'read'],
        openapi: {
          summary:
            'Qualification rollup: requirements in scope, evidence, and gaps',
        },
      },
      async ({ params }) => {
        return QualificationService.rollupForWorkOrder(params.id)
      },
    ),
  ),
)

// PUT /api/work-orders/:id/status
app.put(
  '/:id/status',
  adapt(
    apiHandler<{ id: string }>(
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
