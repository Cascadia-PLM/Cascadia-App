// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { ValidationError } from '@/lib/errors'
import {
  items,
  workInstructionOperations,
  workInstructionPartAttachments,
  workInstructionSteps,
  workInstructions,
} from '@/lib/db/schema'

registerTypeHandler('WorkInstruction', {
  table: workInstructions,

  async insert(itemId, data, tx, ctx) {
    const run = tx ?? db
    await run.insert(workInstructions).values({
      itemId,
      description: data.description || null,
      estimatedTime: data.estimatedTime || null,
      difficulty: data.difficulty || null,
      safetyNotes: data.safetyNotes || null,
      requiredTools: data.requiredTools || null,
    })

    // The output part — the part this procedure builds — is stored as the
    // attachment flagged isOutput, written here so a work instruction is never
    // committed without the attachment its designId was derived from.
    //
    // Creation always supplies it (workInstructionSchema requires it), but this
    // same method is reused by createRevision, which passes the stored
    // work_instructions row — no outputPartId on it — and lets copyChildren
    // carry the existing attachments, isOutput included. Hence the guard.
    if (data.outputPartId && ctx?.userId) {
      // The design a work instruction lives in is the design its output part
      // lives in. Checked here, inside the creating transaction, so every path
      // upholds it — createOnBranch and direct service calls included, not just
      // the HTTP route that derives designId in the first place.
      const [outputPart] = await run
        .select({ itemType: items.itemType, designId: items.designId })
        .from(items)
        .where(eq(items.id, data.outputPartId))
        .limit(1)

      if (!outputPart || outputPart.itemType !== 'Part') {
        throw new ValidationError(
          "A work instruction's output part must be an existing Part",
        )
      }
      if (!outputPart.designId || outputPart.designId !== data.designId) {
        throw new ValidationError(
          "A work instruction must be created in its output part's design",
        )
      }

      await run.insert(workInstructionPartAttachments).values({
        workInstructionId: itemId,
        partId: data.outputPartId,
        isOutput: true,
        createdBy: ctx.userId,
      })
    }
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [wi] = await run
      .select()
      .from(workInstructions)
      .where(eq(workInstructions.itemId, itemId))
      .limit(1)
    return wi
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.description !== undefined)
      updateData.description = data.description || null
    if (data.estimatedTime !== undefined)
      updateData.estimatedTime = data.estimatedTime || null
    if (data.difficulty !== undefined)
      updateData.difficulty = data.difficulty || null
    if (data.safetyNotes !== undefined)
      updateData.safetyNotes = data.safetyNotes || null
    if (data.requiredTools !== undefined)
      updateData.requiredTools = data.requiredTools || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(workInstructions)
        .set(updateData)
        .where(eq(workInstructions.itemId, itemId))
    }
  },

  /**
   * A work instruction's content lives in child tables keyed by the item
   * version id — operations, steps, and part attachments. Without this copy an
   * ECO revision of a Released WI would start empty.
   *
   * Operations get fresh ids, so steps are remapped onto them; a step whose
   * operation is missing from the map stays unparented rather than pointing at
   * the source version's operation.
   */
  async copyChildren(sourceItemId, targetItemId, tx) {
    const run = tx ?? db

    const sourceOps = await run
      .select()
      .from(workInstructionOperations)
      .where(eq(workInstructionOperations.workInstructionId, sourceItemId))

    const operationIdMap = new Map<string, string>()
    for (const op of sourceOps) {
      const [newOp] = await run
        .insert(workInstructionOperations)
        .values({
          workInstructionId: targetItemId,
          orderIndex: op.orderIndex,
          title: op.title,
          description: op.description,
          estimatedTime: op.estimatedTime,
        })
        .returning({ id: workInstructionOperations.id })
      if (newOp) {
        operationIdMap.set(op.id, newOp.id)
      }
    }

    const sourceSteps = await run
      .select()
      .from(workInstructionSteps)
      .where(eq(workInstructionSteps.workInstructionId, sourceItemId))
    if (sourceSteps.length > 0) {
      await run.insert(workInstructionSteps).values(
        sourceSteps.map((step) => ({
          workInstructionId: targetItemId,
          operationId: step.operationId
            ? (operationIdMap.get(step.operationId) ?? null)
            : null,
          orderIndex: step.orderIndex,
          title: step.title,
          content: step.content,
        })),
      )
    }

    const sourceAttachments = await run
      .select()
      .from(workInstructionPartAttachments)
      .where(eq(workInstructionPartAttachments.workInstructionId, sourceItemId))
    if (sourceAttachments.length > 0) {
      await run
        .insert(workInstructionPartAttachments)
        .values(
          sourceAttachments.map((att) => ({
            workInstructionId: targetItemId,
            partId: att.partId,
            // Carried, not recomputed: the revision builds the same part, and
            // dropping it would leave the new version with a designId whose
            // output attachment no longer exists.
            isOutput: att.isOutput,
            inheritToMBOM: att.inheritToMBOM,
            inheritedFromId: att.inheritedFromId,
            createdBy: att.createdBy,
          })),
        )
        .onConflictDoNothing()
    }
  },
})
