import { and, count, desc, eq, sql } from 'drizzle-orm'
import type { ExecutionStatus } from '@/lib/items/types/work-instruction'
import { db } from '@/lib/db'
import {
  executionSignOffs,
  items,
  users,
  workInstructionExecutions,
  workOrders,
} from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'

export class WorkInstructionExecutionService {
  static async start(wiId: string, userId: string, workOrderId?: string) {
    // Snapshot the current revision
    const wiResult = await db
      .select({ revision: items.revision })
      .from(items)
      .where(eq(items.id, wiId))

    const revision = wiResult[0]?.revision || 'A'

    const [execution] = await db
      .insert(workInstructionExecutions)
      .values({
        workInstructionId: wiId,
        workInstructionRevision: revision,
        workOrderId: workOrderId || null,
        executedBy: userId,
        status: 'In Progress',
        stepData: {},
        currentStepIndex: 0,
      })
      .returning()

    return execution
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
      .update(workInstructionExecutions)
      .set({
        stepData: sql`COALESCE(${workInstructionExecutions.stepData}, '{}'::jsonb) || ${JSON.stringify({ [blockId]: stepEntry })}::jsonb`,
      })
      .where(eq(workInstructionExecutions.id, executionId))
      .returning()

    if (!updated) {
      throw new NotFoundError('Execution', executionId)
    }

    return updated
  }

  static async updateProgress(executionId: string, stepIndex: number) {
    const [updated] = await db
      .update(workInstructionExecutions)
      .set({ currentStepIndex: stepIndex })
      .where(eq(workInstructionExecutions.id, executionId))
      .returning()

    if (!updated) {
      throw new NotFoundError('Execution', executionId)
    }

    return updated
  }

  static async complete(executionId: string, _userId: string, notes?: string) {
    const existing = await db
      .select()
      .from(workInstructionExecutions)
      .where(eq(workInstructionExecutions.id, executionId))

    if (existing.length === 0) {
      throw new NotFoundError('Execution', executionId)
    }

    const execution = existing[0]
    if (execution.status !== 'In Progress') {
      throw new ValidationError(
        `Cannot complete execution in "${execution.status}" status`,
      )
    }

    const completedAt = new Date()
    const duration = Math.round(
      (completedAt.getTime() - new Date(execution.startedAt).getTime()) / 1000,
    )

    // Check if work order requires sign-off
    let newStatus: ExecutionStatus = 'Complete'
    if (execution.workOrderId) {
      const woResult = await db
        .select()
        .from(workOrders)
        .where(eq(workOrders.id, execution.workOrderId))

      const wo = woResult[0]
      if (wo && wo.requiresSignOff) {
        newStatus = 'Pending Approval'
      }
    }

    const [updated] = await db
      .update(workInstructionExecutions)
      .set({
        status: newStatus,
        completedAt,
        duration,
        notes: notes || execution.notes,
      })
      .where(eq(workInstructionExecutions.id, executionId))
      .returning()

    return updated
  }

  static async markIncomplete(executionId: string, _userId: string) {
    const existing = await db
      .select()
      .from(workInstructionExecutions)
      .where(eq(workInstructionExecutions.id, executionId))

    if (existing.length === 0) {
      throw new NotFoundError('Execution', executionId)
    }

    const execution = existing[0]
    const completedAt = new Date()
    const duration = Math.round(
      (completedAt.getTime() - new Date(execution.startedAt).getTime()) / 1000,
    )

    const [updated] = await db
      .update(workInstructionExecutions)
      .set({
        status: 'Incomplete',
        completedAt,
        duration,
      })
      .where(eq(workInstructionExecutions.id, executionId))
      .returning()

    return updated
  }

  static async findById(id: string) {
    const results = await db
      .select({
        execution: workInstructionExecutions,
        executorName: users.name,
        executorEmail: users.email,
        woNumber: workOrders.workOrderNumber,
      })
      .from(workInstructionExecutions)
      .leftJoin(users, eq(workInstructionExecutions.executedBy, users.id))
      .leftJoin(
        workOrders,
        eq(workInstructionExecutions.workOrderId, workOrders.id),
      )
      .where(eq(workInstructionExecutions.id, id))

    if (results.length === 0) return null

    const row = results[0]
    return {
      ...row.execution,
      executor: {
        id: row.execution.executedBy,
        name: row.executorName || '',
        email: row.executorEmail || '',
      },
      workOrder: row.woNumber
        ? {
            id: row.execution.workOrderId!,
            workOrderNumber: row.woNumber,
          }
        : null,
    }
  }

