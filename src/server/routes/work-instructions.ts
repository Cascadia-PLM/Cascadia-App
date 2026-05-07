/* eslint-disable @typescript-eslint/no-unnecessary-condition --
 * This file contains many `const [x] = await db.select()...limit(1); if (!x)` patterns.
 * Under the current tsconfig (no `noUncheckedIndexedAccess`), TypeScript narrows
 * destructured array elements to non-undefined, so the runtime guards look
 * "unnecessary" to the rule. They are not — empty result sets still produce
 * undefined at runtime. Remove this directive when the project enables
 * `noUncheckedIndexedAccess`.
 */
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { tagged } from '../adapter'
import type { WorkInstruction } from '@/lib/items/types/work-instruction'
import type { StepContent } from '@/lib/db/schema/items'
import { ItemService } from '@/lib/items/services/ItemService'
import { WorkInstructionExecutionService } from '@/lib/services/WorkInstructionExecutionService'
import { WorkInstructionChangeAlertService } from '@/lib/services/WorkInstructionChangeAlertService'
import { ParametricResolutionService } from '@/lib/services/ParametricResolutionService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'
import { db } from '@/lib/db'
import {
  items,
  workInstructionOperations,
  workInstructionPartAttachments,
  workInstructionSteps,
  workInstructions,
} from '@/lib/db/schema'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Work Instructions')

const app = new Hono()

// GET /api/work-instructions/:id
app.get(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params }) => {
        const workInstruction = await ItemService.findById(params.id)

        if (!workInstruction) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        if (workInstruction.itemType !== 'WorkInstruction') {
          throw new NotFoundError('Work Instruction', params.id)
        }

        // Fetch steps ordered by orderIndex
        const steps = await db
          .select()
          .from(workInstructionSteps)
          .where(eq(workInstructionSteps.workInstructionId, params.id))
          .orderBy(asc(workInstructionSteps.orderIndex))

        return { workInstruction: { ...workInstruction, steps } }
      },
    ),
  ),
)

// PUT /api/work-instructions/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()

        const workInstruction = await ItemService.update<WorkInstruction>(
          params.id,
          data,
          user.id,
        )

        return { workInstruction }
      },
    ),
  ),
)

// DELETE /api/work-instructions/:id
app.delete(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'delete'] },
      async ({ params }) => {
        await ItemService.delete(params.id)

        return { success: true }
      },
    ),
  ),
)

// GET /api/work-instructions/:id/alerts
app.get(
  '/:id/alerts',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request }) => {
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        const url = new URL(request.url)
        const status = url.searchParams.get('status') || undefined

        const [alerts, counts] = await Promise.all([
          WorkInstructionChangeAlertService.getAlertsForWI(params.id, {
            status,
          }),
          WorkInstructionChangeAlertService.getAlertCounts(params.id),
        ])

        return { alerts, counts }
      },
    ),
  ),
)

// PUT /api/work-instructions/:id/alerts
app.put(
  '/:id/alerts',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ request, user }) => {
        const data = await request.json()

        if (!data.alertId) {
          throw new ValidationError('alertId is required')
        }
        if (!data.action || !['acknowledge', 'dismiss'].includes(data.action)) {
          throw new ValidationError('action must be "acknowledge" or "dismiss"')
        }

        if (data.action === 'acknowledge') {
          await WorkInstructionChangeAlertService.acknowledgeAlert(
            data.alertId,
            user.id,
            data.notes,
          )
        } else {
          await WorkInstructionChangeAlertService.dismissAlert(
            data.alertId,
            user.id,
            data.notes,
          )
        }

        return { success: true }
      },
    ),
  ),
)

// POST /api/work-instructions/:id/alerts
app.post(
  '/:id/alerts',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, user }) => {
        const result = await WorkInstructionChangeAlertService.bulkAcknowledge(
          params.id,
          user.id,
        )

        return result
      },
    ),
  ),
)

// GET /api/work-instructions/:id/executions
app.get(
  '/:id/executions',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request }) => {
        const url = new URL(request.url)
        const limit = url.searchParams.get('limit')
          ? parseInt(url.searchParams.get('limit')!)
          : undefined
        const offset = url.searchParams.get('offset')
          ? parseInt(url.searchParams.get('offset')!)
          : undefined

        const result =
          await WorkInstructionExecutionService.listByWorkInstruction(
            params.id,
            { limit, offset },
          )

        return result
      },
    ),
  ),
)

