// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { WorkInstruction } from '@/lib/items/types/work-instruction'
import type { StepContent } from '@/lib/db/schema/items'
import { ItemService } from '@/lib/items/services/ItemService'
import { WorkOrderInstructionService } from '@/lib/services/WorkOrderInstructionService'
import { WorkInstructionChangeAlertService } from '@/lib/services/WorkInstructionChangeAlertService'
import { ParametricResolutionService } from '@/lib/services/ParametricResolutionService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
import { workInstructionUpdateSchema } from '@/lib/api/schemas'
import { stepContentSchema } from '@/lib/items/types/work-instruction'
import { requireItemAccess } from '@/lib/auth/access'
import { db } from '@/lib/db'
import { takeFirst } from '@/lib/db/take-first'
import {
  items,
  workInstructionOperations,
  workInstructionPartAttachments,
  workInstructionSteps,
  workInstructions,
} from '@/lib/db/schema'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

/**
 * Bodies for this file's own sub-resources. Operations, steps and part
 * attachments are rows the editor writes directly rather than items, so their
 * shapes live here rather than in `lib/items/types`.
 */

/** Acknowledge or dismiss one change alert. */
const alertActionSchema = z.object({
  alertId: z.string().uuid(),
  action: z.enum(['acknowledge', 'dismiss']),
  notes: z.string().max(5000).optional(),
})

const operationCreateSchema = z.object({
  title: z.string().trim().min(1, 'Operation title is required').max(500),
  description: z.string().max(10000).nullish(),
  estimatedTime: z.number().int().min(0).max(1_000_000).nullish(),
})

const operationUpdateSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Operation title cannot be empty')
    .max(500)
    .optional(),
  description: z.string().max(10000).nullish(),
  estimatedTime: z.number().int().min(0).max(1_000_000).nullish(),
})

/** Reorder: every row named, each with the index it should end up at. */
const reorderedRowsSchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      orderIndex: z.number().int().min(0).max(100000),
    }),
  )
  .max(10000)

const operationsReorderSchema = z.object({ operations: reorderedRowsSchema })
const stepsReorderSchema = z.object({ steps: reorderedRowsSchema })

const partAttachSchema = z.object({
  partId: z.string().uuid(),
  inheritToMBOM: z.boolean().optional(),
})

const partAttachmentPatchSchema = z.object({
  partId: z.string().uuid(),
  inheritToMBOM: z.boolean().optional(),
  isOutput: z.boolean().optional(),
})

/** DELETE takes its target from the query string or the body; both optional. */
const partDetachSchema = z.object({
  partId: z.string().uuid().optional(),
})

const stepCreateSchema = z.object({
  title: z.string().max(500).nullish(),
  content: stepContentSchema.optional(),
  orderIndex: z.number().int().min(0).max(100000).optional(),
})

const stepUpdateSchema = z.object({
  title: z.string().max(500).nullish(),
  content: stepContentSchema.optional(),
  orderIndex: z.number().int().min(0).max(100000).optional(),
  operationId: z.string().uuid().nullish(),
})

const adapt = tagged('Work Instructions')

const app = new Hono()

/**
 * WI content (operations, steps, part attachments) lives in sub-tables keyed
 * by the item version id, so these raw writes would otherwise bypass the item
 * edit-lock policy entirely. Every content mutation below goes through this
 * guard: the caller must hold the checkout on branch working copies, and
 * protected main blocks direct edits (revise via an ECO instead).
 */
async function requireEditableWorkInstruction(
  itemId: string,
  userId: string,
): Promise<void> {
  const item = await ItemService.findById(itemId)
  if (!item || item.itemType !== 'WorkInstruction') {
    throw new NotFoundError('Work Instruction', itemId)
  }
  await ItemService.requireContentEditable(item, userId)
}

// GET /api/work-instructions/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof workInstructionUpdateSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: workInstructionUpdateSchema,
      },
      async ({ params, body, user }) => {
        // The schema permits `null` where the column is nullable, which the
        // WorkInstruction interface spells as an absent optional; both the
        // service and the type handler read null as "clear the column".
        const workInstruction = await ItemService.update<WorkInstruction>(
          params.id,
          body as Partial<WorkInstruction>,
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
    apiHandler<{ id: string }>(
      { permission: ['work_instructions', 'delete'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await ItemService.delete(params.id, user.id)

        return { success: true }
      },
    ),
  ),
)

// GET /api/work-instructions/:id/alerts
app.get(
  '/:id/alerts',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, request, user }) => {
        await requireItemAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof alertActionSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: alertActionSchema,
      },
      async ({ body: data, user }) => {
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
    apiHandler<{ id: string }>(
      { permission: ['work_instructions', 'update'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const result = await WorkInstructionChangeAlertService.bulkAcknowledge(
          params.id,
          user.id,
        )

        return result
      },
    ),
  ),
)

