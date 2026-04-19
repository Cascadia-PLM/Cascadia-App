import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { workInstructions } from '@/lib/db/schema'

registerTypeHandler('WorkInstruction', {
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
})
