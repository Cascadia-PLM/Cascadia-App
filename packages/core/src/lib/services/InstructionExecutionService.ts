// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { LifecycleService } from './LifecycleService'
import type { ExecutionStatus } from '@/lib/items/types/work-order'
import { db } from '@/lib/db'
import {
  executionSignOffs,
  instructionExecutions,
  items,
  users,
  workOrderInstructions,
  workOrders,
} from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import {
  asPostgresError,
  constraintOf,
  isUniqueViolation,
} from '@/lib/errors/pg'
import { takeFirst } from '@/lib/db/take-first'

/**
 * Runs of traveler lines (work order instructions). An execution always
 * belongs to a line — there are no standalone executions; performing a
 * procedure outside an order means creating an order for it.
 * See docs/features/work-order-traveler.md.
 */

/** Line joined with its order — the context every run needs. */
async function getLineContext(lineId: string) {
  const row = (
    await db
      .select({
        line: workOrderInstructions,
        woItem: items,
        workOrder: workOrders,
      })
      .from(workOrderInstructions)
      .innerJoin(
        workOrders,
        eq(workOrderInstructions.workOrderId, workOrders.itemId),
      )
      .innerJoin(items, eq(workOrders.itemId, items.id))
      .where(eq(workOrderInstructions.id, lineId))
      .limit(1)
  )[0]
  if (!row) throw new NotFoundError('Work Order Instruction', lineId)
  return row
}

async function getExecution(executionId: string) {
  const execution = (
    await db
      .select()
      .from(instructionExecutions)
      .where(eq(instructionExecutions.id, executionId))
      .limit(1)
  )[0]
  if (!execution) throw new NotFoundError('Execution', executionId)
  return execution
}

const executorShape = (
  executedBy: string,
  name: string | null,
  email: string | null,
) => ({
  id: executedBy,
  name: name || '',
  email: email || '',
})

export class InstructionExecutionService {
  /**
   * Start (or resume) a run of a traveler line. Rejects skipped lines and
   * finished orders; starting work on a Not Started order moves it to
   * In Progress — execution is what starts an order, not a status click.
   */
  static async start(
    lineId: string,
    userId: string,
    unitLabel?: string,
  ): Promise<{
    execution: typeof instructionExecutions.$inferSelect
    resumed: boolean
  }> {
    const { line, woItem } = await getLineContext(lineId)

    if (line.skippedAt) {
      throw new ValidationError(
        `"${line.title}" is skipped${line.skipReason ? ` (${line.skipReason})` : ''} — unskip it to record work`,
      )
    }
    // A flow that has ended (any final state, whatever its name or kind)
    // records no new work
    if (
      (await LifecycleService.getFinalStateIds('WorkOrder')).includes(
        woItem.state,
      )
    ) {
      throw new ValidationError(
        `Work order ${woItem.itemNumber} is ${woItem.state} — it cannot record new executions`,
      )
    }

    // Resume the technician's own open run of this line rather than
    // stacking a duplicate.
    const resumeConditions = [
      eq(instructionExecutions.workOrderInstructionId, lineId),
      eq(instructionExecutions.executedBy, userId),
      eq(instructionExecutions.status, 'In Progress'),
    ]
    if (unitLabel) {
      resumeConditions.push(eq(instructionExecutions.unitLabel, unitLabel))
    }
    const inProgress = (
      await db
        .select()
        .from(instructionExecutions)
        .where(and(...resumeConditions))
        .orderBy(desc(instructionExecutions.startedAt))
        .limit(1)
    )[0]
    if (inProgress) {
      return { execution: inProgress, resumed: true }
    }

    // First execution moves the work order out of its initial state — along
    // the initial state's unique transition to a non-final state. A custom
    // lifecycle with zero or several such transitions gets no auto-start;
    // the execution still records and the state moves manually.
    if (await LifecycleService.isInitialState('WorkOrder', woItem.state)) {
      const autoStartTarget = await this.resolveAutoStartTarget(woItem.state)
      if (autoStartTarget) {
        await LifecycleService.transitionFreeItem(
          woItem.id,
          autoStartTarget,
          userId,
        )
      }
    }

    try {
      const execution = takeFirst(
        await db
          .insert(instructionExecutions)
          .values({
            workOrderInstructionId: lineId,
            executedBy: userId,
            unitLabel: unitLabel || null,
            status: 'In Progress',
            stepData: {},
            currentStepIndex: 0,
          })
          .returning(),
      )
      return { execution, resumed: false }
    } catch (error) {
      // The resume SELECT above is a fast path, not a guarantee: two requests
      // can both read "no open run" and both insert. `uq_instr_exec_open_run`
      // makes the loser fail rather than open a second run that the traveler's
      // countable tally would count twice toward the work-order completion
      // gate. Re-read and hand back the winner, so a race is indistinguishable
      // from a resume — the PhysicalPartService.register shape.
      //
      // Catch-and-reselect rather than ON CONFLICT: the index is partial, and
      // this does not depend on drizzle's `targetWhere` support.
      const pgError = asPostgresError(error)
      const isOpenRunConflict =
        isUniqueViolation(error) &&
        pgError !== null &&
        constraintOf(pgError) === 'uq_instr_exec_open_run'
      if (!isOpenRunConflict) throw error

      const winner = (
        await db
          .select()
          .from(instructionExecutions)
          .where(
            and(
              eq(instructionExecutions.workOrderInstructionId, lineId),
              eq(instructionExecutions.executedBy, userId),
              eq(instructionExecutions.status, 'In Progress'),
              // Exactly the row the index collided on, so a labelled run is
              // never handed back for an unlabelled start.
              unitLabel
                ? eq(instructionExecutions.unitLabel, unitLabel)
                : isNull(instructionExecutions.unitLabel),
            ),
          )
          .limit(1)
      )[0]
      if (winner) return { execution: winner, resumed: true }
      throw error
    }
  }