// POST /api/work-instructions/:id/executions
app.post(
  '/:id/executions',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request, user }) => {
        const body = await request.json()
        const { workOrderId } = body as { workOrderId?: string }

        // Check for in-progress execution to resume
        const inProgress = await WorkInstructionExecutionService.findInProgress(
          params.id,
          user.id,
          workOrderId,
        )

        if (inProgress) {
          return { execution: inProgress, resumed: true }
        }

        const execution = await WorkInstructionExecutionService.start(
          params.id,
          user.id,
          workOrderId,
        )

        return new Response(
          JSON.stringify({
            data: { execution, resumed: false },
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      },
    ),
  ),
)

// GET /api/work-instructions/:id/executions/:executionId
app.get(
  '/:id/executions/:executionId',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params }) => {
        const execution = await WorkInstructionExecutionService.findById(
          params.executionId,
        )
        if (!execution) {
          throw new NotFoundError('Execution', params.executionId)
        }

        return { execution }
      },
    ),
  ),
)

// PUT /api/work-instructions/:id/executions/:executionId
app.put(
  '/:id/executions/:executionId',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request }) => {
        const body = await request.json()
        const { stepData, currentStepIndex } = body as {
          stepData?: { blockId: string; value: unknown }
          currentStepIndex?: number
        }

        let execution

        if (stepData) {
          execution = await WorkInstructionExecutionService.updateStepData(
            params.executionId,
            stepData.blockId,
            stepData.value,
          )
        }

        if (currentStepIndex !== undefined) {
          execution = await WorkInstructionExecutionService.updateProgress(
            params.executionId,
            currentStepIndex,
          )
        }

        return { execution }
      },
    ),
  ),
)

// POST /api/work-instructions/:id/executions/:executionId/complete
app.post(
  '/:id/executions/:executionId/complete',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request, user }) => {
        const body = await request.json().catch(() => ({}))
        const { notes } = body as { notes?: string }

        const execution = await WorkInstructionExecutionService.complete(
          params.executionId,
          user.id,
          notes,
        )

        return { execution }
      },
    ),
  ),
)

// POST /api/work-instructions/:id/executions/:executionId/resubmit
app.post(
  '/:id/executions/:executionId/resubmit',
  adapt(
    apiHandler(
      { permission: ['work_orders', 'update'] },
      async ({ params, user }) => {
        const execution =
          await WorkInstructionExecutionService.resubmitForApproval(
            params.executionId,
            user.id,
          )

        return { execution }
      },
    ),
  ),
)

// GET /api/work-instructions/:id/executions/:executionId/sign-off
app.get(
  '/:id/executions/:executionId/sign-off',
  adapt(
    apiHandler({ permission: ['work_orders', 'read'] }, async ({ params }) => {
      const signOffs = await WorkInstructionExecutionService.getSignOff(
        params.executionId,
      )

      return { signOffs }
    }),
  ),
)

// POST /api/work-instructions/:id/executions/:executionId/sign-off
app.post(
  '/:id/executions/:executionId/sign-off',
  adapt(
    apiHandler(
      { permission: ['work_orders', 'update'] },
      async ({ params, request, user }) => {
        const body = await request.json()
        const { decision, comments } = body as {
          decision: 'approved' | 'rejected'
          comments?: string
        }

        if (!decision || !['approved', 'rejected'].includes(decision)) {
          throw new ValidationError('Decision must be "approved" or "rejected"')
        }

        if (decision === 'rejected' && !comments) {
          throw new ValidationError('Comments are required when rejecting')
        }

        const execution = await WorkInstructionExecutionService.submitSignOff(
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

// GET /api/work-instructions/:id/operations
app.get(
  '/:id/operations',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params }) => {
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        const operations = await db
          .select()
          .from(workInstructionOperations)
          .where(eq(workInstructionOperations.workInstructionId, params.id))
          .orderBy(asc(workInstructionOperations.orderIndex))

        return { operations }
      },
    ),
  ),
)

// POST /api/work-instructions/:id/operations
app.post(
  '/:id/operations',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request }) => {
        const data = await request.json()

        if (!data.title?.trim()) {
          throw new ValidationError('Operation title is required')
        }

        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        // Get max orderIndex
        const existing = await db
          .select({ orderIndex: workInstructionOperations.orderIndex })
          .from(workInstructionOperations)
          .where(eq(workInstructionOperations.workInstructionId, params.id))
          .orderBy(asc(workInstructionOperations.orderIndex))

        const maxIndex =
          existing.length > 0
            ? Math.max(...existing.map((o) => o.orderIndex))
            : -1

        const [operation] = await db
          .insert(workInstructionOperations)
          .values({
            id: randomUUID(),
            workInstructionId: params.id,
            orderIndex: maxIndex + 1,
            title: data.title.trim(),
            description: data.description || null,
            estimatedTime: data.estimatedTime || null,
          })
          .returning()

        return new Response(JSON.stringify({ data: { operation } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ),
  ),
)

// PUT /api/work-instructions/:id/operations
app.put(
  '/:id/operations',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request }) => {
        const data = await request.json()

        if (!Array.isArray(data.operations)) {
          throw new ValidationError('operations must be an array')
        }

        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        await db.transaction(async (tx) => {
          for (const op of data.operations) {
            if (!op.id || op.orderIndex === undefined) {
              throw new ValidationError(
                'Each operation must have id and orderIndex',
              )
            }
            await tx
              .update(workInstructionOperations)
              .set({
                orderIndex: op.orderIndex,
                updatedAt: new Date(),
              })
              .where(eq(workInstructionOperations.id, op.id))
          }
        })

        const operations = await db
          .select()
          .from(workInstructionOperations)
          .where(eq(workInstructionOperations.workInstructionId, params.id))
          .orderBy(asc(workInstructionOperations.orderIndex))

        return { operations }
      },
    ),
  ),
)

