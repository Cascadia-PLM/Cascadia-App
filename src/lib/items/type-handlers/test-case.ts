import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { testCases } from '@/lib/db/schema'

registerTypeHandler('TestCase', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(testCases).values({
      itemId,
      testPlanId: data.testPlanId || null,
      testType: data.testType || null,
      preconditions: data.preconditions || null,
      steps: data.steps || null,
      executionStatus: data.executionStatus || null,
      lastExecutedAt: data.lastExecutedAt || null,
      lastExecutedBy: data.lastExecutedBy || null,
      environment: data.environment || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [tc] = await run
      .select()
      .from(testCases)
      .where(eq(testCases.itemId, itemId))
      .limit(1)
    return tc
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.testPlanId !== undefined)
      updateData.testPlanId = data.testPlanId || null
    if (data.testType !== undefined) updateData.testType = data.testType || null
    if (data.preconditions !== undefined)
      updateData.preconditions = data.preconditions || null
    if (data.steps !== undefined) updateData.steps = data.steps || null
    if (data.executionStatus !== undefined)
      updateData.executionStatus = data.executionStatus || null
    if (data.lastExecutedAt !== undefined)
      updateData.lastExecutedAt = data.lastExecutedAt || null
    if (data.lastExecutedBy !== undefined)
      updateData.lastExecutedBy = data.lastExecutedBy || null
    if (data.environment !== undefined)
      updateData.environment = data.environment || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(testCases)
        .set(updateData)
        .where(eq(testCases.itemId, itemId))
    }
  },
})
