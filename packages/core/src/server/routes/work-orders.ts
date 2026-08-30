// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
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
import { requireItemAccess, requireWorkOrderAccess } from '@/lib/auth/access'

/** Step data or progress for a run in flight; either half may be sent alone. */
const executionProgressSchema = z.object({
  stepData: z
    .object({ blockId: z.string().min(1).max(200), value: z.unknown() })
    .optional(),
  // The traveler's own step count bounds this; the cap is a sanity ceiling.
  currentStepIndex: z.number().int().min(0).max(10000).optional(),
})

/** A work-order status change; the lifecycle decides which targets are legal. */
const workOrderStatusSchema = z.object({
  status: z.string().min(1).max(100),
})

/** Closing note on a run that is being completed or abandoned. */
const executionNotesSchema = z.object({
  notes: z.string().max(10000).optional(),
})

/**
 * A sign-off on a completed run. Rejecting requires a comment — a rejection
 * the executor cannot read is not feedback.
 */
const signOffSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    comments: z.string().max(10000).optional(),
  })
  .refine((v) => v.decision !== 'rejected' || Boolean(v.comments), {
    message: 'Comments are required when rejecting',
    path: ['comments'],
  })

const adapt = tagged('Work Orders')

/**
 * Refuse a work order whose part and whose program name different programs.
 *
 * The two instance gates below pass independently, and a caller who
 * legitimately reaches both programs satisfies both at once — the row that
 * results is a standing bridge between them. Every member of the program named
 * then reads the other program's part number, name and revision back through
 * `GET /work-orders/:id`, and `POST /:id/instructions/populate` walks that
 * part's BOM and copies its work-instruction snapshots into a traveler they
 * read through `GET /:id/instructions`. Creation already establishes this
 * agreement whenever the body omits the program, by deriving it from the part
 * (`WorkOrderService.deriveProgramId`); this is the same invariant on the path
 * that supplies one.
 *
 * A part whose design has no program — Standard Library, unassigned — derives
 * `null` and is deliberately exempt. Building a library part from any program
 * is the one legitimate mixed case, and it is the asymmetry the derivation
 * already encodes.
 *
 * The derived program is not named in the error. It is the one value here the
 * caller did not supply, and on an update it can come from a part they cannot
 * reach; the field names are enough to act on.
 */
