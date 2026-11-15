// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/db'
import { systemElements } from '@/db/schema'

registerTypeHandler('SystemElement', {
  table: systemElements,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(systemElements).values({
      itemId,
      elementKind: data.elementKind || null,
      description: data.description || null,
      ports: data.ports ?? [],
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [element] = await run
      .select()
      .from(systemElements)
      .where(eq(systemElements.itemId, itemId))
      .limit(1)
    return element
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}
    if (data.elementKind !== undefined)
      updateData.elementKind = data.elementKind || null
    if (data.description !== undefined)
      updateData.description = data.description || null
    if (data.ports !== undefined) updateData.ports = data.ports ?? []

    if (Object.keys(updateData).length > 0) {
      await run
        .update(systemElements)
        .set(updateData)
        .where(eq(systemElements.itemId, itemId))
    }
  },
})
