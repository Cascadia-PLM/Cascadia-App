import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { changeOrders } from '@/lib/db/schema'

registerTypeHandler('ChangeOrder', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(changeOrders).values({
      itemId,
      changeType: data.changeType,
      priority: data.priority || 'medium',
      reasonForChange: data.reasonForChange || null,
      impactDescription: data.impactDescription || null,
      implementationDate: data.implementationDate || null,
      submittedAt: data.submittedAt || null,
      approvedAt: data.approvedAt || null,
      approvedBy: data.approvedBy || null,
      implementedAt: data.implementedAt || null,
      closedAt: data.closedAt || null,
      impactAssessmentStatus: data.impactAssessmentStatus || 'pending',
      riskLevel: data.riskLevel || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [co] = await run
      .select()
      .from(changeOrders)
      .where(eq(changeOrders.itemId, itemId))
      .limit(1)
    return co
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.changeType !== undefined) updateData.changeType = data.changeType
    if (data.priority !== undefined)
      updateData.priority = data.priority || 'medium'
    if (data.reasonForChange !== undefined)
      updateData.reasonForChange = data.reasonForChange || null
    if (data.impactDescription !== undefined)
      updateData.impactDescription = data.impactDescription || null
    if (data.implementationDate !== undefined)
      updateData.implementationDate = data.implementationDate || null
    if (data.submittedAt !== undefined)
      updateData.submittedAt = data.submittedAt || null
    if (data.approvedAt !== undefined)
      updateData.approvedAt = data.approvedAt || null
    if (data.approvedBy !== undefined)
      updateData.approvedBy = data.approvedBy || null
    if (data.implementedAt !== undefined)
      updateData.implementedAt = data.implementedAt || null
    if (data.closedAt !== undefined) updateData.closedAt = data.closedAt || null
    if (data.impactAssessmentStatus !== undefined)
      updateData.impactAssessmentStatus =
        data.impactAssessmentStatus || 'pending'
    if (data.riskLevel !== undefined)
      updateData.riskLevel = data.riskLevel || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(changeOrders)
        .set(updateData)
        .where(eq(changeOrders.itemId, itemId))
    }
  },
})
