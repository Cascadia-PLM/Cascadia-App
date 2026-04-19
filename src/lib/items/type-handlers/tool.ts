import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { tools } from '@/lib/db/schema'

registerTypeHandler('Tool', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(tools).values({
      itemId,
      toolType: data.toolType || null,
      toolSubtype: data.toolSubtype || null,
      manufacturer: data.manufacturer || null,
      model: data.model || null,
      capabilities: data.capabilities || null,
      toolStatus: data.toolStatus || 'available',
      location: data.location || null,
      notes: data.notes || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [tool] = await run
      .select()
      .from(tools)
      .where(eq(tools.itemId, itemId))
      .limit(1)
    return tool
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.toolType !== undefined) updateData.toolType = data.toolType || null
    if (data.toolSubtype !== undefined)
      updateData.toolSubtype = data.toolSubtype || null
    if (data.manufacturer !== undefined)
      updateData.manufacturer = data.manufacturer || null
    if (data.model !== undefined) updateData.model = data.model || null
    if (data.capabilities !== undefined)
      updateData.capabilities = data.capabilities || null
    if (data.toolStatus !== undefined)
      updateData.toolStatus = data.toolStatus || null
    if (data.location !== undefined) updateData.location = data.location || null
    if (data.notes !== undefined) updateData.notes = data.notes || null

    if (Object.keys(updateData).length > 0) {
      await run.update(tools).set(updateData).where(eq(tools.itemId, itemId))
    }
  },
})
