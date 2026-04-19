import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { documents } from '@/lib/db/schema'

registerTypeHandler('Document', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(documents).values({
      itemId,
      description: data.description,
      fileId: data.fileId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      mimeType: data.mimeType,
      storagePath: data.storagePath,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [doc] = await run
      .select()
      .from(documents)
      .where(eq(documents.itemId, itemId))
      .limit(1)
    return doc
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.description !== undefined)
      updateData.description = data.description || null
    if (data.fileId !== undefined) updateData.fileId = data.fileId || null
    if (data.fileName !== undefined) updateData.fileName = data.fileName || null
    if (data.fileSize !== undefined) updateData.fileSize = data.fileSize || null
    if (data.mimeType !== undefined) updateData.mimeType = data.mimeType || null
    if (data.storagePath !== undefined)
      updateData.storagePath = data.storagePath || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(documents)
        .set(updateData)
        .where(eq(documents.itemId, itemId))
    }
  },
})
