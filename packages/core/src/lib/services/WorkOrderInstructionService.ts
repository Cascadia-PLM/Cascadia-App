// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { LifecycleService } from './LifecycleService'
import type {
  InstantiateInstructionInput,
  WorkOrderInstruction,
  WorkOrderInstructionStatus,
} from '@/lib/items/types/work-order'
import type { InstructionSnapshot } from '@/lib/db/schema/work-orders'
import type { TransactionClient } from '@/lib/db'
import { db } from '@/lib/db'
import {
  instructionExecutions,
  itemRelationships,
  items,
  workInstructionOperations,
  workInstructionPartAttachments,
  workInstructionSteps,
  workInstructions,
  workOrderInstructions,
  workOrders,
} from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { takeFirst } from '@/lib/db/take-first'

/**
 * Traveler management: instances of WorkInstruction templates inside a
 * work order. Instantiation freezes the template content into a snapshot;
 * line status is derived from executions, never stored.
 * See docs/features/work-order-traveler.md.
 */

/** Maximum BOM depth walked by populate(); guards against cycles. */
const MAX_BOM_DEPTH = 25

interface ExecutionTally {
  executionCount: number
  completedCount: number
}

function deriveStatus(
  line: { skippedAt: Date | null; requiredCount: number },
  tally: ExecutionTally,
): WorkOrderInstructionStatus {
  if (line.skippedAt) return 'Skipped'
  if (tally.completedCount >= line.requiredCount) return 'Complete'
  if (tally.executionCount > 0) return 'In Progress'
  return 'Not Started'
}

async function getWorkOrder(workOrderId: string) {
  const row = (
    await db
      .select({ item: items, workOrder: workOrders })
      .from(workOrders)
      .innerJoin(items, eq(workOrders.itemId, items.id))
      .where(eq(workOrders.itemId, workOrderId))
      .limit(1)
  )[0]
  if (!row) throw new NotFoundError('Work Order', workOrderId)
  return row
}

export class WorkOrderInstructionService {
  /**
   * Freeze a template's current content. Runs inside the instantiation
   * transaction so the snapshot is a consistent read.
   */
  private static async buildSnapshot(
    tx: TransactionClient,
    workInstructionId: string,
  ): Promise<{
    snapshot: InstructionSnapshot
    title: string
    instructionNumber: string
    instructionRevision: string
  }> {
    const wi = (
      await tx
        .select({ item: items, detail: workInstructions })
        .from(workInstructions)
        .innerJoin(items, eq(workInstructions.itemId, items.id))
        .where(eq(workInstructions.itemId, workInstructionId))
        .limit(1)
    )[0]
    if (!wi) throw new NotFoundError('Work Instruction', workInstructionId)

    const [operations, steps] = await Promise.all([
      tx
        .select()
        .from(workInstructionOperations)
        .where(
          eq(workInstructionOperations.workInstructionId, workInstructionId),
        )
        .orderBy(asc(workInstructionOperations.orderIndex)),
      tx
        .select()
        .from(workInstructionSteps)
        .where(eq(workInstructionSteps.workInstructionId, workInstructionId))
        .orderBy(asc(workInstructionSteps.orderIndex)),
    ])

    const snapshot: InstructionSnapshot = {
      name: wi.item.name ?? wi.item.itemNumber,
      description: wi.detail.description,
      estimatedTime: wi.detail.estimatedTime,
      difficulty: wi.detail.difficulty,
      safetyNotes: wi.detail.safetyNotes,
      requiredTools: wi.detail.requiredTools,
      operations: operations.map((op) => ({
        id: op.id,
        orderIndex: op.orderIndex,
        title: op.title,
        description: op.description,
        estimatedTime: op.estimatedTime,
      })),
      steps: steps.map((step) => ({
        id: step.id,
        operationId: step.operationId,
        orderIndex: step.orderIndex,
        title: step.title,
        content: step.content ?? { blocks: [] },
      })),
    }

    return {
      snapshot,
      title: wi.item.name ?? wi.item.itemNumber,
      instructionNumber: wi.item.itemNumber,
      instructionRevision: wi.item.revision,
    }
  }

