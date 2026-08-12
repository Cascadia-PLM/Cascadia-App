// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { physicalParts } from '@/lib/db/schema'

registerTypeHandler('PhysicalPart', {
  table: physicalParts,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(physicalParts).values({
      itemId,
      instanceKind: data.instanceKind,
      partMasterId: data.partMasterId,
      serialNumber: data.serialNumber || null,
      lotNumber: data.lotNumber || null,
      manufacturerPartId: data.manufacturerPartId || null,
      asBuiltItemId: data.asBuiltItemId || null,
      producingWorkOrderId: data.producingWorkOrderId || null,
      erpRef: data.erpRef || null,
      notes: data.notes || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [physicalPart] = await run
      .select()
      .from(physicalParts)
      .where(eq(physicalParts.itemId, itemId))
      .limit(1)
    return physicalPart
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    // Identity fields (instanceKind, partMasterId, serialNumber, lotNumber)
    // are immutable after registration — traceability identity never mutates.
    if (data.manufacturerPartId !== undefined)
      updateData.manufacturerPartId = data.manufacturerPartId || null
    if (data.asBuiltItemId !== undefined)
      updateData.asBuiltItemId = data.asBuiltItemId || null
    if (data.producingWorkOrderId !== undefined)
      updateData.producingWorkOrderId = data.producingWorkOrderId || null
    if (data.erpRef !== undefined) updateData.erpRef = data.erpRef || null
    if (data.notes !== undefined) updateData.notes = data.notes || null

    if (Object.keys(updateData).length > 0) {
      await run
        .update(physicalParts)
        .set(updateData)
        .where(eq(physicalParts.itemId, itemId))
    }
  },
})
