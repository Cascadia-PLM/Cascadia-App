// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { software } from '@/lib/db/schema'
import { softwareSourceSchema } from '@/lib/items/types/software'

const SOURCE_FIELDS = [
  'sourceMode',
  'externalRepositoryUrl',
  'externalRef',
  'externalCommitSha',
] as const

function sourceValues(data: Record<string, unknown>) {
  const parsed = softwareSourceSchema.parse(data)
  const isExternal = parsed.sourceMode === 'external'

  return {
    sourceMode: parsed.sourceMode,
    externalRepositoryUrl: isExternal
      ? (parsed.externalRepositoryUrl ?? null)
      : null,
    externalRef: isExternal ? (parsed.externalRef ?? null) : null,
    externalCommitSha: isExternal
      ? (parsed.externalCommitSha?.toLowerCase() ?? null)
      : null,
  }
}

registerTypeHandler('Software', {
  table: software,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    const source = sourceValues(data)
    await run.insert(software).values({
      itemId,
      description: data.description || null,
      softwareType: data.softwareType || null,
      ...source,
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
    if (SOURCE_FIELDS.some((field) => data[field] !== undefined)) {
      const [current] = await run
        .select({
          sourceMode: software.sourceMode,
          externalRepositoryUrl: software.externalRepositoryUrl,
          externalRef: software.externalRef,
          externalCommitSha: software.externalCommitSha,
        })
        .from(software)
        .where(eq(software.itemId, itemId))
        .limit(1)

      const mergedSource = sourceValues({
        ...current,
        ...Object.fromEntries(
          SOURCE_FIELDS.filter((field) => data[field] !== undefined).map(
            (field) => [field, data[field]],
          ),
        ),
      })
      Object.assign(updateData, mergedSource)
    }
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
