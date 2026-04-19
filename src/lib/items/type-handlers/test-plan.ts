import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { testPlans } from '@/lib/db/schema'

registerTypeHandler('TestPlan', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(testPlans).values({
      itemId,
      scope: data.scope || null,
      environment: data.environment || null,
      entryCriteria: data.entryCriteria || null,
      exitCriteria: data.exitCriteria || null,
      status: data.status || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [tp] = await run
      .select()
      .from(testPlans)
      .where(eq(testPlans.itemId, itemId))
      .limit(1)
    return tp
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.scope !== undefined) updateData.scope = data.scope || null
    if (data.environment !== undefined)
      updateData.environment = data.environment || null
    if (data.entryCriteria !== undefined)
      updateData.entryCriteria = data.entryCriteria || null
    if (data.exitCriteria !== undefined)
      updateData.exitCriteria = data.exitCriteria || null
    if (data.status !== undefined) updateData.status = data.status || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(testPlans)
        .set(updateData)
        .where(eq(testPlans.itemId, itemId))
    }
  },
})
