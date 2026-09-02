// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { branchItems, designs, itemRelationships, items } from '../../db/schema'
import {
  AlreadyExistsError,
  NotFoundError,
  ValidationError,
} from '../../errors'
import { isUniqueViolation } from '../../errors/pg'
import { resolveEdgeGuardEnd } from '../traceability-relationships'
import { BranchService } from '../../services/BranchService'
import {
  findSupersededRows,
  followSupersededRows,
  resolveInheritedLineage,
} from '../version-lineage'
import { CommitService } from '../../services/CommitService'
import { ThreadCacheService } from '../../services/ThreadCacheService'
import type { TransactionClient } from '../../db'
import type { PersistedItem } from '../types/base'
import { itemLogger } from '@/lib/logging/logger'
import { takeFirst } from '@/lib/db/take-first'

/**
 * The 409 for an edge that is already there. One shape for every path that can
 * hit `unique(source_id, target_id, relationship_type)`, so a caller sees the
 * same error whether we caught it first or the database did.
 */
function relationshipExistsError(
  sourceId: string,
  targetId: string,
  relationshipType: string,
): AlreadyExistsError {
  return new AlreadyExistsError(
    'Relationship',
    `${sourceId} → ${targetId} (${relationshipType})`,
    { sourceId, targetId, relationshipType },
  )
}

/**
 * Service layer for item relationship operations
 * Extracted from ItemService to keep relationship logic isolated
 */
export class ItemRelationshipService {
  /**
   * Keep direct BOM writes inside the scope the structure editor exposes:
   * Part -> Part in one design, with Library parts as the only cross-design
   * targets. A part pulled in as a usage has the target design's `designId`,
   * so it passes the same-design rule while retaining `usageOf` traceability.
   *
   * Cross-design references are a separate model (`design_cross_references`).
   * Their materialisation flow writes the inherited external edges directly;
   * this guard is for user/API relationship creation and batch import, where
   * accepting a wider graph than the picker can later edit creates stranded
   * BOM lines.
   */
  private static async assertBomTargetScope(
    relationships: Array<{
      sourceId: string
      targetId: string
      relationshipType: string
    }>,
    batch = false,
  ): Promise<void> {
    const bomRelationships = relationships
      .map((relationship, index) => ({ relationship, index }))
      .filter(({ relationship }) => relationship.relationshipType === 'BOM')

    if (bomRelationships.length === 0) return

    const itemIds = [
      ...new Set(
        bomRelationships.flatMap(({ relationship }) => [
          relationship.sourceId,
          relationship.targetId,
        ]),
      ),
    ]
    const itemRows = await db
      .select({
        id: items.id,
        designId: items.designId,
        itemType: items.itemType,
        itemNumber: items.itemNumber,
      })
      .from(items)
      .where(inArray(items.id, itemIds))
    const itemById = new Map(itemRows.map((item) => [item.id, item]))

    const targetDesignIds = [
      ...new Set(
        bomRelationships
          .map(({ relationship }) => itemById.get(relationship.targetId))
          .map((item) => item?.designId)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ]
    const targetDesignRows =
      targetDesignIds.length === 0
        ? []
        : await db
            .select({ id: designs.id, designType: designs.designType })
            .from(designs)
            .where(inArray(designs.id, targetDesignIds))
    const libraryDesignIds = new Set(
      targetDesignRows
        .filter((design) => design.designType === 'Library')
        .map((design) => design.id),
    )

    const fieldErrors: Array<{
      field: string
      message: string
      code: string
    }> = []

    for (const { relationship, index } of bomRelationships) {
      const source = itemById.get(relationship.sourceId)
      const target = itemById.get(relationship.targetId)
      const field = batch ? `relationships[${index}].targetId` : 'targetId'

      if (!source || !target) continue

      if (source.itemType !== 'Part' || target.itemType !== 'Part') {
        fieldErrors.push({
          field,
          message: 'BOM relationships must connect Part items',
          code: 'INVALID_BOM_ITEM_TYPE',
        })
        continue
      }

      const sameDesign =
        source.designId !== null && source.designId === target.designId
      const libraryTarget =
        target.designId !== null && libraryDesignIds.has(target.designId)

      if (!sameDesign && !libraryTarget) {
        fieldErrors.push({
          field,
          message:
            `BOM target ${target.itemNumber} must belong to the source ` +
            'design or a Library design; pull it in as a local usage first',
          code: 'BOM_TARGET_OUT_OF_SCOPE',
        })
      }
    }

    if (fieldErrors.length > 0) {
      throw new ValidationError(
        'BOM relationships are limited to the source design and libraries',
        fieldErrors,
      )
    }
  }

  /**
   * Get items related to a specific item
   */
  static async getRelated(
    id: string,
    relationshipType?: string,
  ): Promise<Array<PersistedItem>> {
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

    return relatedItems.filter((item): item is PersistedItem => item !== null)
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

    const currentByStaleTarget = await followSupersededRows(
      relationships.map((rel) => rel.targetId),
    )

    const enrichedRelationships = await Promise.all(
      relationships.map(async (rel) => {
        const targetItem = await ItemService.findById(
          currentByStaleTarget.get(rel.targetId) ?? rel.targetId,
        )
        return {
          ...rel,
          targetItem,
        }
      }),
    )

    return enrichedRelationships.filter((rel) => rel.targetItem !== null)
  }

  /**
   * Relationships of one type pointing AT each of `itemIds`, keyed by the item
   * that answers for them.
   *
   * Reading incoming links by exact `items.id` is wrong in both directions
   * once anything has been revised, and this is the one place that fixes it:
   *
   * - **Links the item inherited.** A relationship names one item version, and
   *   a merge rebuilds only the OUTGOING edges of the items the change order
   *   touched. A test case that verifies a requirement therefore goes on
   *   naming the revision the release superseded, so the lineage is walked
   *   backwards (`resolveInheritedLineage`) to find it.
   * - **Links a revision left behind.** An item's outgoing edges are copied
   *   onto its working copy, so after PN-001 is revised BOTH rev A and rev B
   *   claim to satisfy the requirement, and the reader listed the same part
   *   twice — once Released, once Superseded. Sources that name a superseded
   *   row are dropped.
   *
   * Dropped, deliberately, rather than followed forward the way a stale
   * *target* is: the new revision carries its own copy of the edge whenever it
   * still means it, so redirecting rev A's edge onto rev B would re-assert a
   * link the change order may have deleted on purpose.
   *
   * Every id in `itemIds` is present in the result, with an empty array when
   * nothing points at it.
   */
  static async findIncomingLinks(
    itemIds: Array<string>,
    relationshipType: string,
  ): Promise<Map<string, Array<typeof itemRelationships.$inferSelect>>> {
    const byOwner = new Map<
      string,
      Array<typeof itemRelationships.$inferSelect>
    >()
    const named = [...new Set(itemIds)]
    for (const id of named) byOwner.set(id, [])
    if (named.length === 0) return byOwner

    const lineage = await resolveInheritedLineage(named)

    const rows = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, [...lineage.keys()]),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
    if (rows.length === 0) return byOwner

    const leftBehind = new Set(
      (await findSupersededRows(rows.map((rel) => rel.sourceId))).map(
        (row) => row.id,
      ),
    )

    for (const rel of rows) {
      if (leftBehind.has(rel.sourceId)) continue
      const owner = lineage.get(rel.targetId)
      if (owner) byOwner.get(owner)?.push(rel)
    }

    return byOwner
  }

