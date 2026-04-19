import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { tasks } from '@/lib/db/schema'

registerTypeHandler('Task', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(tasks).values({
      itemId,
      programId: data.programId || null,
      parentTaskId: data.parentTaskId || null,
      description: data.description || null,
      assignee: data.assignee || null,
      priority: data.priority || null,
      dueDate: data.dueDate || null,
      estimatedHours:
        data.estimatedHours && data.estimatedHours !== ''
          ? data.estimatedHours
          : null,
      actualHours:
        data.actualHours && data.actualHours !== '' ? data.actualHours : null,
      tags: data.tags || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [task] = await run
      .select()
      .from(tasks)
      .where(eq(tasks.itemId, itemId))
      .limit(1)
    return task
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.programId !== undefined)
      updateData.programId = data.programId || null
    if (data.parentTaskId !== undefined)
      updateData.parentTaskId = data.parentTaskId || null
    if (data.description !== undefined)
      updateData.description = data.description || null
    if (data.assignee !== undefined) updateData.assignee = data.assignee || null
    if (data.priority !== undefined) updateData.priority = data.priority || null
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate || null
    if (data.estimatedHours !== undefined)
      updateData.estimatedHours =
        data.estimatedHours && data.estimatedHours !== ''
          ? data.estimatedHours
          : null
    if (data.actualHours !== undefined)
      updateData.actualHours =
        data.actualHours && data.actualHours !== '' ? data.actualHours : null
    if (data.tags !== undefined) updateData.tags = data.tags || null

    if (Object.keys(updateData).length > 0) {
      await run.update(tasks).set(updateData).where(eq(tasks.itemId, itemId))
    }
  },
})