// GET /api/work-instructions/:id/usage
// Executions moved to work orders (runs of traveler lines) — this is the
// author-side view of where this template is instantiated.
app.get(
  '/:id/usage',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['work_instructions', 'read'],
        openapi: {
          summary:
            'Where this template is instantiated: traveler lines across work orders, with progress',
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        const usage = await WorkOrderInstructionService.listByTemplate(
          params.id,
        )
        return { usage }
      },
    ),
  ),
)

// GET /api/work-instructions/:id/operations
app.get(
  '/:id/operations',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof operationCreateSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: operationCreateSchema,
      },
      async ({ params, body: data, user }) => {
        await requireEditableWorkInstruction(params.id, user.id)

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

        const operation = takeFirst(
          await db
            .insert(workInstructionOperations)
            .values({
              id: randomUUID(),
              workInstructionId: params.id,
              orderIndex: maxIndex + 1,
              title: data.title.trim(),
              description: data.description || null,
              estimatedTime: data.estimatedTime || null,
            })
            .returning(),
        )

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
    apiHandler<{ id: string }, z.infer<typeof operationsReorderSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: operationsReorderSchema,
      },
      async ({ params, body: data, user }) => {
        await requireEditableWorkInstruction(params.id, user.id)

        const [wi] = await db
          .select()
          .from(workInstructions)
          .where(eq(workInstructions.itemId, params.id))
          .limit(1)

        if (!wi) {
          throw new NotFoundError('Work Instruction', params.id)
        }

        // One statement, and one access boundary. The workInstructionId
        // predicate is load-bearing: without it an id from any other work
        // instruction named in the body would be renumbered here, escaping the
        // access check this handler just made on params.id. Out-of-scope ids
        // are silently ignored, matching the steps reorder below.
        if (data.operations.length > 0) {
          const cases = sql.join(
            data.operations.map(
              (op) =>
                sql`when ${workInstructionOperations.id} = ${op.id}::uuid then ${op.orderIndex}::integer`,
            ),
            sql` `,
          )

          await db
            .update(workInstructionOperations)
            .set({
              orderIndex: sql`case ${cases} else ${workInstructionOperations.orderIndex} end`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(workInstructionOperations.workInstructionId, params.id),
                inArray(
                  workInstructionOperations.id,
                  data.operations.map((op) => op.id),
                ),
              ),
            )
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

// PUT /api/work-instructions/:id/operations/:operationId
app.put(
  '/:id/operations/:operationId',
  adapt(
    apiHandler<
      { id: string; operationId: string },
      z.infer<typeof operationUpdateSchema>
    >(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: operationUpdateSchema,
      },
      async ({ params, body: data, user }) => {
        await requireEditableWorkInstruction(params.id, user.id)

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
          updateData.title = data.title
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
    apiHandler<{ id: string; operationId: string }>(
      { permission: ['work_instructions', 'update'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await requireEditableWorkInstruction(params.id, user.id)

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
    apiHandler<{ id: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
            isOutput: workInstructionPartAttachments.isOutput,
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
    apiHandler<{ id: string }, z.infer<typeof partAttachSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: partAttachSchema,
      },
      async ({ params, body: data, user }) => {
        await requireEditableWorkInstruction(params.id, user.id)

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

        const attachment = takeFirst(
          await db
            .insert(workInstructionPartAttachments)
            .values({
              id: randomUUID(),
              workInstructionId: params.id,
              partId: data.partId,
              inheritToMBOM: data.inheritToMBOM ?? false,
              createdBy: user.id,
            })
            .returning(),
        )

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
    apiHandler<{ id: string }, z.infer<typeof partAttachmentPatchSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: partAttachmentPatchSchema,
      },
      async ({ params, body: data, user }) => {
        await requireEditableWorkInstruction(params.id, user.id)

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

        // Promoting an attachment to output part moves the work instruction
        // into that part's design — the designId is derived from the output
        // part, so the two move together or they disagree. Demoting without
        // naming a replacement is refused: it would leave the WI with a design
        // and no output part to justify it.
        const promoting = data.isOutput === true && !existing.isOutput
        if (data.isOutput === false && existing.isOutput) {
          throw new ValidationError(
            'Cannot unset the output part. Set another attachment as the output part instead.',
          )
        }

        if (!promoting) {
          if (Object.keys(updateData).length === 0) {
            return { attachment: existing }
          }
          const [updated] = await db
            .update(workInstructionPartAttachments)
            .set(updateData)
            .where(eq(workInstructionPartAttachments.id, existing.id))
            .returning()
          return { attachment: updated }
        }

        const newOutputPart = await ItemService.findById(data.partId)
        if (!newOutputPart?.designId) {
          throw new ValidationError(
            'The new output part is not in a design and cannot anchor a work instruction',
          )
        }

        const updated = await db.transaction(async (tx) => {
          // Clear the incumbent first — the partial unique index allows only
          // one output attachment per work instruction at a time.
          await tx
            .update(workInstructionPartAttachments)
            .set({ isOutput: false })
            .where(
              and(
                eq(workInstructionPartAttachments.workInstructionId, params.id),
                eq(workInstructionPartAttachments.isOutput, true),
              ),
            )

          const [row] = await tx
            .update(workInstructionPartAttachments)
            .set({ ...updateData, isOutput: true })
            .where(eq(workInstructionPartAttachments.id, existing.id))
            .returning()

          await tx
            .update(items)
            .set({ designId: newOutputPart.designId, modifiedBy: user.id })
            .where(eq(items.id, params.id))

          return row
        })

        return { attachment: updated }
      },
    ),
  ),
)

// DELETE /api/work-instructions/:id/parts
app.delete(
  '/:id/parts',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof partDetachSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: partDetachSchema,
      },
      // The part comes from the query string or the body: the editor sends one
      // and the API docs show the other, and both have always worked.
      async ({ params, request, body, user }) => {
        const partId =
          new URL(request.url).searchParams.get('partId') ?? body.partId

        if (!partId) {
          throw new ValidationError('partId is required')
        }

        await requireEditableWorkInstruction(params.id, user.id)

        // Delete the attachment. The output part is exempt: it is what the
        // work instruction's designId was derived from, so detaching it would
        // strand the WI in a design it no longer has any claim to. Point the
        // output at a different part instead (PATCH isOutput), which moves the
        // design with it.
        const result = await db
          .delete(workInstructionPartAttachments)
          .where(
            and(
              eq(workInstructionPartAttachments.workInstructionId, params.id),
              eq(workInstructionPartAttachments.partId, partId),
              eq(workInstructionPartAttachments.isOutput, false),
            ),
          )
          .returning()

        if (result.length === 0) {
          const [stillThere] = await db
            .select({ isOutput: workInstructionPartAttachments.isOutput })
            .from(workInstructionPartAttachments)
            .where(
              and(
                eq(workInstructionPartAttachments.workInstructionId, params.id),
                eq(workInstructionPartAttachments.partId, partId),
              ),
            )
            .limit(1)

          if (stillThere?.isOutput) {
            throw new ValidationError(
              'Cannot detach the output part. Set a different attachment as the output part first.',
            )
          }
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
    apiHandler<{ id: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
    apiHandler<{ id: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
    apiHandler<{ id: string }, z.infer<typeof stepCreateSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: stepCreateSchema,
      },
      async ({ params, body: data, user }) => {
        await requireEditableWorkInstruction(params.id, user.id)

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

        const newStep = takeFirst(
          await db
            .insert(workInstructionSteps)
            .values({
              id: stepId,
              workInstructionId: params.id,
              orderIndex: newOrderIndex,
              title: data.title || null,
              content,
            })
            .returning(),
        )

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
    apiHandler<{ id: string }, z.infer<typeof stepsReorderSchema>>(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: stepsReorderSchema,
      },
      async ({ params, body: data, user }) => {
        await requireEditableWorkInstruction(params.id, user.id)

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
    apiHandler<{ id: string; stepId: string }>(
      { permission: ['work_instructions', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
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
    apiHandler<
      { id: string; stepId: string },
      z.infer<typeof stepUpdateSchema>
    >(
      {
        permission: ['work_instructions', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: stepUpdateSchema,
      },
      async ({ params, body: data, user }) => {
        await requireEditableWorkInstruction(params.id, user.id)

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

        const updateData: Partial<typeof workInstructionSteps.$inferInsert> = {
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
    apiHandler<{ id: string; stepId: string }>(
      { permission: ['work_instructions', 'update'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await requireEditableWorkInstruction(params.id, user.id)

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