  /**
   * Relationships of one type running FROM each of `sourceIds`, keyed by
   * source, with any target that names a superseded row resolved forward to
   * the revision that replaced it.
   *
   * The mirror of `findIncomingLinks`, and the same fact seen from the other
   * end: a merge re-points only the lines owned by items the change order
   * touched, so a part that satisfies a requirement keeps naming the
   * requirement revision the release superseded, and the reader reported the
   * link a revision behind — with the stale row's `Superseded` badge on it.
   *
   * Here the stale row IS followed rather than dropped, because only the
   * reference is stale: the link itself is this source's own content and
   * still means what it says. Returned rows carry the resolved `targetId`.
   */
  static async findOutgoingLinks(
    sourceIds: Array<string>,
    relationshipType: string,
  ): Promise<Map<string, Array<typeof itemRelationships.$inferSelect>>> {
    const bySource = new Map<
      string,
      Array<typeof itemRelationships.$inferSelect>
    >()
    const named = [...new Set(sourceIds)]
    for (const id of named) bySource.set(id, [])
    if (named.length === 0) return bySource

    const rows = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, named),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
    if (rows.length === 0) return bySource

    const redirects = await followSupersededRows(
      rows.map((rel) => rel.targetId),
    )

    for (const rel of rows) {
      const targetId = redirects.get(rel.targetId)
      bySource.get(rel.sourceId)?.push(targetId ? { ...rel, targetId } : rel)
    }