async function requirePartAndProgramAgree(
  partId: string,
  programId: string,
): Promise<void> {
  const derived = await WorkOrderService.deriveProgramId(partId)
  if (derived !== null && derived !== programId) {
    throw new ValidationError(
      'The part belongs to a different program than the one given',
      [
        {
          field: 'programId',
          message:
            'A work order must be filed in the program that owns the part it builds',
        },
      ],
    )
  }
}

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
      { permission: ['work_orders', 'create'], body: workOrderCreateSchema },
      async ({ body, user }) => {
        // Naming a part is a read of it: the 201 echoes that part's number,
        // name and revision straight back, so without this gate a caller
        // holding `work_orders:create` turns a part id into readable part
        // identity in another program. It is also what stops the derivation
        // below from parking the order in a program the caller cannot open —
        // the `programId` gate only inspects a program the body names, and
        // creation derives one from the part when the body names none.
        if (body.partId) await requireItemAccess(user.id, body.partId)

        // Filing into a program is a program-scoped write — the same check the
        // list makes for a `?programId=` filter. Without it a caller could
        // park an order in a program they cannot open, and would then not be
        // able to read back what they had just created.
        if (
          body.programId &&
          !(await AccessControlService.canAccessProgram(
            user.id,
            body.programId,
          ))
        ) {
          throw new PermissionDeniedError('program work orders', 'create')
        }

        if (body.partId && body.programId) {
          await requirePartAndProgramAgree(body.partId, body.programId)
        }

        const workOrder = await WorkOrderService.create(body, user.id)

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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof workOrderUpdateSchema>>(
      {
        permission: ['work_orders', 'update'],
        access: ({ params, user }) =>
          requireWorkOrderAccess(user.id, params.id),
        body: workOrderUpdateSchema,
      },
      async ({ params, body, user }) => {
        // Repointing the order at another part is a read of that part, exactly
        // as it is on create — and the sharper case, because the `access` gate
        // above already answered "yes" for the row itself, so nothing else
        // here looks at what the new `partId` names.
        if (body.partId) await requireItemAccess(user.id, body.partId)

        // Reassignment is a write into the destination program too: the
        // `access` gate above answered for the program the order is in now,
        // not the one it is being moved to.
        if (
          body.programId &&
          !(await AccessControlService.canAccessProgram(
            user.id,
            body.programId,
          ))
        ) {
          throw new PermissionDeniedError('program work orders', 'update')
        }

        // Either half of the pair can be moved on its own, so the agreement is
        // checked against the row as it will be, not as it was sent. Only an
        // edit that touches one of them is measured: a row that already
        // disagrees predates this rule, and making its quantity uneditable
        // would take the repair away from the administrator who has to do it.
        if (body.partId !== undefined || body.programId !== undefined) {
          // `access:` above discards its return value; this is the same query
          // it just ran, which handler.ts blesses re-running for the row.
          const current = await requireWorkOrderAccess(user.id, params.id)
          const partId =
            body.partId === undefined ? current.partId : body.partId
          const programId =
            body.programId === undefined ? current.programId : body.programId
          if (partId && programId) {
            await requirePartAndProgramAgree(partId, programId)
          }
        }

        const workOrder = await WorkOrderService.update(
          params.id,
          body,
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
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof instantiateInstructionSchema>>(
      {
        body: instantiateInstructionSchema,
        permission: ['work_orders', 'update'],
        openapi: {
          summary:
            'Add a traveler line: instantiate a work instruction template (frozen snapshot)',
        },
      },
      async ({ body: input, params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof reorderInstructionsSchema>>(
      {
        body: reorderInstructionsSchema,
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Reorder traveler lines',
        },
      },
      async ({ body: { instructions }, params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<
      { id: string; instructionId: string },
      z.infer<typeof updateInstructionSchema>
    >(
      {
        body: updateInstructionSchema,
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Update how many completed runs a traveler line needs',
        },
      },
      async ({ body: { requiredCount }, params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<
      { id: string; instructionId: string },
      z.infer<typeof skipInstructionSchema>
    >(
      {
        body: skipInstructionSchema,
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Skip a traveler line (audited; requires a reason)',
        },
      },
      async ({ body: { reason }, params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, request, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<
      { id: string; instructionId: string },
      z.infer<typeof startExecutionSchema> | undefined
    >(
      {
        // `.optional()`: an unlabelled run sends no body at all, and the
        // handler used to spell that as `.catch(() => ({}))`. Declared here
        // instead, so the document says the body is optional and a body that
        // is present but malformed is a 400 rather than silently an empty one.
        body: startExecutionSchema.optional(),
        permission: ['work_instructions', 'read'],
        openapi: {
          summary:
            'Start (or resume) a run of a traveler line; auto-starts a Not Started order',
          request: { body: { schema: startExecutionSchema, required: false } },
        },
      },
      async ({ body, params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
        await WorkOrderInstructionService.getLineRow(
          params.id,
          params.instructionId,
        )
        const unitLabel = body?.unitLabel

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
      async ({ params, request, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<
      { id: string; executionId: string },
      z.infer<typeof executionProgressSchema>
    >(
      {
        permission: ['work_instructions', 'read'],
        access: ({ params, user }) =>
          requireWorkOrderAccess(user.id, params.id),
        body: executionProgressSchema,
      },
      async ({ params, body }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
        const { stepData, currentStepIndex } = body

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
    apiHandler<
      { id: string; executionId: string },
      z.infer<typeof executionNotesSchema>
    >(
      {
        permission: ['work_instructions', 'read'],
        access: ({ params, user }) =>
          requireWorkOrderAccess(user.id, params.id),
        body: executionNotesSchema,
      },
      async ({ params, body: { notes }, user }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
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
    apiHandler<
      { id: string; executionId: string },
      z.infer<typeof executionNotesSchema>
    >(
      {
        permission: ['work_instructions', 'read'],
        access: ({ params, user }) =>
          requireWorkOrderAccess(user.id, params.id),
        body: executionNotesSchema,
        openapi: {
          summary: 'Abandon an in-progress run (kept as an Incomplete record)',
        },
      },
      async ({ params, body: { notes }, user }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
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
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<
      { id: string; executionId: string },
      z.infer<typeof signOffSchema>
    >(
      {
        permission: ['work_orders', 'update'],
        access: ({ params, user }) =>
          requireWorkOrderAccess(user.id, params.id),
        body: signOffSchema,
      },
      async ({ params, body: { decision, comments }, user }) => {
        await InstructionExecutionService.findByIdForWorkOrder(
          params.executionId,
          params.id,
        )
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof consumeMaterialSchema>>(
      {
        body: consumeMaterialSchema,
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Consume material on a work order',
        },
      },
      async ({ body: input, params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof produceUnitsSchema>>(
      {
        body: produceUnitsSchema,
        permission: ['work_orders', 'update'],
        openapi: {
          summary: 'Record serials produced by a work order',
        },
      },
      async ({ body: { serialNumbers }, params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
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
      async ({ params, user }) => {
        await requireWorkOrderAccess(user.id, params.id)
        return QualificationService.rollupForWorkOrder(params.id)
      },
    ),
  ),
)

// PUT /api/work-orders/:id/status
app.put(
  '/:id/status',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof workOrderStatusSchema>>(
      {
        permission: ['work_orders', 'update'],
        access: ({ params, user }) =>
          requireWorkOrderAccess(user.id, params.id),
        // The target is validated by the lifecycle's own transitions in
        // WorkOrderService.updateStatus; no state list is named here.
        body: workOrderStatusSchema,
      },
      async ({ params, body: { status }, user }) => {
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
