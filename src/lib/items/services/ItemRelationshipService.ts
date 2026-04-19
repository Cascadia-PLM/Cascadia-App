// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { branchItems, itemRelationships, items } from '../../db/schema'
import { NotFoundError } from '../../errors'
import { BranchService } from '../../services/BranchService'
import { CommitService } from '../../services/CommitService'
import { ThreadCacheService } from '../../services/ThreadCacheService'
import type { BaseItem } from '../types/base'
import { itemLogger } from '@/lib/logging/logger'

/**
 * Service layer for item relationship operations
 * Extracted from ItemService to keep relationship logic isolated
 */
export class ItemRelationshipService {
  /**
   * Get items related to a specific item
   */
  static async getRelated(
    id: string,
    relationshipType?: string,
  ): Promise<Array<BaseItem>> {
    // Lazy import to avoid circular dependency
    const { ItemService } = await import('./ItemService')

    const query = relationshipType
      ? and(
          eq(itemRelationships.sourceId, id),
          eq(itemRelationships.relationshipType, relationshipType),
        )
      : eq(itemRelationships.sourceId, id)

    const relationships = await db.select().from(itemRelationships).where(query)

    const relatedItems = await Promise.all(
      relationships.map((rel) => ItemService.findById(rel.targetId)),
    )

    return relatedItems.filter((item): item is BaseItem => item !== null)
  }

  /**
   * Get relationships with full details (including relationship metadata)
   */
  static async getRelationshipsWithDetails(
    id: string,
    relationshipType?: string,
  ) {
    // Lazy import to avoid circular dependency
    const { ItemService } = await import('./ItemService')

    const query = relationshipType
      ? and(
          eq(itemRelationships.sourceId, id),
          eq(itemRelationships.relationshipType, relationshipType),
        )
      : eq(itemRelationships.sourceId, id)

    const relationships = await db.select().from(itemRelationships).where(query)

    const enrichedRelationships = await Promise.all(
      relationships.map(async (rel) => {
        const targetItem = await ItemService.findById(rel.targetId)
        return {
          ...rel,
          targetItem,
        }
      }),
    )

    return enrichedRelationships.filter((rel) => rel.targetItem !== null)
  }