  /**
   * Add a traveler line: instantiate a template into a work order,
   * freezing its content. `perUnit` pins requiredCount to the order
   * quantity at instantiation time.
   */
  static async instantiate(
    workOrderId: string,
    input: InstantiateInstructionInput,
    userId: string,
  ) {
    const wo = await getWorkOrder(workOrderId)
    // Any final state freezes the traveler, whatever it is named
    if (
      (await LifecycleService.getFinalStateIds('WorkOrder')).includes(
        wo.item.state,
      )
    ) {
      throw new ValidationError(
        `Work order ${wo.item.itemNumber} is ${wo.item.state} — its traveler is frozen`,
      )
    }

    const partId = input.partId ?? wo.workOrder.partId ?? null
    if (partId) {
      const part = (
        await db.select().from(items).where(eq(items.id, partId)).limit(1)
      )[0]
      if (!part) throw new NotFoundError('Part', partId)
      if (part.itemType !== 'Part') {
        throw new ValidationError(
          'Traveler lines can only target items of type Part',
        )
      }
    }

    const requiredCount = input.perUnit
      ? wo.workOrder.quantity
      : (input.requiredCount ?? 1)

    return db.transaction(async (tx) => {
      const { snapshot, title, instructionNumber, instructionRevision } =
        await this.buildSnapshot(tx, input.workInstructionId)

      const [maxRow] = await tx
        .select({
          max: sql<number | null>`max(${workOrderInstructions.orderIndex})`,
        })
        .from(workOrderInstructions)
        .where(eq(workOrderInstructions.workOrderId, workOrderId))

      return takeFirst(
        await tx
          .insert(workOrderInstructions)
          .values({
            workOrderId,
            workInstructionId: input.workInstructionId,
            partId,
            orderIndex: (maxRow?.max ?? -1) + 1,
            title,
            instructionNumber,
            instructionRevision,
            snapshot,
            snapshotAt: new Date(),
            requiredCount,
            createdBy: userId,
          })
          .returning(),
      )
    })
  }