// PUT /api/work-instructions/:id/operations/:operationId
app.put(
  '/:id/operations/:operationId',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request }) => {
        const data = await request.json()

        const [existing] = await db
          .select()
          .from(workInstructionOperations)
          .where(
            and(
              eq(workInstructionOperations.id, params.operationId),
              eq(workInstructionOperations.workInstructionId, params.id),
            ),
          )
          .limit(1)

        if (!existing) {
          throw new NotFoundError('Operation', params.operationId)
        }

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        }

        if (data.title !== undefined) {
          if (!data.title?.trim()) {
            throw new ValidationError('Operation title cannot be empty')
          }
          updateData.title = data.title.trim()
        }
        if (data.description !== undefined) {
          updateData.description = data.description || null
        }
        if (data.estimatedTime !== undefined) {
          updateData.estimatedTime = data.estimatedTime || null
        }

        const [updated] = await db
          .update(workInstructionOperations)
          .set(updateData)
          .where(eq(workInstructionOperations.id, params.operationId))
          .returning()

        return { operation: updated }
      },
    ),
  ),
)

// DELETE /api/work-instructions/:id/operations/:operationId
app.delete(
  '/:id/operations/:operationId',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params }) => {
        const [existing] = await db
          .select()
          .from(workInstructionOperations)
          .where(
            and(
              eq(workInstructionOperations.id, params.operationId),
              eq(workInstructionOperations.workInstructionId, params.id),
            ),
          )
          .limit(1)

        if (!existing) {
          throw new NotFoundError('Operation', params.operationId)
        }

        // Steps with this operationId will have it set to null (ON DELETE SET NULL)
        await db
          .delete(workInstructionOperations)
          .where(eq(workInstructionOperations.id, params.operationId))

        // Reorder remaining operations to fill gap
        await db
          .update(workInstructionOperations)
          .set({
            orderIndex: sql`${workInstructionOperations.orderIndex} - 1`,
          })
          .where(
            and(
              eq(workInstructionOperations.workInstructionId, params.id),
              gt(workInstructionOperations.orderIndex, existing.orderIndex),
            ),
          )

        return { success: true }
      },
    ),
  ),
)

// GET /api/work-instructions/:id/parts
app.get(
  '/:id/parts',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params }) => {
        // Verify work instruction exists
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        // Get attachments with part details
        const attachments = await db
          .select({
            id: workInstructionPartAttachments.id,
            workInstructionId: workInstructionPartAttachments.workInstructionId,
            partId: workInstructionPartAttachments.partId,
            inheritToMBOM: workInstructionPartAttachments.inheritToMBOM,
            inheritedFromId: workInstructionPartAttachments.inheritedFromId,
            createdAt: workInstructionPartAttachments.createdAt,
            createdBy: workInstructionPartAttachments.createdBy,
            part: {
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
            },
          })
          .from(workInstructionPartAttachments)
          .innerJoin(items, eq(workInstructionPartAttachments.partId, items.id))
          .where(
            eq(workInstructionPartAttachments.workInstructionId, params.id),
          )

        return { attachments }
      },
    ),
  ),
)