  static async updateStepData(
    executionId: string,
    blockId: string,
    value: unknown,
  ) {
    const stepEntry = {
      value,
      capturedAt: new Date().toISOString(),
      blockId,
    }

    const [updated] = await db
      .update(instructionExecutions)
      .set({
        stepData: sql`COALESCE(${instructionExecutions.stepData}, '{}'::jsonb) || ${JSON.stringify({ [blockId]: stepEntry })}::jsonb`,
      })
      .where(eq(instructionExecutions.id, executionId))
      .returning()

    if (!updated) {
      throw new NotFoundError('Execution', executionId)
    }
    return updated
  }

  static async updateProgress(executionId: string, stepIndex: number) {
    const [updated] = await db
      .update(instructionExecutions)
      .set({ currentStepIndex: stepIndex })
      .where(eq(instructionExecutions.id, executionId))
      .returning()

    if (!updated) {
      throw new NotFoundError('Execution', executionId)
    }
    return updated
  }

  /**
   * Finish a run. Routes to Pending Approval when the order requires
   * sign-off, else Complete.
   */
  static async complete(executionId: string, _userId: string, notes?: string) {
    const execution = await getExecution(executionId)
    if (execution.status !== 'In Progress') {
      throw new ValidationError(
        `Cannot complete execution in "${execution.status}" status`,
      )
    }

    const { workOrder } = await getLineContext(execution.workOrderInstructionId)

    const completedAt = new Date()
    const duration = Math.round(
      (completedAt.getTime() - new Date(execution.startedAt).getTime()) / 1000,
    )
    const newStatus: ExecutionStatus = workOrder.requiresSignOff
      ? 'Pending Approval'
      : 'Complete'

    const [updated] = await db
      .update(instructionExecutions)
      .set({
        status: newStatus,
        completedAt,
        duration,
        notes: notes || execution.notes,
      })
      .where(eq(instructionExecutions.id, executionId))
      .returning()

    return updated
  }

  /** Abandon an open run — it stays as an Incomplete record. */
  static async abandon(executionId: string, _userId: string, notes?: string) {
    const execution = await getExecution(executionId)
    if (execution.status !== 'In Progress') {
      throw new ValidationError(
        `Cannot abandon execution in "${execution.status}" status`,
      )
    }

    const completedAt = new Date()
    const duration = Math.round(
      (completedAt.getTime() - new Date(execution.startedAt).getTime()) / 1000,
    )

    const [updated] = await db
      .update(instructionExecutions)
      .set({
        status: 'Incomplete',
        completedAt,
        duration,
        notes: notes || execution.notes,
      })
      .where(eq(instructionExecutions.id, executionId))
      .returning()

    return updated
  }

  static async findById(id: string) {
    const row = (
      await db
        .select({
          execution: instructionExecutions,
          executorName: users.name,
          executorEmail: users.email,
          line: workOrderInstructions,
          woNumber: items.itemNumber,
        })
        .from(instructionExecutions)
        .leftJoin(users, eq(instructionExecutions.executedBy, users.id))
        .innerJoin(
          workOrderInstructions,
          eq(
            instructionExecutions.workOrderInstructionId,
            workOrderInstructions.id,
          ),
        )
        .innerJoin(items, eq(workOrderInstructions.workOrderId, items.id))
        .where(eq(instructionExecutions.id, id))
        .limit(1)
    )[0]
    if (!row) return null

    return {
      ...row.execution,
      executor: executorShape(
        row.execution.executedBy,
        row.executorName,
        row.executorEmail,
      ),
      instruction: {
        id: row.line.id,
        title: row.line.title,
        workOrderId: row.line.workOrderId,
      },
      workOrder: {
        id: row.line.workOrderId,
        workOrderNumber: row.woNumber,
      },
    }
  }