  /**
   * Build the traveler from part applicability: walk the order part's BOM
   * and instantiate every template attached to any part in the tree,
   * deepest parts first (children are built before their assembly).
   * Idempotent per (template, part) — lines added by hand are respected.
   */
  static async populate(workOrderId: string, userId: string) {
    const wo = await getWorkOrder(workOrderId)
    if (!wo.workOrder.partId) {
      throw new ValidationError(
        `Work order ${wo.item.itemNumber} has no part — set the part it builds before populating the traveler`,
      )
    }

    // BFS down BOM edges, tracking depth; deepest-first build order.
    const depthByPart = new Map<string, number>([[wo.workOrder.partId, 0]])
    let frontier = [wo.workOrder.partId]
    for (let depth = 1; depth <= MAX_BOM_DEPTH; depth++) {
      if (frontier.length === 0) break
      const children = await db
        .select({ childId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(
          and(
            inArray(itemRelationships.sourceId, frontier),
            eq(itemRelationships.relationshipType, 'BOM'),
          ),
        )
      frontier = []
      for (const { childId } of children) {
        if (!depthByPart.has(childId)) {
          depthByPart.set(childId, depth)
          frontier.push(childId)
        }
      }
    }

    const partIds = Array.from(depthByPart.keys())
    const attachments = await db
      .select({
        workInstructionId: workInstructionPartAttachments.workInstructionId,
        partId: workInstructionPartAttachments.partId,
        createdAt: workInstructionPartAttachments.createdAt,
      })
      .from(workInstructionPartAttachments)
      .where(inArray(workInstructionPartAttachments.partId, partIds))

    const existing = await db
      .select({
        workInstructionId: workOrderInstructions.workInstructionId,
        partId: workOrderInstructions.partId,
      })
      .from(workOrderInstructions)
      .where(eq(workOrderInstructions.workOrderId, workOrderId))
    const present = new Set(
      existing.map((line) => `${line.workInstructionId}::${line.partId}`),
    )

    const toCreate = attachments
      .filter((att) => !present.has(`${att.workInstructionId}::${att.partId}`))
      .sort((a, b) => {
        const depthDiff =
          (depthByPart.get(b.partId) ?? 0) - (depthByPart.get(a.partId) ?? 0)
        if (depthDiff !== 0) return depthDiff
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      })

    const created = []
    for (const att of toCreate) {
      created.push(
        await this.instantiate(
          workOrderId,
          { workInstructionId: att.workInstructionId, partId: att.partId },
          userId,
        ),
      )
    }
    return { created, skipped: attachments.length - toCreate.length }
  }

  /** Per-line execution tallies for a set of lines. */
  private static async tallies(
    lineIds: Array<string>,
  ): Promise<Map<string, ExecutionTally>> {
    if (lineIds.length === 0) return new Map()
    const rows = await db
      .select({
        lineId: instructionExecutions.workOrderInstructionId,
        executionCount: count(),
        completedCount: count(
          sql`CASE WHEN ${instructionExecutions.status} IN ('Complete', 'Approved') THEN 1 END`,
        ),
      })
      .from(instructionExecutions)
      .where(inArray(instructionExecutions.workOrderInstructionId, lineIds))
      .groupBy(instructionExecutions.workOrderInstructionId)
    return new Map(
      rows.map((row) => [
        row.lineId,
        {
          executionCount: row.executionCount,
          completedCount: row.completedCount,
        },
      ]),
    )
  }

  private static toApiShape(
    line: typeof workOrderInstructions.$inferSelect,
    tally: ExecutionTally,
    part: {
      id: string
      itemNumber: string
      name: string | null
      revision: string
    } | null,
  ): WorkOrderInstruction {
    return {
      ...line,
      status: deriveStatus(line, tally),
      completedCount: tally.completedCount,
      executionCount: tally.executionCount,
      part,
    }
  }

  /** The traveler, in sequence, with derived status and progress. */
  static async list(workOrderId: string): Promise<Array<WorkOrderInstruction>> {
    await getWorkOrder(workOrderId)

    const rows = await db
      .select({
        line: workOrderInstructions,
        partItemNumber: items.itemNumber,
        partName: items.name,
        partRevision: items.revision,
      })
      .from(workOrderInstructions)
      .leftJoin(items, eq(workOrderInstructions.partId, items.id))
      .where(eq(workOrderInstructions.workOrderId, workOrderId))
      .orderBy(asc(workOrderInstructions.orderIndex))

    const tallyMap = await this.tallies(rows.map((row) => row.line.id))
    return rows.map((row) =>
      this.toApiShape(
        row.line,
        tallyMap.get(row.line.id) ?? { executionCount: 0, completedCount: 0 },
        row.line.partId && row.partItemNumber
          ? {
              id: row.line.partId,
              itemNumber: row.partItemNumber,
              name: row.partName,
              revision: row.partRevision ?? '',
            }
          : null,
      ),
    )
  }

  /** A single traveler line with derived status, scoped to its order. */
  static async get(
    workOrderId: string,
    lineId: string,
  ): Promise<WorkOrderInstruction> {
    const row = (
      await db
        .select({
          line: workOrderInstructions,
          partItemNumber: items.itemNumber,
          partName: items.name,
          partRevision: items.revision,
        })
        .from(workOrderInstructions)
        .leftJoin(items, eq(workOrderInstructions.partId, items.id))
        .where(
          and(
            eq(workOrderInstructions.id, lineId),
            eq(workOrderInstructions.workOrderId, workOrderId),
          ),
        )
        .limit(1)
    )[0]
    if (!row) throw new NotFoundError('Work Order Instruction', lineId)

    const tallyMap = await this.tallies([lineId])
    return this.toApiShape(
      row.line,
      tallyMap.get(lineId) ?? { executionCount: 0, completedCount: 0 },
      row.line.partId && row.partItemNumber
        ? {
            id: row.line.partId,
            itemNumber: row.partItemNumber,
            name: row.partName,
            revision: row.partRevision ?? '',
          }
        : null,
    )
  }

  /** Raw line row scoped to an order (no derived fields). */
  static async getLineRow(workOrderId: string, lineId: string) {
    const line = (
      await db
        .select()
        .from(workOrderInstructions)
        .where(
          and(
            eq(workOrderInstructions.id, lineId),
            eq(workOrderInstructions.workOrderId, workOrderId),
          ),
        )
        .limit(1)
    )[0]
    if (!line) throw new NotFoundError('Work Order Instruction', lineId)
    return line
  }

  static async reorder(
    workOrderId: string,
    entries: Array<{ id: string; orderIndex: number }>,
  ) {
    await getWorkOrder(workOrderId)
    await db.transaction(async (tx) => {
      for (const entry of entries) {
        const updated = await tx
          .update(workOrderInstructions)
          .set({ orderIndex: entry.orderIndex })
          .where(
            and(
              eq(workOrderInstructions.id, entry.id),
              eq(workOrderInstructions.workOrderId, workOrderId),
            ),
          )
          .returning({ id: workOrderInstructions.id })
        if (updated.length === 0) {
          throw new NotFoundError('Work Order Instruction', entry.id)
        }
      }
    })
    return this.list(workOrderId)
  }

  static async updateRequiredCount(
    workOrderId: string,
    lineId: string,
    requiredCount: number,
  ) {
    await this.getLineRow(workOrderId, lineId)
    await db
      .update(workOrderInstructions)
      .set({ requiredCount })
      .where(eq(workOrderInstructions.id, lineId))
    return this.get(workOrderId, lineId)
  }

  /**
   * Mark a line not-applicable. The audited escape hatch from the work
   * order completion gate — allowed until the line is complete.
   */
  static async skip(
    workOrderId: string,
    lineId: string,
    userId: string,
    reason: string,
  ) {
    if (!reason.trim()) {
      throw new ValidationError('A reason is required to skip a traveler line')
    }
    const line = await this.getLineRow(workOrderId, lineId)
    if (line.skippedAt) {
      throw new ValidationError('Line is already skipped')
    }
    const tally = (await this.tallies([lineId])).get(lineId)
    if (tally && tally.completedCount >= line.requiredCount) {
      throw new ValidationError('A completed line cannot be skipped')
    }
    await db
      .update(workOrderInstructions)
      .set({ skippedAt: new Date(), skippedBy: userId, skipReason: reason })
      .where(eq(workOrderInstructions.id, lineId))
    return this.get(workOrderId, lineId)
  }

  static async unskip(workOrderId: string, lineId: string) {
    const line = await this.getLineRow(workOrderId, lineId)
    if (!line.skippedAt) {
      throw new ValidationError('Line is not skipped')
    }
    await db
      .update(workOrderInstructions)
      .set({ skippedAt: null, skippedBy: null, skipReason: null })
      .where(eq(workOrderInstructions.id, lineId))
    return this.get(workOrderId, lineId)
  }

  /**
   * Re-freeze the line from its template. Only while nothing has been
   * executed — captured step data references the snapshot's block ids,
   * so a line with history is a record, not a plan.
   */
  static async refreshSnapshot(workOrderId: string, lineId: string) {
    const line = await this.getLineRow(workOrderId, lineId)
    if (!line.workInstructionId) {
      throw new ValidationError(
        'The template this line was created from no longer exists',
      )
    }
    const tally = (await this.tallies([lineId])).get(lineId)
    if (tally && tally.executionCount > 0) {
      throw new ValidationError(
        'Line has recorded executions — its snapshot is frozen',
      )
    }

    const templateId = line.workInstructionId
    await db.transaction(async (tx) => {
      const { snapshot, title, instructionNumber, instructionRevision } =
        await this.buildSnapshot(tx, templateId)
      await tx
        .update(workOrderInstructions)
        .set({
          snapshot,
          snapshotAt: new Date(),
          title,
          instructionNumber,
          instructionRevision,
        })
        .where(eq(workOrderInstructions.id, lineId))
    })
    return this.get(workOrderId, lineId)
  }

  /** Remove an unexecuted line. Lines with history are skipped, not erased. */
  static async remove(workOrderId: string, lineId: string) {
    await this.getLineRow(workOrderId, lineId)
    const tally = (await this.tallies([lineId])).get(lineId)
    if (tally && tally.executionCount > 0) {
      throw new ValidationError(
        'Line has recorded executions and cannot be removed — skip it instead',
      )
    }
    await db
      .delete(workOrderInstructions)
      .where(eq(workOrderInstructions.id, lineId))
  }

  /**
   * The work order completion gate: every non-skipped line must have
   * reached its requiredCount. Throws with the open line titles.
   *
   * Called from LifecycleService.transitionFreeItem, the one write path for
   * Free-lifecycle state, so every door into a `finalKind: 'complete'` state
   * passes through it — not from WorkOrderService.updateStatus, which
   * is only one of those doors.
   */
  static async assertReadyForCompletion(workOrderId: string) {
    const lines = await this.list(workOrderId)
    const open = lines.filter(
      (line) => line.status !== 'Complete' && line.status !== 'Skipped',
    )
    if (open.length > 0) {
      const names = open
        .slice(0, 5)
        .map((line) => `"${line.title}"`)
        .join(', ')
      const more = open.length > 5 ? ` (+${open.length - 5} more)` : ''
      throw new ValidationError(
        `Cannot complete: ${open.length} traveler line${open.length === 1 ? ' is' : 's are'} not done — ${names}${more}. Complete or skip them first.`,
      )
    }
  }

  /** Author-side usage: where a template is instantiated, with progress. */
  static async listByTemplate(workInstructionId: string) {
    const rows = await db
      .select({
        line: workOrderInstructions,
        woNumber: items.itemNumber,
        woState: items.state,
      })
      .from(workOrderInstructions)
      .innerJoin(items, eq(workOrderInstructions.workOrderId, items.id))
      .where(eq(workOrderInstructions.workInstructionId, workInstructionId))
      .orderBy(desc(workOrderInstructions.createdAt))

    const tallyMap = await this.tallies(rows.map((row) => row.line.id))
    return rows.map((row) => {
      const tally = tallyMap.get(row.line.id) ?? {
        executionCount: 0,
        completedCount: 0,
      }
      return {
        id: row.line.id,
        workOrderId: row.line.workOrderId,
        workOrderNumber: row.woNumber,
        workOrderState: row.woState,
        partId: row.line.partId,
        title: row.line.title,
        snapshotAt: row.line.snapshotAt,
        requiredCount: row.line.requiredCount,
        status: deriveStatus(row.line, tally),
        completedCount: tally.completedCount,
        executionCount: tally.executionCount,
        createdAt: row.line.createdAt,
      }
    })
  }
}
