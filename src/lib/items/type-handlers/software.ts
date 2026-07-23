import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { software } from '@/lib/db/schema'

registerTypeHandler('Software', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(software).values({
      itemId,
      description: data.description || null,
      softwareType: data.softwareType || null,
      sourceMode: data.sourceMode || 'internal',
      version: data.version || null,
      targetHardware: data.targetHardware || null,
      toolchain: data.toolchain || null,
      manifestId: data.manifestId || null,
      draftManifestId: data.draftManifestId || null,
      buildArtifactFileId: data.buildArtifactFileId || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [row] = await run
      .select()
      .from(software)
      .where(eq(software.itemId, itemId))
      .limit(1)
    return row
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.description !== undefined)
      updateData.description = data.description || null
    if (data.softwareType !== undefined)
      updateData.softwareType = data.softwareType || null
    if (data.sourceMode !== undefined)
      updateData.sourceMode = data.sourceMode || 'internal'
    if (data.version !== undefined) updateData.version = data.version || null
    if (data.targetHardware !== undefined)
      updateData.targetHardware = data.targetHardware || null
    if (data.toolchain !== undefined)
      updateData.toolchain = data.toolchain || null
    if (data.manifestId !== undefined)
      updateData.manifestId = data.manifestId || null
    if (data.draftManifestId !== undefined)
      updateData.draftManifestId = data.draftManifestId || null
    if (data.buildArtifactFileId !== undefined)
      updateData.buildArtifactFileId = data.buildArtifactFileId || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(software)
        .set(updateData)
        .where(eq(software.itemId, itemId))
    }
  },
})