    return bySource
  }

  /**
   * Get relationships with details in a branch context.
   *
   * The item's own edges ARE its structure — the authority rule the merge
   * applies at release (ChangeOrderMergeService step 5b). Every step that
   * mints an item-version row carries the source's edges onto it
   * (copyRelationshipsToItem), so there is no fallback to the main version's
   * rows: a line deleted on the branch is gone, and an emptied structure
   * reads as empty. What the branch shows is what a release would produce;
   * targets are additionally resolved to the version the branch carries,
   * where it carries one.
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
          eq(branchItems.itemMasterId, item.masterId),
        ),
      )
      .limit(1)

    const mainItemId = mainBranchItem[0]?.currentItemId
    if (!mainItemId || mainItemId === itemId) {
      // No separate main version — standard query
      return this.getRelationshipsWithDetails(itemId, relationshipType)
    }

    // 4. The working copy's own edges ARE its structure. This method used to
    //    return the union of branch and main edges deduplicated by target,
    //    which resurrected every line deleted on the branch — as a row owned
    //    by the released main version, which branch protection then
    //    (correctly) refused to modify when the user tried to delete it again.
    const visibleRelationships = await db
      .select()
      .from(itemRelationships)
      .where(
        relationshipType
          ? and(
              eq(itemRelationships.sourceId, itemId),
              eq(itemRelationships.relationshipType, relationshipType),
            )
          : eq(itemRelationships.sourceId, itemId),
      )

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

    const targetIds = [...new Set(visibleRelationships.map((r) => r.targetId))]
    const targetMasterById = new Map<string, string>()
    if (targetIds.length > 0) {
      const targetItemRows = await db
        .select({ id: items.id, masterId: items.masterId })
        .from(items)
        .where(inArray(items.id, targetIds))
      for (const row of targetItemRows) {
        targetMasterById.set(row.id, row.masterId)
      }
    }

    // 6. Enrich with targetItem details, resolving to ECO versions where available
    const enrichedRelationships = await Promise.all(
      visibleRelationships.map(async (rel) => {
        const targetMasterId = targetMasterById.get(rel.targetId)
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
   * An edge is identified by (sourceId, targetId, relationshipType) — the
   * unique constraint on `item_relationships`. Two BOM lines naming the same
   * child under different find numbers are therefore the *same* edge, and the
   * quantity has to be aggregated onto one line. Callers use this to say so
   * before the database does, because the driver's answer is a wall of SQL.
   */
  static edgeKey(edge: {
    sourceId: string
    targetId: string
    relationshipType: string
  }): string {
    // NUL separates: it cannot occur in a uuid or a relationship type, so no
    // pair of distinct triples can collide on the joined string.
    return [edge.sourceId, edge.targetId, edge.relationshipType].join('\u0000')
  }

  /**
   * Report every edge in `edges` that repeats an earlier one, as
   * `{ index, firstIndex }` into the array as given. Index-preserving on
   * purpose: the caller reports which *request line* is at fault, and the
   * original bug was blaming the first line of the batch for a collision on a
   * later one.
   */
  static findDuplicateEdges<
    T extends { sourceId: string; targetId: string; relationshipType: string },
  >(edges: Array<T>): Array<{ index: number; firstIndex: number; edge: T }> {
    const firstSeenAt = new Map<string, number>()
    const duplicates: Array<{ index: number; firstIndex: number; edge: T }> = []

    edges.forEach((edge, index) => {
      const key = this.edgeKey(edge)
      const firstIndex = firstSeenAt.get(key)
      if (firstIndex === undefined) {
        firstSeenAt.set(key, index)
        return
      }
      duplicates.push({ index, firstIndex, edge })
    })

    return duplicates
  }

  /**
   * Enforce the edit-lock policy for one edge, on whichever end answers for it.
   *
   * The source always goes through `requireContentEditable` — an edge is that
   * item's structure, and even an item exempt from branch protection is still
   * locked while another user holds its checkout. On top of that, a
   * traceability edge whose source is exempt sends the rule to its other end
   * as well; see `resolveEdgeGuardEnd` for why `VERIFIED_BY` needs it and
   * `Affects` must not have it.
   */
  private static async requireEdgeEditable(
    sourceItem: PersistedItem | null,
    targetId: string,
    relationshipType: string,
    userId: string,
  ): Promise<void> {
    const { ItemService } = await import('./ItemService')

    if (sourceItem) {
      await ItemService.requireContentEditable(sourceItem, userId)
    }

    const guardEnd = await resolveEdgeGuardEnd(
      sourceItem?.itemType ?? '',
      relationshipType,
    )
    if (guardEnd === 'source') return

    const targetItem = await ItemService.findById(targetId)
    if (targetItem) {
      await ItemService.requireContentEditable(targetItem, userId)
    }
  }

  /**
   * Copy every outgoing edge of `sourceItemId` onto `targetItemId`, verbatim.
   *
   * Every step that mints a new item-version row (revision working copy,
   * first save on a branch, rebase, pull-from-main) calls this for the same
   * reason each carries files: edges hang off a version row, so a copy
   * created without them has silently lost its structure — and the merge
   * releases the copy's edges AS the item's structure, which would make the
   * loss permanent. `onConflictDoNothing` keeps it idempotent against a
   * target that already holds one of the edges.
   */
  static async copyRelationshipsToItem(options: {
    sourceItemId: string
    targetItemId: string
    userId: string
    tx?: TransactionClient
  }): Promise<void> {
    const { sourceItemId, targetItemId, userId, tx } = options
    const executor = tx ?? db

    const sourceRelationships = await executor
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, sourceItemId))
    if (sourceRelationships.length === 0) return

    await executor
      .insert(itemRelationships)
      .values(
        sourceRelationships.map((rel) => ({
          sourceId: targetItemId,
          targetId: rel.targetId,
          relationshipType: rel.relationshipType,
          quantity: rel.quantity,
          referenceDesignator: rel.referenceDesignator,
          findNumber: rel.findNumber,
          metadata: rel.metadata,
          createdBy: userId,
        })),
      )
      .onConflictDoNothing()
  }

  /**
   * Add a relationship between items
   *
   * Relationship changes are content edits of the SOURCE item (its BOM /
   * reference structure), so they run through the same edit-lock policy as
   * field updates: requireContentEditable throws unless the caller may edit
   * the source item right now. System flows (materialization, import) that
   * manage their own consistency pass options.bypassEditGuard.
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
    options?: { bypassEditGuard?: boolean },
  ): Promise<typeof itemRelationships.$inferSelect> {
    // Lazy import to avoid circular dependency
    const { ItemService } = await import('./ItemService')

    const sourceItem = await ItemService.findById(sourceId)
    await this.assertBomTargetScope([{ sourceId, targetId, relationshipType }])
    if (!options?.bypassEditGuard) {
      await this.requireEdgeEditable(
        sourceItem,
        targetId,
        relationshipType,
        userId,
      )
    }

    // Answer "this edge already exists" ourselves. Left to the database it
    // surfaces as a wrapped 23505 whose message is the whole INSERT statement.
    const existing = await db
      .select({ id: itemRelationships.id })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, sourceId),
          eq(itemRelationships.targetId, targetId),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      throw relationshipExistsError(sourceId, targetId, relationshipType)
    }

    let relationship: typeof itemRelationships.$inferSelect
    try {
      relationship = takeFirst(
        await db
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
          .returning(),
      )
    } catch (error) {
      // The check above is not a lock; a concurrent insert still lands here.
      if (isUniqueViolation(error, { table: 'item_relationships' })) {
        throw relationshipExistsError(sourceId, targetId, relationshipType)
      }
      throw error
    }

    // Track relationship change in history
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
   *
   * With `replaceExisting`, the existing edges of every (sourceId,
   * relationshipType) pair in the batch are cleared first — rebuilding a BOM
   * from a CAD export, say. The clear and the insert share one transaction, so
   * a rejected batch leaves the old structure standing; when they did not, a
   * single duplicated child left the parent with no BOM at all.
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
    options?: {
      skipHistory?: boolean
      bypassEditGuard?: boolean
      replaceExisting?: boolean
    },
  ): Promise<Array<typeof itemRelationships.$inferSelect>> {
    if (relationships.length === 0) return []

    const { ItemService } = await import('./ItemService')

    // Duplicates inside the batch collide with each other, not with anything
    // stored, so no amount of replacing saves them. Reject before writing.
    const duplicates = this.findDuplicateEdges(relationships)
    if (duplicates.length > 0) {
      throw new ValidationError(
        'A relationship may appear only once per (source, target, type)',
        duplicates.map(({ index, firstIndex, edge }) => ({
          field: `relationships[${index}]`,
          message:
            `Duplicates relationships[${firstIndex}]: ` +
            `${edge.sourceId} → ${edge.targetId} (${edge.relationshipType})`,
          code: 'DUPLICATE_RELATIONSHIP',
        })),
      )
    }

    // The UI confines BOM candidates to the source design plus libraries.
    // Apply that boundary before either the edit checks or a replacement
    // delete so direct API and import callers cannot create an uneditable
    // cross-design structure or erase the old one with an invalid rebuild.
    await this.assertBomTargetScope(relationships, true)

    // Edit-lock policy: every distinct source item must be editable by the
    // user adding relationships to it, plus the requirement end of any
    // traceability line whose source is exempt (see requireEdgeEditable).
    // Each end is checked once per user however many lines name it: a
    // 500-line BOM shares one parent, and re-checking it per line would put
    // back the round trips the batching removed.
    if (!options?.bypassEditGuard) {
      const sourceItems = new Map<string, PersistedItem | null>()
      const guardedSources = new Set<string>()
      const guardedTargets = new Set<string>()

      for (const rel of relationships) {
        let sourceItem = sourceItems.get(rel.sourceId)
        if (sourceItem === undefined) {
          sourceItem = await ItemService.findById(rel.sourceId)
          sourceItems.set(rel.sourceId, sourceItem)
        }

        const sourceKey = `${rel.sourceId}:${rel.userId}`
        if (sourceItem && !guardedSources.has(sourceKey)) {
          guardedSources.add(sourceKey)
          await ItemService.requireContentEditable(sourceItem, rel.userId)
        }

        const guardEnd = await resolveEdgeGuardEnd(
          sourceItem?.itemType ?? '',
          rel.relationshipType,
        )
        if (guardEnd === 'source') continue

        const targetKey = `${rel.targetId}:${rel.userId}`
        if (guardedTargets.has(targetKey)) continue
        guardedTargets.add(targetKey)
        const targetItem = await ItemService.findById(rel.targetId)
        if (targetItem) {
          await ItemService.requireContentEditable(targetItem, rel.userId)
        }
      }
    }

    // Replace + insert as one unit: either the new structure is in place or
    // the old one never moved.
    let inserted: Array<typeof itemRelationships.$inferSelect>
    try {
      inserted = await db.transaction(async (tx) => {
        if (options?.replaceExisting) {
          const typesBySource = new Map<string, Set<string>>()
          for (const rel of relationships) {
            const types = typesBySource.get(rel.sourceId) ?? new Set<string>()
            types.add(rel.relationshipType)
            typesBySource.set(rel.sourceId, types)
          }

          for (const [sourceId, types] of typesBySource) {
            await tx
              .delete(itemRelationships)
              .where(
                and(
                  eq(itemRelationships.sourceId, sourceId),
                  inArray(itemRelationships.relationshipType, [...types]),
                ),
              )
          }
        }

        return tx
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
      })
    } catch (error) {
      // Which edge collided is in the driver's `detail`, but its `message` is
      // the whole INSERT with every bound parameter. Report neither.
      if (isUniqueViolation(error, { table: 'item_relationships' })) {
        throw new ValidationError(
          'One or more relationships already exist (source, target and type ' +
            'must be unique)',
          undefined,
          { relationshipCount: relationships.length },
        )
      }
      throw error
    }

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
   *
   * Removing an edge is a content edit of the source item — same edit-lock
   * policy as addRelationship (which is why userId is required).
   */
  static async removeRelationship(
    relationshipId: string,
    userId: string,
    options?: { bypassEditGuard?: boolean },
  ): Promise<void> {
    // Lazy import to avoid circular dependency
    const { ItemService } = await import('./ItemService')

    // Get relationship details before deleting for history tracking
    const relationshipResults = await db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.id, relationshipId))
      .limit(1)

    const relationship = relationshipResults[0]
    if (!relationship) {
      throw new NotFoundError('ItemRelationship', relationshipId)
    }

    const sourceItem = await ItemService.findById(relationship.sourceId)
    if (!options?.bypassEditGuard) {
      await this.requireEdgeEditable(
        sourceItem,
        relationship.targetId,
        relationship.relationshipType,
        userId,
      )
    }

    await db
      .delete(itemRelationships)
      .where(eq(itemRelationships.id, relationshipId))

    // Track relationship removal in history
    {
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
    options?: { bypassEditGuard?: boolean },
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

    // Edit-lock policy: relationship properties are source-item content
    if (!options?.bypassEditGuard) {
      await this.requireEdgeEditable(
        await ItemService.findById(existing.sourceId),
        existing.targetId,
        existing.relationshipType,
        userId,
      )
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

    if (!updated) {
      throw new NotFoundError('ItemRelationship', relationshipId)
    }

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
