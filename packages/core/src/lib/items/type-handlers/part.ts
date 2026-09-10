// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { parts } from '@/lib/db/schema'

/**
 * Empty-or-absent to NULL, for a column whose value can legitimately be zero.
 *
 * The string columns around it use `x || null`, which is the right
 * normalization there — an empty form field means "no value". On a number it
 * is wrong: a lead time of 0 ("in stock") is a value the schema accepts and
 * both Part forms send as a number, and truthiness turned it into NULL on
 * every write, so the field came back blank after saving it.
 */
function numberOrNull(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  // The type's Zod schema admits only a number here, on create and (through
  // `itemUpdateSchemaFor`) on update.
  return value as number
}

registerTypeHandler('Part', {
  table: parts,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(parts).values({
      itemId,
      description: data.description || null,
      partType: data.partType || null,
      trackingMode: data.trackingMode || 'none',
      material: data.material || null,
      weight: data.weight && data.weight !== '' ? data.weight : null,
      weightUnit: data.weightUnit || null,
      cost: data.cost && data.cost !== '' ? data.cost : null,
      costCurrency: data.costCurrency || null,
      leadTimeDays: numberOrNull(data.leadTimeDays),
      optionModel: data.optionModel ?? null,
      makes: data.makes ?? null,
      productFamilyCode: data.productFamilyCode ?? null,
      variantCode: data.variantCode ?? null,
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
    if (data.trackingMode !== undefined)
      updateData.trackingMode = data.trackingMode || 'none'
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
      updateData.leadTimeDays = numberOrNull(data.leadTimeDays)
    if (data.optionModel !== undefined)
      updateData.optionModel = data.optionModel ?? null
    if (data.makes !== undefined) updateData.makes = data.makes ?? null
    if (data.productFamilyCode !== undefined)
      updateData.productFamilyCode = data.productFamilyCode ?? null
    if (data.variantCode !== undefined)
      updateData.variantCode = data.variantCode ?? null

    if (Object.keys(updateData).length > 0) {
      await run.update(parts).set(updateData).where(eq(parts.itemId, itemId))
    }
  },
})