// POST /api/work-instructions/:id/parts
app.post(
  '/:id/parts',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()

        if (!data.partId) {
          throw new ValidationError('partId is required')
        }

        // Verify work instruction exists
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        // Verify part exists and is of type Part
        const [part] = await db
          .select()
          .from(items)
          .where(eq(items.id, data.partId))
          .limit(1)

        if (!part) {
          throw new NotFoundError('Part', data.partId)
        }

        if (part.itemType !== 'Part') {
          throw new ValidationError('Can only attach items of type Part')
        }

        // Check if attachment already exists
        const [existingAttachment] = await db
          .select()
          .from(workInstructionPartAttachments)
          .where(
            and(
              eq(workInstructionPartAttachments.workInstructionId, params.id),
              eq(workInstructionPartAttachments.partId, data.partId),
            ),
          )
          .limit(1)

        if (existingAttachment) {
          throw new ValidationError('Part is already attached')
        }

        const [attachment] = await db
          .insert(workInstructionPartAttachments)
          .values({
            id: randomUUID(),
            workInstructionId: params.id,
            partId: data.partId,
            inheritToMBOM: data.inheritToMBOM ?? false,
            createdBy: user.id,
          })
          .returning()

        return new Response(JSON.stringify({ data: { attachment } }), {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      },
    ),
  ),
)

// PATCH /api/work-instructions/:id/parts
app.patch(
  '/:id/parts',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request }) => {
        const data = await request.json()

        if (!data.partId) {
          throw new ValidationError('partId is required')
        }

        const [existing] = await db
          .select()
          .from(workInstructionPartAttachments)
          .where(
            and(
              eq(workInstructionPartAttachments.workInstructionId, params.id),
              eq(workInstructionPartAttachments.partId, data.partId),
            ),
          )
          .limit(1)

        if (!existing) {
          throw new NotFoundError('Part attachment', data.partId)
        }

        const updateData: Record<string, unknown> = {}
        if (data.inheritToMBOM !== undefined) {
          updateData.inheritToMBOM = data.inheritToMBOM
        }

        const [updated] = await db
          .update(workInstructionPartAttachments)
          .set(updateData)
          .where(eq(workInstructionPartAttachments.id, existing.id))
          .returning()

        return { attachment: updated }
      },
    ),
  ),
)

// DELETE /api/work-instructions/:id/parts
app.delete(
  '/:id/parts',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request }) => {
        // Get partId from URL search params or body
        const url = new URL(request.url)
        let partId = url.searchParams.get('partId')

        if (!partId) {
          try {
            const body = await request.json()
            partId = body.partId
          } catch {
            // Body might be empty
          }
        }

        if (!partId) {
          throw new ValidationError('partId is required')
        }

        // Delete the attachment
        const result = await db
          .delete(workInstructionPartAttachments)
          .where(
            and(
              eq(workInstructionPartAttachments.workInstructionId, params.id),
              eq(workInstructionPartAttachments.partId, partId),
            ),
          )
          .returning()

        if (result.length === 0) {
          throw new NotFoundError('Part attachment', partId)
        }

        return { success: true }
      },
    ),
  ),
)

// GET /api/work-instructions/:id/resolve-parametric
app.get(
  '/:id/resolve-parametric',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params }) => {
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        const resolved = await ParametricResolutionService.resolveAllSteps(
          params.id,
        )

        return { resolved }
      },
    ),
  ),
)

// GET /api/work-instructions/:id/steps
app.get(
  '/:id/steps',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params }) => {
        // Verify work instruction exists
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        const steps = await db
          .select()
          .from(workInstructionSteps)
          .where(eq(workInstructionSteps.workInstructionId, params.id))
          .orderBy(asc(workInstructionSteps.orderIndex))

        return { steps }
      },
    ),
  ),
)

// POST /api/work-instructions/:id/steps
app.post(
  '/:id/steps',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request }) => {
        const data = await request.json()

        // Verify work instruction exists
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        // Get the max orderIndex to add at the end
        const existingSteps = await db
          .select({ orderIndex: workInstructionSteps.orderIndex })
          .from(workInstructionSteps)
          .where(eq(workInstructionSteps.workInstructionId, params.id))
          .orderBy(asc(workInstructionSteps.orderIndex))

        const maxIndex =
          existingSteps.length > 0
            ? Math.max(...existingSteps.map((s) => s.orderIndex))
            : -1

        const newOrderIndex =
          data.orderIndex !== undefined ? data.orderIndex : maxIndex + 1

        // If inserting at a specific position, shift other steps
        if (data.orderIndex !== undefined && data.orderIndex <= maxIndex) {
          await db
            .update(workInstructionSteps)
            .set({
              orderIndex: sql`${workInstructionSteps.orderIndex} + 1`,
            })
            .where(
              and(
                eq(workInstructionSteps.workInstructionId, params.id),
                gt(workInstructionSteps.orderIndex, data.orderIndex - 1),
              ),
            )
        }

        const stepId = randomUUID()
        const content: StepContent = data.content || { blocks: [] }

        const [newStep] = await db
          .insert(workInstructionSteps)
          .values({
            id: stepId,
            workInstructionId: params.id,
            orderIndex: newOrderIndex,
            title: data.title || null,
            content,
          })
          .returning()

        return new Response(JSON.stringify({ data: { step: newStep } }), {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      },
    ),
  ),
)