  /**
   * Get relationships with details, merging main branch + ECO branch relationships.
   * ECO relationships take precedence over main when the same target masterId exists in both.
   */
  static async getRelationshipsWithDetailsForBranch(
    itemId: string,
    branchId: string,
    relationshipType?: string,
  ) {
    const { ItemService } = await import('./ItemService')

    // 1. Get the item to find its masterId and designId
    const item = await ItemService.findById(itemId)
    if (!item || !item.designId) {
      return this.getRelationshipsWithDetails(itemId, relationshipType)
    }

    // 2. Get the main branch
    const mainBranch = await BranchService.getMainBranch(item.designId)
    if (!mainBranch || branchId === mainBranch.id) {
      // Already on main — standard query
      return this.getRelationshipsWithDetails(itemId, relationshipType)
    }

    // 3. Find the main version of this item via branchItems
    const mainBranchItem = await db
      .select({ currentItemId: branchItems.currentItemId })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, mainBranch.id),
          eq(branchItems.itemMasterId, item.masterId!),
        ),
      )
      .limit(1)

    const mainItemId = mainBranchItem[0]?.currentItemId
    if (!mainItemId || mainItemId === itemId) {
      // No separate main version — standard query
      return this.getRelationshipsWithDetails(itemId, relationshipType)
    }

    // 4. Query relationships from both main and ECO versions
    const sourceIds = [itemId, mainItemId]
    const baseCondition = inArray(itemRelationships.sourceId, sourceIds)
    const query = relationshipType
      ? and(
          baseCondition,
          eq(itemRelationships.relationshipType, relationshipType),
        )
      : baseCondition

    const allRelationships = await db
      .select()
      .from(itemRelationships)
      .where(query)

    // 5. Build ECO branchItems map for resolving target IDs to their ECO versions
    const ecoBranchItemsResult = await db
      .select({
        currentItemId: branchItems.currentItemId,
        itemMasterId: branchItems.itemMasterId,
      })
      .from(branchItems)
      .where(eq(branchItems.branchId, branchId))

    const ecoMasterToItemId = new Map<string, string>()
    for (const bi of ecoBranchItemsResult) {
      if (bi.currentItemId && bi.itemMasterId) {
        ecoMasterToItemId.set(bi.itemMasterId, bi.currentItemId)
      }
    }

    // 6. Deduplicate by target masterId — ECO relationships take priority
    //    We need target masterIds to deduplicate, so fetch target items
    const targetIds = [...new Set(allRelationships.map((r) => r.targetId))]
    const targetItemsMap = new Map<string, { id: string; masterId: string }>()
    if (targetIds.length > 0) {
      const targetItemRows = await db
        .select({ id: items.id, masterId: items.masterId })
        .from(items)
        .where(inArray(items.id, targetIds))
      for (const row of targetItemRows) {
        targetItemsMap.set(row.id, row)
      }
    }

    // Group by target masterId, preferring ECO-sourced relationships
    const deduped = new Map<string, (typeof allRelationships)[number]>()
    for (const rel of allRelationships) {
      const targetInfo = targetItemsMap.get(rel.targetId)
      const targetMasterId = targetInfo?.masterId ?? rel.targetId
      const isEcoRelationship = rel.sourceId === itemId

      if (!deduped.has(targetMasterId) || isEcoRelationship) {
        deduped.set(targetMasterId, rel)
      }
    }

    // 7. Enrich with targetItem details, resolving to ECO versions where available
    const enrichedRelationships = await Promise.all(
      Array.from(deduped.values()).map(async (rel) => {
        // Resolve the target to its ECO version if one exists
        const targetInfo = targetItemsMap.get(rel.targetId)
        const targetMasterId = targetInfo?.masterId
        const ecoTargetId = targetMasterId
          ? ecoMasterToItemId.get(targetMasterId)
          : undefined
        const resolvedTargetId = ecoTargetId ?? rel.targetId

        const targetItem = await ItemService.findById(resolvedTargetId)
        return {
          ...rel,
          targetId: resolvedTargetId,
          targetItem,
        }
      }),
    )

    return enrichedRelationships.filter((rel) => rel.targetItem !== null)
  }

  /**
   * Add a relationship between items
   */
  static async addRelationship(
    sourceId: string,
    targetId: string,
    relationshipType: string,
    userId: string,
    data?: {
      quantity?: string
      referenceDesignator?: string
      findNumber?: number
    },
  ): Promise<typeof itemRelationships.$inferSelect> {
    // Lazy import to avoid circular dependency
    const { ItemService } = await import('./ItemService')

    const [relationship] = await db
      .insert(itemRelationships)
      .values({
        sourceId,
        targetId,
        relationshipType,
        quantity: data?.quantity,
        referenceDesignator: data?.referenceDesignator,
        findNumber: data?.findNumber,
        createdBy: userId,
      })
      .returning()

    // Track relationship change in history
    const sourceItem = await ItemService.findById(sourceId)
    const targetItem = await ItemService.findById(targetId)

    if (sourceItem?.designId) {
      try {
        // Determine which branch to commit to
        const branchInfo = await ItemService.getItemBranchInfo(sourceId)
        let branchId: string | null = null

        if (branchInfo) {
          branchId = branchInfo.branchId
        } else {
          const mainBranch = await BranchService.getMainBranch(
            sourceItem.designId,
          )
          branchId = mainBranch?.id || null
        }

        if (branchId) {
          await CommitService.create(
            {
              branchId,
              message: `Added ${relationshipType} relationship: ${sourceItem.itemNumber} → ${targetItem?.itemNumber || targetId}`,
              itemChanges: [
                {
                  itemId: sourceId,
                  changeType: 'modified',
                  fieldChanges: [
                    {
                      fieldName: `${relationshipType.toLowerCase()}_added`,
                      fieldPath: `relationships.${relationshipType}`,
                      oldValue: null,
                      newValue: {
                        targetId,
                        targetItemNumber: targetItem?.itemNumber,
                        quantity: data?.quantity,
                        findNumber: data?.findNumber,
                      },
                      fieldCategory: 'relationship',
                    },
                  ],
                },
              ],
            },
            userId,
          )
        }
      } catch (error) {
        itemLogger.warn(
          { err: error },
          'Failed to create commit for relationship add',
        )
      }
    }

    // Invalidate thread caches that contain either item (fire and forget)
    ThreadCacheService.invalidateForRelationship(sourceId, targetId).catch(
      (err) => {
        itemLogger.warn({ err }, 'Failed to invalidate thread cache')
      },
    )

    return relationship
  }

  /**
   * Batch add relationships with optional history tracking.
   * Creates one commit per design/branch group instead of one per relationship.
   */
  static async addRelationshipBatch(
    relationships: Array<{
      sourceId: string
      targetId: string
      relationshipType: string
      userId: string
      data?: {
        quantity?: string
        referenceDesignator?: string
        findNumber?: number
        metadata?: Record<string, unknown> | null
      }
    }>,
    options?: { skipHistory?: boolean },
  ): Promise<Array<typeof itemRelationships.$inferSelect>> {
    if (relationships.length === 0) return []

    const { ItemService } = await import('./ItemService')

    // Insert all relationships
    const inserted = await db
      .insert(itemRelationships)
      .values(
        relationships.map((r) => ({
          sourceId: r.sourceId,
          targetId: r.targetId,
          relationshipType: r.relationshipType,
          quantity: r.data?.quantity ?? null,
          referenceDesignator: r.data?.referenceDesignator ?? null,
          findNumber: r.data?.findNumber ?? null,
          metadata: r.data?.metadata ?? null,
          createdBy: r.userId,
        })),
      )
      .returning()

    if (!options?.skipHistory) {
      // Group by source item's design/branch for consolidated commits
      const commitGroups = new Map<
        string,
        {
          branchId: string
          itemChanges: Array<{
            itemId: string
            changeType: 'modified'
            fieldChanges: Array<{
              fieldName: string
              fieldPath: string
              oldValue: null
              newValue: unknown
              fieldCategory: 'type' | 'core' | 'attribute' | 'relationship'
            }>
          }>
          userId: string
          count: number
        }
      >()

      for (const rel of relationships) {
        try {
          const sourceItem = await ItemService.findById(rel.sourceId)
          if (!sourceItem?.designId) continue

          const branchInfo = await ItemService.getItemBranchInfo(rel.sourceId)
          let branchId: string | null = null

          if (branchInfo) {
            branchId = branchInfo.branchId
          } else {
            const mainBranch = await BranchService.getMainBranch(
              sourceItem.designId,
            )
            branchId = mainBranch?.id || null
          }
          if (!branchId) continue

          const targetItem = await ItemService.findById(rel.targetId)
          const groupKey = branchId

          if (!commitGroups.has(groupKey)) {
            commitGroups.set(groupKey, {
              branchId,
              itemChanges: [],
              userId: rel.userId,
              count: 0,
            })
          }

          const group = commitGroups.get(groupKey)!
          group.count++

          const fieldChange = {
            fieldName: `${rel.relationshipType.toLowerCase()}_added`,
            fieldPath: `relationships.${rel.relationshipType}`,
            oldValue: null,
            newValue: {
              targetId: rel.targetId,
              targetItemNumber: targetItem?.itemNumber,
              quantity: rel.data?.quantity,
              findNumber: rel.data?.findNumber,
            },
            fieldCategory: 'relationship' as const,
          }

          // Merge field changes for the same source item to avoid
          // duplicate (commit_id, item_id) entries in item_versions
          const existing = group.itemChanges.find(
            (c) => c.itemId === rel.sourceId,
          )
          if (existing) {
            existing.fieldChanges.push(fieldChange)
          } else {
            group.itemChanges.push({
              itemId: rel.sourceId,
              changeType: 'modified',
              fieldChanges: [fieldChange],
            })
          }
        } catch (error) {
          itemLogger.warn(
            { err: error },
            'Failed to prepare commit for batch relationship',
          )
        }
      }

      // Create one commit per branch group
      for (const group of commitGroups.values()) {
        try {
          await CommitService.create(
            {
              branchId: group.branchId,
              message: `Batch added ${group.count} relationship(s)`,
              itemChanges: group.itemChanges,
            },
            group.userId,
          )
        } catch (error) {
          itemLogger.warn(
            { err: error },
            'Failed to create commit for batch relationships',
          )
        }
      }
    }

    // Batch invalidate thread caches
    const uniqueItemIds = new Set<string>()
    for (const rel of relationships) {
      uniqueItemIds.add(rel.sourceId)
      uniqueItemIds.add(rel.targetId)
    }
    for (const itemId of uniqueItemIds) {
      ThreadCacheService.invalidateForItem(itemId).catch((err) => {
        itemLogger.warn({ err }, 'Failed to invalidate thread cache')
      })
    }

    return inserted
  }

  /**
   * Remove a relationship between items
   */
  static async removeRelationship(
    relationshipId: string,
    userId?: string,
  ): Promise<void> {
    // Lazy import to avoid circular dependency
    const { ItemService } = await import('./ItemService')

    // Get relationship details before deleting for history tracking
    const relationshipResults = await db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.id, relationshipId))
      .limit(1)

    if (relationshipResults.length === 0) {
      throw new NotFoundError('ItemRelationship', relationshipId)
    }
    const relationship = relationshipResults[0]

    await db
      .delete(itemRelationships)
      .where(eq(itemRelationships.id, relationshipId))

    // Track relationship removal in history
    if (userId) {
      const sourceItem = await ItemService.findById(relationship.sourceId)
      const targetItem = await ItemService.findById(relationship.targetId)

      if (sourceItem?.designId) {
        try {
          // Determine which branch to commit to
          const branchInfo = await ItemService.getItemBranchInfo(
            relationship.sourceId,
          )
          let branchId: string | null = null

          if (branchInfo) {
            branchId = branchInfo.branchId
          } else {
            const mainBranch = await BranchService.getMainBranch(
              sourceItem.designId,
            )
            branchId = mainBranch?.id || null
          }

          if (branchId) {
            await CommitService.create(
              {
                branchId,
                message: `Removed ${relationship.relationshipType} relationship: ${sourceItem.itemNumber} → ${targetItem?.itemNumber || relationship.targetId}`,
                itemChanges: [
                  {
                    itemId: relationship.sourceId,
                    changeType: 'modified',
                    fieldChanges: [
                      {
                        fieldName: `${relationship.relationshipType.toLowerCase()}_removed`,
                        fieldPath: `relationships.${relationship.relationshipType}`,
                        oldValue: {
                          targetId: relationship.targetId,
                          targetItemNumber: targetItem?.itemNumber,
                          quantity: relationship.quantity,
                          findNumber: relationship.findNumber,
                        },
                        newValue: null,
                        fieldCategory: 'relationship',
                      },
                    ],
                  },
                ],
              },
              userId,
            )
          }
        } catch (error) {
          itemLogger.warn(
            { err: error },
            'Failed to create commit for relationship removal',
          )
        }
      }
    }

    // Invalidate thread caches that contain either item (fire and forget)
    ThreadCacheService.invalidateForRelationship(
      relationship.sourceId,
      relationship.targetId,
    ).catch((err) => {
      itemLogger.warn({ err }, 'Failed to invalidate thread cache')
    })
  }

  /**
   * Update a relationship's properties (quantity, referenceDesignator, findNumber)
   */
  static async updateRelationship(
    relationshipId: string,
    userId: string,
    data: {
      quantity?: string | null
      referenceDesignator?: string | null
      findNumber?: number | null
    },
  ): Promise<typeof itemRelationships.$inferSelect> {
    const { ItemService } = await import('./ItemService')

    // Get current relationship before updating
    const [existing] = await db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.id, relationshipId))
      .limit(1)

    if (!existing) {
      throw new Error(`Relationship ${relationshipId} not found`)
    }

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {
      modifiedBy: userId,
      modifiedAt: new Date(),
    }
    if (data.quantity !== undefined) updateData.quantity = data.quantity
    if (data.referenceDesignator !== undefined)
      updateData.referenceDesignator = data.referenceDesignator
    if (data.findNumber !== undefined) updateData.findNumber = data.findNumber

    const [updated] = await db
      .update(itemRelationships)
      .set(updateData)
      .where(eq(itemRelationships.id, relationshipId))
      .returning()

    // Track relationship update in history
    const sourceItem = await ItemService.findById(existing.sourceId)
    const targetItem = await ItemService.findById(existing.targetId)

    if (sourceItem?.designId) {
      try {
        const branchInfo = await ItemService.getItemBranchInfo(
          existing.sourceId,
        )
        let branchId: string | null = null

        if (branchInfo) {
          branchId = branchInfo.branchId
        } else {
          const mainBranch = await BranchService.getMainBranch(
            sourceItem.designId,
          )
          branchId = mainBranch?.id || null
        }

        if (branchId) {
          // Compute field-level changes for the relationship
          const fieldChanges: Array<{
            fieldName: string
            fieldPath: string
            oldValue: unknown
            newValue: unknown
            fieldCategory: 'relationship'
          }> = []

          const targetLabel = targetItem?.itemNumber || existing.targetId

          if (
            data.quantity !== undefined &&
            existing.quantity !== data.quantity
          ) {
            fieldChanges.push({
              fieldName: `bom_quantity_changed`,
              fieldPath: `relationships.${existing.relationshipType}`,
              oldValue: {
                targetItemNumber: targetLabel,
                quantity: existing.quantity,
              },
              newValue: {
                targetItemNumber: targetLabel,
                quantity: data.quantity,
              },
              fieldCategory: 'relationship',
            })
          }

          if (
            data.referenceDesignator !== undefined &&
            existing.referenceDesignator !== data.referenceDesignator
          ) {
            fieldChanges.push({
              fieldName: `bom_refdes_changed`,
              fieldPath: `relationships.${existing.relationshipType}`,
              oldValue: {
                targetItemNumber: targetLabel,
                referenceDesignator: existing.referenceDesignator,
              },
              newValue: {
                targetItemNumber: targetLabel,
                referenceDesignator: data.referenceDesignator,
              },
              fieldCategory: 'relationship',
            })
          }

          if (
            data.findNumber !== undefined &&
            existing.findNumber !== data.findNumber
          ) {
            fieldChanges.push({
              fieldName: `bom_findnumber_changed`,
              fieldPath: `relationships.${existing.relationshipType}`,
              oldValue: {
                targetItemNumber: targetLabel,
                findNumber: existing.findNumber,
              },
              newValue: {
                targetItemNumber: targetLabel,
                findNumber: data.findNumber,
              },
              fieldCategory: 'relationship',
            })
          }

          if (fieldChanges.length > 0) {
            await CommitService.create(
              {
                branchId,
                message: `Updated ${existing.relationshipType} relationship: ${sourceItem.itemNumber} → ${targetLabel}`,
                itemChanges: [
                  {
                    itemId: existing.sourceId,
                    changeType: 'modified',
                    fieldChanges,
                  },
                ],
              },
              userId,
            )
          }
        }
      } catch (error) {
        itemLogger.warn(
          { err: error },
          'Failed to create commit for relationship update',
        )
      }
    }

    // Invalidate thread caches
    ThreadCacheService.invalidateForRelationship(
      existing.sourceId,
      existing.targetId,
    ).catch((err) => {
      itemLogger.warn({ err }, 'Failed to invalidate thread cache')
    })

    return updated
  }

  /**
   * Get unique relationship types for an item
   */
  static async getRelationshipTypes(id: string): Promise<Array<string>> {
    const relationships = await db
      .select({ relationshipType: itemRelationships.relationshipType })
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, id))

    const uniqueTypes = [
      ...new Set(relationships.map((r) => r.relationshipType)),
    ]
    return uniqueTypes
  }
}
