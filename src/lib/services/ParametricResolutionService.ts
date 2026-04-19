import { eq, inArray } from 'drizzle-orm'
import type { StepContentBlock } from '@/lib/db/schema/items'
import { db } from '@/lib/db'
import { items, parts, workInstructionSteps } from '@/lib/db/schema'

interface ResolvedValue {
  value: string | null
  available: boolean
}

// Typed columns from the parts table that can be resolved
const PART_TYPED_ATTRIBUTES = [
  'description',
  'partType',
  'material',
  'weight',
  'weightUnit',
  'cost',
  'costCurrency',
  'leadTimeDays',
  'quantityOnHand',
  'reorderPoint',
  'location',
] as const

// Item-level attributes that can be resolved
const ITEM_ATTRIBUTES = ['name', 'itemNumber', 'revision', 'state'] as const

export class ParametricResolutionService {
  /**
   * Resolve a single parametric block value
   */
  static async resolveParametricBlock(
    partId: string,
    attributePath: string,
  ): Promise<ResolvedValue> {
    const result = await db
      .select({
        item: items,
        part: parts,
      })
      .from(items)
      .leftJoin(parts, eq(parts.itemId, items.id))
      .where(eq(items.id, partId))
      .limit(1)

    if (result.length === 0 || !result[0]) {
      return { value: null, available: false }
    }

    const { item, part } = result[0]

    return this.extractValue(item, part, attributePath)
  }

  /**
   * Resolve all parametric blocks in a work instruction's steps.
   * Batches part queries for efficiency.
   */
  static async resolveAllSteps(
    wiId: string,
  ): Promise<Record<string, ResolvedValue>> {
    // Get all steps
    const steps = await db
      .select()
      .from(workInstructionSteps)
      .where(eq(workInstructionSteps.workInstructionId, wiId))

    // Collect all unique partId + attributePath pairs
    const partIds = new Set<string>()
    const resolutionKeys: Array<{ partId: string; attributePath: string }> = []

    for (const step of steps) {
      const content = step.content as {
        blocks?: Array<StepContentBlock>
      } | null
      if (!content?.blocks) continue

      for (const block of content.blocks) {
        if (
          block.type === 'parametric' &&
          block.partId &&
          block.attributePath
        ) {
          partIds.add(block.partId)
          resolutionKeys.push({
            partId: block.partId,
            attributePath: block.attributePath,
          })
        }
      }
    }

    if (partIds.size === 0) {
      return {}
    }

    // Batch query all needed parts
    const partResults = await db
      .select({
        item: items,
        part: parts,
      })
      .from(items)
      .leftJoin(parts, eq(parts.itemId, items.id))
      .where(inArray(items.id, Array.from(partIds)))

    // Build lookup map
    const partMap = new Map<
      string,
      {
        item: (typeof partResults)[0]['item']
        part: (typeof partResults)[0]['part']
      }
    >()
    for (const row of partResults) {
      partMap.set(row.item.id, row)
    }

    // Resolve each key
    const resolved: Record<string, ResolvedValue> = {}
    for (const { partId, attributePath } of resolutionKeys) {
      const key = `${partId}.${attributePath}`
      if (resolved[key]) continue // Already resolved

      const data = partMap.get(partId)
      if (!data) {
        resolved[key] = { value: null, available: false }
        continue
      }

      resolved[key] = this.extractValue(data.item, data.part, attributePath)
    }

    return resolved
  }

  /**
   * Get all resolvable attributes for a given part
   */
  static async getResolvableAttributes(
    partId: string,
  ): Promise<Array<{ path: string; label: string; value: string | null }>> {
    const result = await db
      .select({
        item: items,
        part: parts,
      })
      .from(items)
      .leftJoin(parts, eq(parts.itemId, items.id))
      .where(eq(items.id, partId))
      .limit(1)

    if (result.length === 0 || !result[0]) {
      return []
    }

    const { item, part } = result[0]
    const attributes: Array<{
      path: string
      label: string
      value: string | null
    }> = []

    // Item-level attributes
    for (const attr of ITEM_ATTRIBUTES) {
      const val = item[attr]
      attributes.push({
        path: attr,
        label: this.formatLabel(attr),
        value: val != null ? String(val) : null,
      })
    }

    // Part typed columns
    if (part) {
      for (const attr of PART_TYPED_ATTRIBUTES) {
        const val = part[attr]
        attributes.push({
          path: attr,
          label: this.formatLabel(attr),
          value: val != null ? String(val) : null,
        })
      }
    }

    // Dynamic JSONB attributes
    const jsonAttrs = item.attributes ?? {}
    for (const [key, val] of Object.entries(jsonAttrs)) {
      attributes.push({
        path: `attributes.${key}`,
        label: this.formatLabel(key),
        value: val != null ? String(val) : null,
      })
    }

    return attributes
  }

  private static extractValue(
    item: Record<string, unknown>,
    part: Record<string, unknown> | null,
    attributePath: string,
  ): ResolvedValue {
    // Check item-level attributes first
    if ((ITEM_ATTRIBUTES as ReadonlyArray<string>).includes(attributePath)) {
      const val = item[attributePath]
      return {
        value: val != null ? String(val) : null,
        available: true,
      }
    }

    // Check part typed columns
    if (
      (PART_TYPED_ATTRIBUTES as ReadonlyArray<string>).includes(attributePath)
    ) {
      if (!part) {
        return { value: null, available: true }
      }
      const val = part[attributePath]
      return {
        value: val != null ? String(val) : null,
        available: true,
      }
    }

    // Check JSONB attributes (path like "attributes.tensileStrength")
    if (attributePath.startsWith('attributes.')) {
      const jsonKey = attributePath.slice('attributes.'.length)
      const attrs = (item.attributes ?? {}) as Record<string, unknown>
      const val = attrs[jsonKey]
      return {
        value: val != null ? String(val) : null,
        available: true,
      }
    }

    return { value: null, available: false }
  }

  private static formatLabel(key: string): string {
    // Convert camelCase to Title Case
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (s) => s.toUpperCase())
      .trim()
  }
}
