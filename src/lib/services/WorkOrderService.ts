import { and, asc, count, desc, eq, ilike, or } from 'drizzle-orm'
import type {
  WorkOrderCreateInput,
  WorkOrderStatus,
  WorkOrderUpdateInput,
} from '@/lib/items/types/work-order'
import { db } from '@/lib/db'
import { items, workOrders } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'

export class WorkOrderService {
  static async create(data: WorkOrderCreateInput, userId: string) {
    const workOrderNumber = await this.generateNumber()

    const [workOrder] = await db
      .insert(workOrders)
      .values({
        workOrderNumber,
        partId: data.partId ?? null,
        quantity: data.quantity ?? 1,
        priority: data.priority ?? 'Normal',
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        customerOrder: data.customerOrder ?? null,
        notes: data.notes ?? null,
        assignedTo: data.assignedTo ?? [],
        programId: data.programId ?? null,
        requiresSignOff: data.requiresSignOff ?? false,
        createdBy: userId,
        modifiedBy: userId,
      })
      .returning()

    return workOrder
  }

  static async findById(id: string) {
    const results = await db
      .select({
        workOrder: workOrders,
        partItemNumber: items.itemNumber,
        partName: items.name,
        partRevision: items.revision,
      })
      .from(workOrders)
      .leftJoin(items, eq(workOrders.partId, items.id))
      .where(eq(workOrders.id, id))

    if (results.length === 0) return null

    const row = results[0]
    return {
      ...row.workOrder,
      part: row.partItemNumber
        ? {
            id: row.workOrder.partId!,
            itemNumber: row.partItemNumber,
            name: row.partName,
            revision: row.partRevision,
          }
        : null,
    }
  }

  static async update(id: string, data: WorkOrderUpdateInput, userId: string) {
    const existing = await db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))

    if (existing.length === 0) {
      throw new NotFoundError('Work Order', id)
    }

    const [updated] = await db
      .update(workOrders)
      .set({
        ...(data.partId !== undefined && { partId: data.partId }),
        ...(data.quantity !== undefined && { quantity: data.quantity }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.dueDate !== undefined && {
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
        }),
        ...(data.customerOrder !== undefined && {
          customerOrder: data.customerOrder,
        }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.assignedTo !== undefined && { assignedTo: data.assignedTo }),
        ...(data.programId !== undefined && { programId: data.programId }),
        ...(data.requiresSignOff !== undefined && {
          requiresSignOff: data.requiresSignOff,
        }),
        modifiedBy: userId,
        modifiedAt: new Date(),
      })
      .where(eq(workOrders.id, id))
      .returning()

    return updated
  }

  static async delete(id: string) {
    const existing = await db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))

    if (existing.length === 0) {
      throw new NotFoundError('Work Order', id)
    }

    await db.delete(workOrders).where(eq(workOrders.id, id))
  }

  static async search(criteria: {
    status?: string
    partId?: string
    search?: string
    programId?: string
    limit?: number
    offset?: number
    sortBy?: string
    sortDir?: 'asc' | 'desc'
  }) {
    const conditions = []

    if (criteria.status) {
      conditions.push(eq(workOrders.status, criteria.status))
    }
    if (criteria.partId) {
      conditions.push(eq(workOrders.partId, criteria.partId))
    }
    if (criteria.programId) {
      conditions.push(eq(workOrders.programId, criteria.programId))
    }
    if (criteria.search) {
      conditions.push(
        or(
          ilike(workOrders.workOrderNumber, `%${criteria.search}%`),
          ilike(workOrders.customerOrder, `%${criteria.search}%`),
        ),
      )
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const limit = criteria.limit ?? 50
    const offset = criteria.offset ?? 0

    const [results, totalResult] = await Promise.all([
      db
        .select({
          workOrder: workOrders,
          partItemNumber: items.itemNumber,
          partName: items.name,
          partRevision: items.revision,
        })
        .from(workOrders)
        .leftJoin(items, eq(workOrders.partId, items.id))
        .where(whereClause)
        .orderBy(
          criteria.sortBy === 'dueDate'
            ? criteria.sortDir === 'asc'
              ? asc(workOrders.dueDate)
              : desc(workOrders.dueDate)
            : criteria.sortBy === 'status'
              ? criteria.sortDir === 'asc'
                ? asc(workOrders.status)
                : desc(workOrders.status)
              : desc(workOrders.createdAt),
        )
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(workOrders).where(whereClause),
    ])

    return {
      workOrders: results.map((row) => ({
        ...row.workOrder,
        part: row.partItemNumber
          ? {
              id: row.workOrder.partId!,
              itemNumber: row.partItemNumber,
              name: row.partName,
              revision: row.partRevision,
            }
          : null,
      })),
      total: totalResult[0]?.count ?? 0,
    }
  }

  static async updateStatus(
    id: string,
    newStatus: WorkOrderStatus,
    userId: string,
  ) {
    const existing = await db
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))

    if (existing.length === 0) {
      throw new NotFoundError('Work Order', id)
    }

    const current = existing[0]
    const currentStatus = current.status as WorkOrderStatus

    // Validate transitions
    const validTransitions: Record<WorkOrderStatus, Array<WorkOrderStatus>> = {
      'Not Started': ['In Progress', 'Cancelled'],
      'In Progress': ['Complete', 'Cancelled'],
      Complete: [],
      Cancelled: [],
    }

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      throw new ValidationError(
        `Cannot transition from "${currentStatus}" to "${newStatus}"`,
      )
    }

    const updateData: Record<string, unknown> = {
      status: newStatus,
      modifiedBy: userId,
      modifiedAt: new Date(),
    }

    if (newStatus === 'Complete') {
      updateData.completedAt = new Date()
    }

    const [updated] = await db
      .update(workOrders)
      .set(updateData)
      .where(eq(workOrders.id, id))
      .returning()

    return updated
  }

  static async generateNumber(): Promise<string> {
    const result = await db.select({ count: count() }).from(workOrders)

    const nextNum = (result[0]?.count ?? 0) + 1
    return `WO-${String(nextNum).padStart(6, '0')}`
  }
}
