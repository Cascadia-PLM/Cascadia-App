// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { workOrders } from '@/lib/db/schema'

const toDate = (v: unknown): Date | null =>
  v ? (v instanceof Date ? v : new Date(String(v))) : null

registerTypeHandler('WorkOrder', {
  table: workOrders,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(workOrders).values({
      itemId,
      partId: data.partId || null,
      quantity: data.quantity ?? 1,
      quantityCompleted: data.quantityCompleted ?? 0,
      priority: data.priority || 'Normal',
      dueDate: toDate(data.dueDate),
      customerOrder: data.customerOrder || null,
      assignedTo: data.assignedTo ?? [],
      programId: data.programId || null,
      requiresSignOff: data.requiresSignOff ?? false,
      completedAt: toDate(data.completedAt),
      notes: data.notes || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [workOrder] = await run
      .select()
      .from(workOrders)
      .where(eq(workOrders.itemId, itemId))
      .limit(1)
    return workOrder
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.partId !== undefined) updateData.partId = data.partId || null
    if (data.quantity !== undefined) updateData.quantity = data.quantity
    if (data.quantityCompleted !== undefined)
      updateData.quantityCompleted = data.quantityCompleted
    if (data.priority !== undefined)
      updateData.priority = data.priority || 'Normal'
    if (data.dueDate !== undefined) updateData.dueDate = toDate(data.dueDate)
    if (data.customerOrder !== undefined)
      updateData.customerOrder = data.customerOrder || null
    if (data.assignedTo !== undefined) updateData.assignedTo = data.assignedTo
    if (data.programId !== undefined)
      updateData.programId = data.programId || null
    if (data.requiresSignOff !== undefined)
      updateData.requiresSignOff = data.requiresSignOff
    if (data.completedAt !== undefined)
      updateData.completedAt = toDate(data.completedAt)
    if (data.notes !== undefined) updateData.notes = data.notes || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(workOrders)
        .set(updateData)
        .where(eq(workOrders.itemId, itemId))
    }
  },
})
