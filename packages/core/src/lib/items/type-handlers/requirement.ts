// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { requirements } from '@/lib/db/schema'

/**
 * `requirementType` is the API's name for the column the table and the
 * `Requirement` interface both call `type`. The create schema, the AI
 * `create_item` tool (`lib/ai/tools/write-handlers.ts`) and the design
 * engine's draft artifacts all spell it that way, so the alias is resolved
 * here — in one place, honoured by every caller including
 * `PUT /api/v1/requirements/:id` and the generic `PUT /api/v1/items/:id`,
 * neither of which stored it before. An explicit `type` wins when a request
 * carries both.
 */
function resolveType(data: {
  type?: string | null
  requirementType?: string | null
}): string | null | undefined {
  return data.type !== undefined ? data.type : data.requirementType
}

registerTypeHandler('Requirement', {
  table: requirements,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(requirements).values({
      itemId,
      description: data.description || null,
      type: resolveType(data) || null,
      priority: data.priority || null,
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
    const typeValue = resolveType(data)
    if (typeValue !== undefined) updateData.type = typeValue || null
    if (data.priority !== undefined) updateData.priority = data.priority || null
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
