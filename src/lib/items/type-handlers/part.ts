import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { parts } from '@/lib/db/schema'

registerTypeHandler('Part', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(parts).values({
      itemId,
      description: data.description || null,
      partType: data.partType || null,
      material: data.material || null,
      weight: data.weight && data.weight !== '' ? data.weight : null,
      weightUnit: data.weightUnit || null,
      cost: data.cost && data.cost !== '' ? data.cost : null,
      costCurrency: data.costCurrency || null,
      leadTimeDays:
        data.leadTimeDays && data.leadTimeDays !== ''
          ? data.leadTimeDays
          : null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [part] = await run
      .select()
      .from(parts)
      .where(eq(parts.itemId, itemId))
      .limit(1)
    return part
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.description !== undefined)
      updateData.description = data.description || null
    if (data.partType !== undefined) updateData.partType = data.partType || null
    if (data.material !== undefined) updateData.material = data.material || null
    if (data.weight !== undefined)
      updateData.weight = data.weight && data.weight !== '' ? data.weight : null
    if (data.weightUnit !== undefined)
      updateData.weightUnit = data.weightUnit || null
    if (data.cost !== undefined)
      updateData.cost = data.cost && data.cost !== '' ? data.cost : null
    if (data.costCurrency !== undefined)
      updateData.costCurrency = data.costCurrency || null
    if (data.leadTimeDays !== undefined)
      updateData.leadTimeDays =
        data.leadTimeDays && data.leadTimeDays !== '' ? data.leadTimeDays : null

    if (Object.keys(updateData).length > 0) {
      await run.update(parts).set(updateData).where(eq(parts.itemId, itemId))
    }
  },
})