  static async listByLine(
    lineId: string,
    criteria?: { limit?: number; offset?: number },
  ) {
    const limit = criteria?.limit ?? 50
    const offset = criteria?.offset ?? 0

    const [results, totalResult] = await Promise.all([
      db
        .select({
          execution: instructionExecutions,
          executorName: users.name,
          executorEmail: users.email,
        })
        .from(instructionExecutions)
        .leftJoin(users, eq(instructionExecutions.executedBy, users.id))
        .where(eq(instructionExecutions.workOrderInstructionId, lineId))
        .orderBy(desc(instructionExecutions.startedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(instructionExecutions)
        .where(eq(instructionExecutions.workOrderInstructionId, lineId)),
    ])

    return {
      executions: results.map((row) => ({
        ...row.execution,
        executor: executorShape(
          row.execution.executedBy,
          row.executorName,
          row.executorEmail,
        ),
      })),
      total: totalResult[0]?.count ?? 0,
    }
  }

  /** Every run for an order, across all traveler lines. */
  static async listByWorkOrder(
    workOrderId: string,
    criteria?: { limit?: number; offset?: number },
  ) {
    const limit = criteria?.limit ?? 50
    const offset = criteria?.offset ?? 0

    const whereClause = eq(workOrderInstructions.workOrderId, workOrderId)

    const [results, totalResult] = await Promise.all([
      db
        .select({
          execution: instructionExecutions,
          executorName: users.name,
          executorEmail: users.email,
          line: workOrderInstructions,
        })
        .from(instructionExecutions)
        .leftJoin(users, eq(instructionExecutions.executedBy, users.id))
        .innerJoin(
          workOrderInstructions,
          eq(
            instructionExecutions.workOrderInstructionId,
            workOrderInstructions.id,
          ),
        )
        .where(whereClause)
        .orderBy(desc(instructionExecutions.startedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(instructionExecutions)
        .innerJoin(
          workOrderInstructions,
          eq(
            instructionExecutions.workOrderInstructionId,
            workOrderInstructions.id,
          ),
        )
        .where(whereClause),
    ])

    return {
      executions: results.map((row) => ({
        ...row.execution,
        executor: executorShape(
          row.execution.executedBy,
          row.executorName,
          row.executorEmail,
        ),
        instruction: {
          id: row.line.id,
          title: row.line.title,
          workOrderId: row.line.workOrderId,
        },
      })),
      total: totalResult[0]?.count ?? 0,
    }
  }

  /**
   * Scope check for the flat execution routes: the execution must belong
   * to the given work order.
   */
  static async findByIdForWorkOrder(executionId: string, workOrderId: string) {
    const execution = await this.findById(executionId)
    if (!execution || execution.instruction.workOrderId !== workOrderId) {
      throw new NotFoundError('Execution', executionId)
    }
    return execution
  }

  static async submitSignOff(
    executionId: string,
    reviewerId: string,
    decision: 'approved' | 'rejected',
    comments?: string,
  ) {
    const execution = await getExecution(executionId)
    if (execution.status !== 'Pending Approval') {
      throw new ValidationError(
        `Cannot sign off on execution in "${execution.status}" status`,
      )
    }

    const newStatus = decision === 'approved' ? 'Approved' : 'Rejected'
    return db.transaction(async (tx) => {
      await tx.insert(executionSignOffs).values({
        executionId,
        reviewerId,
        decision,
        comments: comments || null,
      })
      return takeFirst(
        await tx
          .update(instructionExecutions)
          .set({ status: newStatus })
          .where(eq(instructionExecutions.id, executionId))
          .returning(),
      )
    })
  }

  /**
   * Resubmit a rejected execution for approval.
   * Only the original executor may resubmit.
   */
  static async resubmitForApproval(executionId: string, userId: string) {
    const execution = await getExecution(executionId)
    if (execution.status !== 'Rejected') {
      throw new ValidationError(
        `Cannot resubmit execution in "${execution.status}" status. Must be "Rejected".`,
      )
    }
    if (execution.executedBy !== userId) {
      throw new ValidationError(
        'Only the original executor can resubmit for approval',
      )
    }

    const [updated] = await db
      .update(instructionExecutions)
      .set({ status: 'Pending Approval' })
      .where(eq(instructionExecutions.id, executionId))
      .returning()

    return updated
  }

  static async getSignOff(executionId: string) {
    const results = await db
      .select({
        signOff: executionSignOffs,
        reviewerName: users.name,
        reviewerEmail: users.email,
      })
      .from(executionSignOffs)
      .leftJoin(users, eq(executionSignOffs.reviewerId, users.id))
      .where(eq(executionSignOffs.executionId, executionId))
      .orderBy(desc(executionSignOffs.reviewedAt))

    return results.map((row) => ({
      ...row.signOff,
      reviewer: {
        id: row.signOff.reviewerId,
        name: row.reviewerName || '',
        email: row.reviewerEmail || '',
      },
    }))
  }
  /**
   * The auto-start target: the initial state's single outgoing transition to
   * a non-final state, or null when the lifecycle offers zero or several —
   * ambiguity is configuration's call, not this service's.
   */
  private static async resolveAutoStartTarget(
    fromState: string,
  ): Promise<string | null> {
    const lifecycle =
      await LifecycleService.getLifecycleForItemType('WorkOrder')
    if (!lifecycle) return null
    const finals = new Set(
      lifecycle.states.filter((st) => st.isFinal).map((st) => st.id),
    )
    const candidates = (lifecycle.transitions ?? []).filter(
      (t) => t.fromStateId === fromState && !finals.has(t.toStateId),
    )
    return candidates.length === 1 ? (candidates[0]?.toStateId ?? null) : null
  }
}
