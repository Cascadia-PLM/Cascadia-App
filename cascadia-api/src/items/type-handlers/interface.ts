// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/db'
import { interfaces } from '@/db/schema'

registerTypeHandler('Interface', {
  table: interfaces,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(interfaces).values({
      itemId,
      interfaceKind: data.interfaceKind || null,
      description: data.description || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [row] = await run
      .select()
      .from(interfaces)
      .where(eq(interfaces.itemId, itemId))
      .limit(1)
    return row
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}
    if (data.interfaceKind !== undefined)
      updateData.interfaceKind = data.interfaceKind || null
    if (data.description !== undefined)
      updateData.description = data.description || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(interfaces)
        .set(updateData)
        .where(eq(interfaces.itemId, itemId))
    }
  },
})
