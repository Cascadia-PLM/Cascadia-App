import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { requirements } from '@/lib/db/schema'

registerTypeHandler('Requirement', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(requirements).values({
      itemId,
      description: data.description || null,
      type: data.type || null,
      priority: data.priority || null,
      status: data.status || null,
      acceptanceCriteria: data.acceptanceCriteria || null,
      source: data.source || null,
      category: data.category || null,
      verificationMethod: data.verificationMethod || null,
      verificationStatus: data.verificationStatus || null,
      allocatedDesignId: data.allocatedDesignId || null,
      parentRequirementId: data.parentRequirementId || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [requirement] = await run
      .select()
      .from(requirements)
      .where(eq(requirements.itemId, itemId))
      .limit(1)
    return requirement
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.description !== undefined)
      updateData.description = data.description || null
    if (data.type !== undefined) updateData.type = data.type || null
    if (data.priority !== undefined) updateData.priority = data.priority || null
    if (data.status !== undefined) updateData.status = data.status || null
    if (data.acceptanceCriteria !== undefined)
      updateData.acceptanceCriteria = data.acceptanceCriteria || null
    if (data.source !== undefined) updateData.source = data.source || null
    if (data.category !== undefined) updateData.category = data.category || null
    if (data.verificationMethod !== undefined)
      updateData.verificationMethod = data.verificationMethod || null
    if (data.verificationStatus !== undefined)
      updateData.verificationStatus = data.verificationStatus || null
    if (data.allocatedDesignId !== undefined)
      updateData.allocatedDesignId = data.allocatedDesignId || null
    if (data.parentRequirementId !== undefined)
      updateData.parentRequirementId = data.parentRequirementId || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(requirements)
        .set(updateData)
        .where(eq(requirements.itemId, itemId))
    }
  },
})