  static async listByWorkInstruction(
    wiId: string,
    criteria?: { limit?: number; offset?: number },
  ) {
    const limit = criteria?.limit ?? 50
    const offset = criteria?.offset ?? 0

    const [results, totalResult] = await Promise.all([
      db
        .select({
          execution: workInstructionExecutions,
          executorName: users.name,
          executorEmail: users.email,
          woNumber: workOrders.workOrderNumber,
        })
        .from(workInstructionExecutions)
        .leftJoin(users, eq(workInstructionExecutions.executedBy, users.id))
        .leftJoin(
          workOrders,
          eq(workInstructionExecutions.workOrderId, workOrders.id),
        )
        .where(eq(workInstructionExecutions.workInstructionId, wiId))
        .orderBy(desc(workInstructionExecutions.startedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(workInstructionExecutions)
        .where(eq(workInstructionExecutions.workInstructionId, wiId)),
    ])

    return {
      executions: results.map((row) => ({
        ...row.execution,
        executor: {
          id: row.execution.executedBy,
          name: row.executorName || '',
          email: row.executorEmail || '',
        },
        workOrder: row.woNumber
          ? {
              id: row.execution.workOrderId!,
              workOrderNumber: row.woNumber,
            }
          : null,
      })),
      total: totalResult[0]?.count ?? 0,
    }
  }

  static async listByWorkOrder(
    woId: string,
    criteria?: { limit?: number; offset?: number },
  ) {
    const limit = criteria?.limit ?? 50
    const offset = criteria?.offset ?? 0

    const [results, totalResult] = await Promise.all([
      db
        .select({
          execution: workInstructionExecutions,
          executorName: users.name,
          executorEmail: users.email,
          wiItemNumber: items.itemNumber,
          wiName: items.name,
        })
        .from(workInstructionExecutions)
        .leftJoin(users, eq(workInstructionExecutions.executedBy, users.id))
        .leftJoin(
          items,
          eq(workInstructionExecutions.workInstructionId, items.id),
        )
        .where(eq(workInstructionExecutions.workOrderId, woId))
        .orderBy(desc(workInstructionExecutions.startedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(workInstructionExecutions)
        .where(eq(workInstructionExecutions.workOrderId, woId)),
    ])

    return {
      executions: results.map((row) => ({
        ...row.execution,
        executor: {
          id: row.execution.executedBy,
          name: row.executorName || '',
          email: row.executorEmail || '',
        },
        workInstruction: row.wiItemNumber
          ? {
              id: row.execution.workInstructionId,
              itemNumber: row.wiItemNumber,
              name: row.wiName,
            }
          : null,
      })),
      total: totalResult[0]?.count ?? 0,
    }
  }

  static async findInProgress(
    wiId: string,
    userId: string,
    workOrderId?: string,
  ) {
    const conditions = [
      eq(workInstructionExecutions.workInstructionId, wiId),
      eq(workInstructionExecutions.executedBy, userId),
      eq(workInstructionExecutions.status, 'In Progress'),
    ]

    if (workOrderId) {
      conditions.push(eq(workInstructionExecutions.workOrderId, workOrderId))
    }

    const results = await db
      .select()
      .from(workInstructionExecutions)
      .where(and(...conditions))
      .orderBy(desc(workInstructionExecutions.startedAt))
      .limit(1)

    return results[0] || null
  }

  static async submitSignOff(
    executionId: string,
    reviewerId: string,
    decision: 'approved' | 'rejected',
    comments?: string,
  ) {
    const existing = await db
      .select()
      .from(workInstructionExecutions)
      .where(eq(workInstructionExecutions.id, executionId))

    if (existing.length === 0) {
      throw new NotFoundError('Execution', executionId)
    }

    const execution = existing[0]
    if (execution.status !== 'Pending Approval') {
      throw new ValidationError(
        `Cannot sign off on execution in "${execution.status}" status`,
      )
    }

    // Insert sign-off record
    await db.insert(executionSignOffs).values({
      executionId,
      reviewerId,
      decision,
      comments: comments || null,
    })

    // Update execution status
    const newStatus = decision === 'approved' ? 'Approved' : 'Rejected'
    const [updated] = await db
      .update(workInstructionExecutions)
      .set({ status: newStatus })
      .where(eq(workInstructionExecutions.id, executionId))
      .returning()

    // If approved and has a work order, increment quantityCompleted
    if (decision === 'approved' && execution.workOrderId) {
      const woResult = await db
        .select()
        .from(workOrders)
        .where(eq(workOrders.id, execution.workOrderId))

      if (woResult.length > 0) {
        const wo = woResult[0]
        await db
          .update(workOrders)
          .set({
            quantityCompleted: wo.quantityCompleted + 1,
          })
          .where(eq(workOrders.id, execution.workOrderId))
      }
    }

    return updated
  }

  /**
   * Resubmit a rejected execution for approval.
   * Only the original executor may resubmit.
   */
  static async resubmitForApproval(executionId: string, userId: string) {
    const existing = await db
      .select()
      .from(workInstructionExecutions)
      .where(eq(workInstructionExecutions.id, executionId))

    if (existing.length === 0) {
      throw new NotFoundError('Execution', executionId)
    }

    const execution = existing[0]
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
      .update(workInstructionExecutions)
      .set({ status: 'Pending Approval' })
      .where(eq(workInstructionExecutions.id, executionId))
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
}
