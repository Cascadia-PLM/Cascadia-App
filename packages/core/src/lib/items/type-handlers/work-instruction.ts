// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import {
  workInstructionOperations,
  workInstructionPartAttachments,
  workInstructionSteps,
  workInstructions,
} from '@/lib/db/schema'

registerTypeHandler('WorkInstruction', {
  table: workInstructions,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(workInstructions).values({
      itemId,
      description: data.description || null,
      estimatedTime: data.estimatedTime || null,
      difficulty: data.difficulty || null,
      safetyNotes: data.safetyNotes || null,
      requiredTools: data.requiredTools || null,
    })
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
            inheritToMBOM: att.inheritToMBOM,
            inheritedFromId: att.inheritedFromId,
            createdBy: att.createdBy,
          })),
        )
        .onConflictDoNothing()
    }
  },
})