// PUT /api/work-instructions/:id/steps
app.put(
  '/:id/steps',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request }) => {
        const data = await request.json()

        if (!Array.isArray(data.steps)) {
          throw new ValidationError('steps must be an array')
        }

        // Verify work instruction exists
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        // Update each step's orderIndex
        await db.transaction(async (tx) => {
          for (const step of data.steps) {
            if (!step.id || step.orderIndex === undefined) {
              throw new ValidationError('Each step must have id and orderIndex')
            }
            await tx
              .update(workInstructionSteps)
              .set({
                orderIndex: step.orderIndex,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(workInstructionSteps.id, step.id),
                  eq(workInstructionSteps.workInstructionId, params.id),
                ),
              )
          }
        })

        // Return updated steps
        const steps = await db
          .select()
          .from(workInstructionSteps)
          .where(eq(workInstructionSteps.workInstructionId, params.id))
          .orderBy(asc(workInstructionSteps.orderIndex))

        return { steps }
      },
    ),
  ),
)

// GET /api/work-instructions/:id/steps/:stepId
app.get(
  '/:id/steps/:stepId',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'read'] },
      async ({ params }) => {
        const [step] = await db
          .select()
          .from(workInstructionSteps)
          .where(
            and(
              eq(workInstructionSteps.id, params.stepId),
              eq(workInstructionSteps.workInstructionId, params.id),
            ),
          )
          .limit(1)

        if (!step) {
          throw new NotFoundError('Step', params.stepId)
        }

        return { step }
      },
    ),
  ),
)

// PUT /api/work-instructions/:id/steps/:stepId
app.put(
  '/:id/steps/:stepId',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params, request }) => {
        const data = await request.json()

        // Verify step exists and belongs to this work instruction
        const [existing] = await db
          .select()
          .from(workInstructionSteps)
          .where(
            and(
              eq(workInstructionSteps.id, params.stepId),
              eq(workInstructionSteps.workInstructionId, params.id),
            ),
          )
          .limit(1)

        if (!existing) {
          throw new NotFoundError('Step', params.stepId)
        }

        const updateData: any = {
          updatedAt: new Date(),
        }

        if (data.title !== undefined) {
          updateData.title = data.title || null
        }
        if (data.content !== undefined) {
          updateData.content = data.content
        }
        if (data.orderIndex !== undefined) {
          updateData.orderIndex = data.orderIndex
        }
        if (data.operationId !== undefined) {
          updateData.operationId = data.operationId
        }

        const [updatedStep] = await db
          .update(workInstructionSteps)
          .set(updateData)
          .where(eq(workInstructionSteps.id, params.stepId))
          .returning()

        return { step: updatedStep }
      },
    ),
  ),
)

// DELETE /api/work-instructions/:id/steps/:stepId
app.delete(
  '/:id/steps/:stepId',
  adapt(
    apiHandler(
      { permission: ['work_instructions', 'update'] },
      async ({ params }) => {
        // Verify step exists
        const [existing] = await db
          .select()
          .from(workInstructionSteps)
          .where(
            and(
              eq(workInstructionSteps.id, params.stepId),
              eq(workInstructionSteps.workInstructionId, params.id),
            ),
          )
          .limit(1)

        if (!existing) {
          throw new NotFoundError('Step', params.stepId)
        }

        // Delete the step
        await db
          .delete(workInstructionSteps)
          .where(eq(workInstructionSteps.id, params.stepId))

        // Reorder remaining steps to fill the gap
        await db
          .update(workInstructionSteps)
          .set({
            orderIndex: sql`${workInstructionSteps.orderIndex} - 1`,
          })
          .where(
            and(
              eq(workInstructionSteps.workInstructionId, params.id),
              gt(workInstructionSteps.orderIndex, existing.orderIndex),
            ),
          )

        return { success: true }
      },
    ),
  ),
)

export default app
