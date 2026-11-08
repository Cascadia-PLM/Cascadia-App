// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { BRANCH_TYPES } from '@cascadia/commons/versioning/branch-types'
import { catalogEndMismatch } from '@cascadia/commons/items/relationships/catalog'
import {
  sameUserMetadata,
  userMetadataOf,
  withUserMetadata,
} from '@cascadia/commons/items/relationships/metadata'
import {
  normalizeReferenceDesignator,
  referenceDesignatorKey,
} from '@cascadia/commons/types/bom'
import { isWorkingRevisionValue } from '@cascadia/commons/types/lifecycle'
import {
  makeCodeSchema,
  optionConditionKey,
  optionConditionSchema,
} from '@cascadia/commons/types/variants'
import { db } from '../../db'
import {
  branchItems,
  branches,
  designs,
  itemRelationships,
  items,
  parts,
} from '../../db/schema'
import {
  AlreadyExistsError,
  NotFoundError,
  ValidationError,
} from '../../errors'
import { isUniqueViolation } from '../../errors/pg'
import {
  DECOMPOSES_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
  resolveEdgeGuardEnd,
} from '../traceability-relationships'
import { rollupVerificationForMasters } from '../../services/verification-rollup'
import {
  SUSPECTABLE_RELATIONSHIP_TYPES,
  affirmationOf,
  carryAffirmation,
  isSuspectable,
  stampInitialAffirmation,
  suspectStateOf,
  withAffirmation,
} from '../trace-affirmation'
import { BranchService } from '../../services/BranchService'
import {
  findSupersededRows,
  followSupersededRows,
  resolveInheritedLineage,
} from '../version-lineage'
import { CommitService } from '../../services/CommitService'
import {
  RELATIONSHIP_ADDED,
  RELATIONSHIP_REMOVED,
  RELATIONSHIP_UPDATED,
  publishDomainEvent,
} from '../../events'
import { publishStructureEdges, structurePayload } from '../structure-events'
import { ThreadCacheService } from '../../services/ThreadCacheService'
import type { SuspectState } from '../trace-affirmation'
import type { TransactionClient } from '../../db'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import type { OptionCondition } from '@cascadia/commons/types/variants'
import { itemLogger } from '@/logging/logger'
import { takeFirst } from '@/db/take-first'

/**
 * The columns an edge keeps when a copy of it is minted for another version
 * row: its SysML composition and multiplicity, and its cross-design
 * provenance. Both describe the edge, not the row it hangs off, so a revision
 * carries them unchanged. Until 2026-10-09 neither the checkout copy nor the
 * merge rebuild carried them, so every one reverted to its default at the
 * first revision.
 */
export function carriedEdgeColumns(edge: {
  isComposite: boolean | null
  isDirected: boolean | null
  multiplicityLower: number | null
  multiplicityUpper: number | null
  usageAttributes: Record<string, unknown> | null
  sourceDesignId: string | null
  targetDesignId: string | null
  sourceDomain: string | null
  targetDomain: string | null
  derivationMethod: string | null
  derivationNotes: string | null
}) {
  return {
    isComposite: edge.isComposite,
    isDirected: edge.isDirected,
    multiplicityLower: edge.multiplicityLower,
    multiplicityUpper: edge.multiplicityUpper,
    usageAttributes: edge.usageAttributes,
    sourceDesignId: edge.sourceDesignId,
    targetDesignId: edge.targetDesignId,
    sourceDomain: edge.sourceDomain,
    targetDomain: edge.targetDomain,
    derivationMethod: edge.derivationMethod,
    derivationNotes: edge.derivationNotes,
  }
}

/**
 * The 409 for an edge that is already there. One shape for every path that can
 * hit one of the relationship identity indexes, so a caller sees the same
 * error whether we caught it first or the database did.
 */
function relationshipExistsError(
  sourceId: string,
  targetId: string,
  relationshipType: string,
  referenceDesignator?: string | null,
): AlreadyExistsError {
  const at = referenceDesignatorKey(relationshipType, referenceDesignator)
  return new AlreadyExistsError(
    'Relationship',
    `${sourceId} → ${targetId} (${relationshipType}${at ? ` at ${at}` : ''})`,
    {
      sourceId,
      targetId,
      relationshipType,
      ...(at ? { referenceDesignator: at } : {}),
    },
  )
}

/**
 * The stored-row half of an edge's reference-designator identity, for a
 * lookup that has to agree with `item_relationships_edge_unique`: on a BOM
 * line the designator must match, a missing one matching only a missing one;
 * on any other relationship it does not take part, so no condition at all.
 */
function referenceDesignatorMatches(
  relationshipType: string,
  referenceDesignator: string | null,
) {
  if (relationshipType !== 'BOM') return undefined
  return referenceDesignator
    ? eq(itemRelationships.referenceDesignator, referenceDesignator)
    : isNull(itemRelationships.referenceDesignator)
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
    const hidden = await this.sourcesHiddenFromOwner(
      rows.map((rel) => rel.sourceId),
      named,
    )

    for (const rel of rows) {
      if (leftBehind.has(rel.sourceId)) continue
      const owner = lineage.get(rel.targetId)
      if (!owner) continue
      if (hidden(rel.sourceId, owner)) continue
      byOwner.get(owner)?.push(rel)
    }

    return byOwner
  }

  /**
   * A predicate for the sources a branch context must not list: each master
   * answers once, from the row the reader's own context holds.
   *
   * A working revision is one branch's own edit, and `resolveInheritedLineage`
   * already refuses to walk *into* one — nothing inherits from a working
   * copy. Two rules follow for the sources that point at a row:
   *
   * - **Main keeps branch copies out.** Checking a part out copies its claims
   *   onto the working copy, and that copy names the released requirement
   *   just as the released part does, so main's list of satisfying parts
   *   showed the released part and its branch copy side by side. A
   *   working-copy source is kept only when the row it answers to is a
   *   working copy on the same branch.
   * - **A branch keeps main's row out once it holds its own.** Read from
   *   inside the branch, the same copied claim listed the working copy beside
   *   the released row it was copied from. When the owner's branch tracks the
   *   source's master, the branch's row is the authority on that master's
   *   claims: the released row is dropped whether the copy kept the edge,
   *   deleted it (then the claim is gone on the branch, as the merge would
   *   release it), or the branch deleted the item. A checkout that has not
   *   yet saved still points at the released row itself, which stays listed.
   */
  private static async sourcesHiddenFromOwner(
    sourceIds: Array<string>,
    ownerIds: Array<string>,
  ): Promise<(sourceId: string, ownerId: string) => boolean> {
    const candidates = [...new Set([...sourceIds, ...ownerIds])]
    const rows = await db
      .select({
        id: items.id,
        revision: items.revision,
        masterId: items.masterId,
      })
      .from(items)
      .where(inArray(items.id, candidates))
    const working = new Set(
      rows
        .filter((row) => isWorkingRevisionValue(row.revision))
        .map((row) => row.id),
    )
    if (working.size === 0) return () => false
    const masterOf = new Map(rows.map((row) => [row.id, row.masterId]))

    const tracked = await db
      .select({
        itemId: branchItems.currentItemId,
        branchId: branchItems.branchId,
      })
      .from(branchItems)
      .where(inArray(branchItems.currentItemId, [...working]))
    const branchOf = new Map<string, string>()
    for (const row of tracked) {
      if (row.itemId) branchOf.set(row.itemId, row.branchId)
    }

    // What each owner's branch holds, by master: the row the branch shows for
    // it and whether the branch deleted it.
    const ownerBranches = [
      ...new Set(
        ownerIds.flatMap((id) => {
          const branchId = working.has(id) ? branchOf.get(id) : undefined
          return branchId ? [branchId] : []
        }),
      ),
    ]
    const heldOnBranch = new Map<
      string,
      Map<string, { currentItemId: string | null; deleted: boolean }>
    >()
    if (ownerBranches.length > 0) {
      const held = await db
        .select({
          branchId: branchItems.branchId,
          masterId: branchItems.itemMasterId,
          currentItemId: branchItems.currentItemId,
          changeType: branchItems.changeType,
        })
        .from(branchItems)
        .where(inArray(branchItems.branchId, ownerBranches))
      for (const row of held) {
        let byMaster = heldOnBranch.get(row.branchId)
        if (!byMaster) {
          byMaster = new Map()
          heldOnBranch.set(row.branchId, byMaster)
        }
        byMaster.set(row.masterId, {
          currentItemId: row.currentItemId,
          deleted: row.changeType === 'deleted',
        })
      }
    }

    return (sourceId, ownerId) => {
      const ownerBranch = working.has(ownerId)
        ? branchOf.get(ownerId)
        : undefined

      if (working.has(sourceId)) {
        const sourceBranch = branchOf.get(sourceId)
        return (
          sourceBranch === undefined ||
          ownerBranch === undefined ||
          sourceBranch !== ownerBranch
        )
      }

      if (ownerBranch === undefined) return false
      const sourceMaster = masterOf.get(sourceId)
      const held = sourceMaster
        ? heldOnBranch.get(ownerBranch)?.get(sourceMaster)
        : undefined
      if (!held) return false
      return held.deleted || held.currentItemId !== sourceId
    }
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
   * The suspect state of each named trace edge — see
   * `items/trace-affirmation.ts` for what makes a claim suspect.
   *
   * Reloads the rows by id rather than trusting what the caller holds:
   * `findOutgoingLinks` hands back a target already resolved forward, and the
   * stored pin is what tells a claim that predates affirmations whether its
   * target has since been superseded. Judged against released rows only, the
   * rule `followSupersededRows` applies to every other read. An id that names
   * no edge is absent from the result.
   */
  static async suspectStatesFor(
    relationshipIds: Array<string>,
  ): Promise<Map<string, SuspectState>> {
    const states = new Map<string, SuspectState>()
    const ids = [...new Set(relationshipIds)]
    if (ids.length === 0) return states

    const rows = await db
      .select()
      .from(itemRelationships)
      .where(inArray(itemRelationships.id, ids))
    if (rows.length === 0) return states

    const redirects = await followSupersededRows(
      rows.map((rel) => rel.targetId),
    )
    for (const rel of rows) {
      states.set(
        rel.id,
        suspectStateOf(rel, redirects.get(rel.targetId) ?? rel.targetId),
      )
    }
    return states
  }

  /**
   * Record that a trace claim still holds.
   *
   * Deliberately outside the edit lock: affirming changes nothing the link
   * says, only who last checked it and against which rows, so a released
   * part's claims can be re-affirmed after the requirement revises without a
   * change order on the part. The target is affirmed as the row that currently
   * answers for it — the pin itself, or the released row that superseded it —
   * and the pin is left where it points, as every reader resolves it anyway.
   * Affirmed on a working copy, the affirmation names that copy, and the merge
   * carries it onto the released row (`carryAffirmation`).
   */
  static async affirmRelationship(
    relationshipId: string,
    userId: string,
  ): Promise<{
    relationship: typeof itemRelationships.$inferSelect
    state: SuspectState
  }> {
    const { ItemService } = await import('./ItemService')

    const [existing] = await db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.id, relationshipId))
      .limit(1)
    if (!existing) {
      throw new NotFoundError('ItemRelationship', relationshipId)
    }
    if (!isSuspectable(existing.relationshipType)) {
      throw new ValidationError(
        `${existing.relationshipType} links carry no affirmation`,
        [
          {
            field: 'relationshipType',
            message: `Only ${[...SUSPECTABLE_RELATIONSHIP_TYPES].join(', ')} links can be affirmed`,
          },
        ],
      )
    }

    const redirects = await followSupersededRows([existing.targetId])
    const currentTargetId =
      redirects.get(existing.targetId) ?? existing.targetId
    const metadata = withAffirmation(existing.metadata, {
      sourceId: existing.sourceId,
      targetId: currentTargetId,
      affirmedBy: userId,
      affirmedAt: new Date().toISOString(),
    })

    const [sourceItem, targetItem] = await Promise.all([
      ItemService.findById(existing.sourceId),
      ItemService.findById(existing.targetId),
    ])

    const relationship = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(itemRelationships)
        .set({ metadata, modifiedBy: userId, modifiedAt: new Date() })
        .where(eq(itemRelationships.id, relationshipId))
        .returning()
      if (!updated) {
        throw new NotFoundError('ItemRelationship', relationshipId)
      }

      // An affirmation is a change to the edge that integrators may well want
      // to hear about — it is what clears a suspect flag downstream.
      if (sourceItem && targetItem) {
        await publishDomainEvent(tx, RELATIONSHIP_UPDATED, {
          actorId: userId,
          subject: { id: existing.sourceId, masterId: sourceItem.masterId },
          context: { designId: sourceItem.designId ?? undefined },
          payload: {
            ...structurePayload(updated, sourceItem, targetItem),
            changedFields: ['affirmed'],
          },
        })
      }
      return updated
    })

    return {
      relationship,
      state: suspectStateOf(relationship, currentTargetId),
    }
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
    const changeOrderBranchItemsResult = await db
      .select({
        currentItemId: branchItems.currentItemId,
        itemMasterId: branchItems.itemMasterId,
      })
      .from(branchItems)
      .where(eq(branchItems.branchId, branchId))

    const changeOrderMasterToItemId = new Map<string, string>()
    for (const bi of changeOrderBranchItemsResult) {
      if (bi.currentItemId && bi.itemMasterId) {
        changeOrderMasterToItemId.set(bi.itemMasterId, bi.currentItemId)
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
        const changeOrderTargetId = targetMasterId
          ? changeOrderMasterToItemId.get(targetMasterId)
          : undefined
        const resolvedTargetId = changeOrderTargetId ?? rel.targetId

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
   * A conditioned line may only name option families and values that its
   * SOURCE part declares. The parent's option model is the vocabulary for its
   * own BOM; a part with no model cannot carry conditioned lines.
   */
  static async assertOptionDeclared(
    sourceId: string,
    option: OptionCondition,
  ): Promise<void> {
    const { findUndeclared } = await import('@cascadia/commons/types/variants')
    const [row] = await db
      .select({ optionModel: parts.optionModel })
      .from(parts)
      .where(eq(parts.itemId, sourceId))
      .limit(1)
    const model = row?.optionModel
    if (!model) {
      throw new ValidationError(
        'The parent part has no option model; declare its option families before conditioning a BOM line',
        [
          {
            field: 'option',
            message: 'No option model on the parent',
            code: 'NO_OPTION_MODEL',
          },
        ],
      )
    }
    const problem = findUndeclared(model, option)
    if (problem) {
      throw new ValidationError(problem, [
        { field: 'option', message: problem, code: 'OPTION_NOT_DECLARED' },
      ])
    }
  }

  /** Canonicalise and validate an option condition before it reaches SQL. */
  static async normalizeOption(
    sourceId: string,
    relationshipType: string,
    option: OptionCondition | null | undefined,
  ): Promise<OptionCondition | null> {
    if (!option) return null
    if (relationshipType !== 'BOM') {
      throw new ValidationError(
        'An option condition can only be set on a BOM relationship',
        [
          {
            field: 'option',
            message: 'Option conditions are only valid for BOM lines',
            code: 'OPTION_NOT_BOM',
          },
        ],
      )
    }
    const parsed = optionConditionSchema.safeParse(option)
    if (!parsed.success) {
      throw new ValidationError('Invalid option condition', [
        {
          field: 'option',
          message:
            parsed.error.issues[0]?.message ?? 'Invalid option condition',
          code: 'OPTION_INVALID',
        },
      ])
    }
    await this.assertOptionDeclared(sourceId, parsed.data)
    return parsed.data
  }

  /**
   * A BOM line may pin an active execution of its target Part version. The
   * reference deliberately points at a code on that exact version: when the
   * child is revised, its available executions are revised with it.
   */
  static async normalizeTargetMake(
    targetId: string,
    relationshipType: string,
    targetMakeCode: string | null | undefined,
  ): Promise<string | null> {
    if (!targetMakeCode) return null
    if (relationshipType !== 'BOM') {
      throw new ValidationError(
        'A target execution can only be selected on a BOM relationship',
        [
          {
            field: 'targetMakeCode',
            message: 'Target execution is only valid for BOM lines',
            code: 'TARGET_MAKE_NOT_BOM',
          },
        ],
      )
    }

    const parsedCode = makeCodeSchema.safeParse(targetMakeCode)
    if (!parsedCode.success) {
      throw new ValidationError('Invalid target execution code', [
        {
          field: 'targetMakeCode',
          message:
            parsedCode.error.issues[0]?.message ?? 'Invalid execution code',
          code: 'TARGET_MAKE_INVALID',
        },
      ])
    }
    const code = parsedCode.data
    const [target] = await db
      .select({ makes: parts.makes })
      .from(parts)
      .where(eq(parts.itemId, targetId))
      .limit(1)
    const make = (target?.makes ?? []).find(
      (candidate) => candidate.code === code,
    )
    if (!make) {
      throw new ValidationError(
        `Execution ${code} does not exist on the target part`,
        [
          {
            field: 'targetMakeCode',
            message: `Execution ${code} does not exist on the target part`,
            code: 'TARGET_MAKE_NOT_FOUND',
          },
        ],
      )
    }
    if (!make.active) {
      throw new ValidationError(`Execution ${code} is inactive`, [
        {
          field: 'targetMakeCode',
          message: `Execution ${code} is inactive`,
          code: 'TARGET_MAKE_INACTIVE',
        },
      ])
    }
    return make.code
  }

  /**
   * An edge is identified by (sourceId, targetId, relationshipType, option,
   * targetMakeCode) and, on a BOM line, its reference designators — the
   * `item_relationships_edge_unique` index. The same child at R1 and at R2,
   * or under two different conditions, is two lines. Two BOM lines naming
   * the same child with the same designators (or none) and the same
   * condition are the *same* edge, however their find numbers differ, and
   * the quantity has to be aggregated onto one line. Callers use this to say
   * so before the database does, because the driver's answer is a wall of
   * SQL.
   */
  static edgeKey(edge: {
    sourceId: string
    targetId: string
    relationshipType: string
    option?: OptionCondition | null
    targetMakeCode?: string | null
    referenceDesignator?: string | null
  }): string {
    // NUL separates: it cannot occur in a uuid, a relationship type or the
    // canonical JSON of a condition, so no pair of distinct tuples can
    // collide on the joined string. A fixed line contributes ''.
    return [
      edge.sourceId,
      edge.targetId,
      edge.relationshipType,
      optionConditionKey(edge.option),
      edge.targetMakeCode?.toUpperCase() ?? '',
      referenceDesignatorKey(edge.relationshipType, edge.referenceDesignator),
    ].join('\u0000')
  }

  /**
   * Report every edge in `edges` that repeats an earlier one, as
   * `{ index, firstIndex }` into the array as given. Index-preserving on
   * purpose: the caller reports which *request line* is at fault, and the
   * original bug was blaming the first line of the batch for a collision on a
   * later one.
   */
  static findDuplicateEdges<
    T extends {
      sourceId: string
      targetId: string
      relationshipType: string
      option?: OptionCondition | null
      targetMakeCode?: string | null
      referenceDesignator?: string | null
    },
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
   * A part that has just been nested under a parent in its own design is no
   * longer a top-level part of that design's structure: clear its
   * designation, so that removing the line later leaves it among the design's
   * non-structure items instead of promoting it to a root nobody chose.
   *
   * Only rows the edit may reach are written. On main — the pre-release
   * phase, where the parent is a main row — the target is a main row too and
   * is cleared. On a change-order or workspace branch the target is cleared
   * only when it is that branch's own working copy; a main row nested by a
   * branch is left alone here, since main has not changed, and the merge
   * clears it when the line is released (ChangeOrderMergeService, step 5b).
   * A plain checkout tracks the shared main row with no change type, so a
   * row counts as the branch's own only when its tracking row records one.
   */
  static async clearDesignationOfNestedTargets(
    edges: Array<{
      sourceId: string
      targetId: string
      relationshipType: string
    }>,
    tx?: TransactionClient,
  ): Promise<void> {
    const executor = tx ?? db
    const bomEdges = edges.filter((e) => e.relationshipType === 'BOM')
    if (bomEdges.length === 0) return

    const ids = [...new Set(bomEdges.flatMap((e) => [e.sourceId, e.targetId]))]
    const rows = await executor
      .select({
        id: items.id,
        itemType: items.itemType,
        designId: items.designId,
        inDesignStructure: items.inDesignStructure,
      })
      .from(items)
      .where(inArray(items.id, ids))
    const byId = new Map(rows.map((r) => [r.id, r]))

    const branchOf = new Map<string, string>()
    const tracked = await executor
      .select({
        itemId: branchItems.currentItemId,
        branchId: branchItems.branchId,
        changeType: branchItems.changeType,
      })
      .from(branchItems)
      .innerJoin(branches, eq(branchItems.branchId, branches.id))
      .where(
        and(
          inArray(branchItems.currentItemId, ids),
          inArray(branches.branchType, [
            BRANCH_TYPES.changeOrder,
            BRANCH_TYPES.workspace,
          ]),
          eq(branches.isArchived, false),
        ),
      )
    for (const t of tracked) {
      if (t.itemId && t.changeType !== null) branchOf.set(t.itemId, t.branchId)
    }

    const toClear = new Set<string>()
    for (const edge of bomEdges) {
      const source = byId.get(edge.sourceId)
      const target = byId.get(edge.targetId)
      if (!source || !target) continue
      if (target.itemType !== 'Part' || !target.inDesignStructure) continue
      if (!target.designId || target.designId !== source.designId) continue
      const sourceBranch = branchOf.get(source.id)
      const targetBranch = branchOf.get(target.id)
      const writable = sourceBranch
        ? targetBranch === sourceBranch
        : targetBranch === undefined
      if (writable) toClear.add(target.id)
    }
    if (toClear.size === 0) return

    await executor
      .update(items)
      .set({ inDesignStructure: false })
      .where(inArray(items.id, [...toClear]))
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

    // A trace claim's affirmation names the row it was made on. Copied off a
    // released row — a checkout — it stays naming that row, so the copy reads
    // suspect on the branch until the person changing the item affirms it
    // (items/trace-affirmation.ts). Copied off a working copy, the new row
    // continues the same branch edit: a rebase or a pull from main that
    // mints a fresh working copy must not turn an affirmation made on the
    // previous one stale again, so it follows the edge onto the new row.
    //
    // A claim that predates affirmations is read as affirmed by its author
    // against the rows it names. A checkout writes that reading onto the
    // copy — the released row it is copied from, by the edge's author, when
    // the edge was made — so the copy is suspect on the branch like any
    // other, instead of a revision that silently skips the one check the
    // flag exists for. Main's own rows are left as they are.
    const [source] = await executor
      .select({ revision: items.revision })
      .from(items)
      .where(eq(items.id, sourceItemId))
      .limit(1)
    const continuesWorkingCopy =
      source !== undefined && isWorkingRevisionValue(source.revision)
    const metadataFor = (rel: {
      relationshipType: string
      targetId: string
      metadata: unknown
      createdBy: string | null
      createdAt: Date
    }) => {
      if (continuesWorkingCopy) {
        return carryAffirmation(rel.metadata, {
          fromSourceId: sourceItemId,
          toSourceId: targetItemId,
          resolveTarget: (targetId) => targetId,
        })
      }
      if (!isSuspectable(rel.relationshipType) || affirmationOf(rel.metadata)) {
        return rel.metadata
      }
      return withAffirmation(rel.metadata, {
        sourceId: sourceItemId,
        targetId: rel.targetId,
        affirmedBy: rel.createdBy ?? userId,
        affirmedAt: rel.createdAt.toISOString(),
      })
    }

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
          metadata: metadataFor(rel),
          option: rel.option,
          targetMakeCode: rel.targetMakeCode,
          ...carriedEdgeColumns(rel),
          createdBy: userId,
        })),
      )
      .onConflictDoNothing()

    // A cached thread of either item's lineage read these edges on the old
    // row; the copy is a new version row the branch now answers with.
    ThreadCacheService.invalidateForItemsSoon([sourceItemId, targetItemId])
  }

  /**
   * `DECOMPOSES` is a tree. Refuse an edge that would close a loop: a child
   * that is the parent itself, or a parent already somewhere beneath the
   * child. Walked by master over every version row, so a loop that would
   * exist on any branch is refused — conservative on purpose: an
   * architecture that is a tree on main and a loop on a branch could not
   * merge into anything coherent. The design's architecture read breaks a
   * loop that reached the store anyway, so the view stays a forest.
   */
  private static async assertNoDecompositionCycle(
    relationshipType: string,
    source: PersistedItem | null,
    target: PersistedItem | null,
  ): Promise<void> {
    if (relationshipType !== DECOMPOSES_RELATIONSHIP || !source || !target) {
      return
    }
    const refuse = (why: string): never => {
      throw new ValidationError(why, [{ field: 'targetId', message: why }])
    }
    if (source.masterId === target.masterId) {
      refuse(`${source.itemNumber} cannot decompose into itself`)
    }
    const visited = new Set<string>([target.masterId])
    let frontier = [target.masterId]
    while (frontier.length > 0) {
      const rows = await db
        .select({ id: items.id })
        .from(items)
        .where(inArray(items.masterId, frontier))
      if (rows.length === 0) break
      const edges = await db
        .select({ targetId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(
          and(
            inArray(
              itemRelationships.sourceId,
              rows.map((row) => row.id),
            ),
            eq(itemRelationships.relationshipType, DECOMPOSES_RELATIONSHIP),
          ),
        )
      if (edges.length === 0) break
      const descendants = await db
        .select({ masterId: items.masterId })
        .from(items)
        .where(
          inArray(items.id, [...new Set(edges.map((edge) => edge.targetId))]),
        )
      frontier = []
      for (const row of descendants) {
        if (row.masterId === source.masterId) {
          refuse(
            `${source.itemNumber} already sits beneath ${target.itemNumber}; ` +
              `decomposing ${target.itemNumber} under it would close a loop`,
          )
        }
        if (!visited.has(row.masterId)) {
          visited.add(row.masterId)
          frontier.push(row.masterId)
        }
      }
    }
  }

  /**
   * Ends of a cataloged edge type must be the item types the catalog names.
   * A `SATISFIES` stored requirement → part is not a different claim, it is a
   * claim no reader finds, and the new-relationship dialog used to let one
   * through. User-defined types are not cataloged and are not policed.
   */
  private static assertCatalogEnds(
    relationshipType: string,
    source: { itemType: string } | null,
    target: { itemType: string } | null,
  ): void {
    if (!source || !target) return
    const mismatch = catalogEndMismatch(
      relationshipType,
      source.itemType,
      target.itemType,
    )
    if (mismatch) {
      throw new ValidationError(mismatch, [
        { field: 'relationshipType', message: mismatch },
      ])
    }
  }

  /**
   * Add a relationship between items
   *
   * Relationship changes are content edits of the SOURCE item (its BOM /
   * reference structure), so they run through the same edit-lock policy as
   * field updates: requireContentEditable throws unless the caller may edit
   * the source item right now. System flows (materialization, import) that
   * manage their own consistency pass options.bypassEditGuard.
   *
   * `data.metadata` is the caller's own keys; a reserved key in it is dropped
   * (see `items/relationships/metadata.ts` in commons).
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
      metadata?: Record<string, unknown> | null
      option?: OptionCondition | null
      targetMakeCode?: string | null
    },
    options?: { bypassEditGuard?: boolean },
  ): Promise<typeof itemRelationships.$inferSelect> {
    // Lazy import to avoid circular dependency
    const { ItemService } = await import('./ItemService')

    const option = await this.normalizeOption(
      sourceId,
      relationshipType,
      data?.option,
    )
    const targetMakeCode = await this.normalizeTargetMake(
      targetId,
      relationshipType,
      data?.targetMakeCode,
    )
    const referenceDesignator = normalizeReferenceDesignator(
      data?.referenceDesignator,
    )

    const sourceItem = await ItemService.findById(sourceId)
    // Read before the transaction so the emit inside it has both ends. The
    // history block below re-reads the target; this is the same row.
    const targetItemForEvent = await ItemService.findById(targetId)
    this.assertCatalogEnds(relationshipType, sourceItem, targetItemForEvent)
    await this.assertNoDecompositionCycle(
      relationshipType,
      sourceItem,
      targetItemForEvent,
    )
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
          option
            ? eq(itemRelationships.option, option)
            : isNull(itemRelationships.option),
          targetMakeCode
            ? eq(itemRelationships.targetMakeCode, targetMakeCode)
            : isNull(itemRelationships.targetMakeCode),
          referenceDesignatorMatches(relationshipType, referenceDesignator),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      throw relationshipExistsError(
        sourceId,
        targetId,
        relationshipType,
        referenceDesignator,
      )
    }

    let relationship: typeof itemRelationships.$inferSelect
    try {
      relationship = await db.transaction(async (tx) => {
        const inserted = takeFirst(
          await tx
            .insert(itemRelationships)
            .values({
              sourceId,
              targetId,
              relationshipType,
              quantity: data?.quantity,
              referenceDesignator,
              findNumber: data?.findNumber,
              // A trace claim is born affirmed by its author, against the
              // rows it names — see items/trace-affirmation.ts.
              metadata: stampInitialAffirmation(
                userMetadataOf(data?.metadata),
                { sourceId, targetId, relationshipType },
                userId,
              ),
              option,
              targetMakeCode,
              createdBy: userId,
            })
            .returning(),
        )
        // In the same transaction as the line: a part nested by an edge that
        // landed without this would keep its top-level designation, and
        // resurface as a root the day the line is removed.
        await this.clearDesignationOfNestedTargets([inserted], tx)

        // A verification link changes what the requirement's derived status
        // is computed from, whichever path wrote the edge.
        if (
          relationshipType === VERIFIED_BY_RELATIONSHIP &&
          targetItemForEvent
        ) {
          await rollupVerificationForMasters(
            tx,
            [targetItemForEvent.masterId],
            { actorId: userId, cause: 'link', testCaseId: sourceId },
          )
        }

        // A BOM edit produced a commit and zero events, which made structure
        // the largest class of engineering change completely invisible on the
        // bus — `ItemService.update` is not involved, so the parent's own
        // `item.updated` does not fire either.
        if (sourceItem && targetItemForEvent) {
          await publishDomainEvent(tx, RELATIONSHIP_ADDED, {
            actorId: userId,
            subject: { id: sourceId, masterId: sourceItem.masterId },
            context: { designId: sourceItem.designId ?? undefined },
            payload: structurePayload(inserted, sourceItem, targetItemForEvent),
          })
        }

        return inserted
      })
    } catch (error) {
      // The check above is not a lock; a concurrent insert still lands here.
      if (isUniqueViolation(error, { table: 'item_relationships' })) {
        throw relationshipExistsError(
          sourceId,
          targetId,
          relationshipType,
          referenceDesignator,
        )
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
                        referenceDesignator,
                        targetMakeCode,
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
        option?: OptionCondition | null
        targetMakeCode?: string | null
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

    // Canonical conditions first, so the duplicate check below and the
    // partial unique index agree on what "the same line" is.
    for (const r of relationships) {
      r.data ??= {}
      r.data.option = await this.normalizeOption(
        r.sourceId,
        r.relationshipType,
        r.data.option,
      )
      r.data.targetMakeCode = await this.normalizeTargetMake(
        r.targetId,
        r.relationshipType,
        r.data.targetMakeCode,
      )
      r.data.referenceDesignator =
        normalizeReferenceDesignator(r.data.referenceDesignator) ?? undefined
    }
    const withOption = relationships.map((r) => ({
      ...r,
      option: r.data?.option ?? null,
      targetMakeCode: r.data?.targetMakeCode ?? null,
      referenceDesignator: r.data?.referenceDesignator ?? null,
    }))

    // Duplicates inside the batch collide with each other, not with anything
    // stored, so no amount of replacing saves them. Reject before writing.
    const duplicates = this.findDuplicateEdges(withOption)
    if (duplicates.length > 0) {
      throw new ValidationError(
        'A relationship may appear only once per source, target, type, ' +
          'option condition, target execution and (on a BOM line) reference ' +
          'designators',
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

    // A cataloged type's ends are policed whether or not the edit guard is
    // bypassed: a system flow writing a trace edge backwards is no better.
    const endTypes = new Map<string, PersistedItem | null>()
    const endType = async (id: string): Promise<PersistedItem | null> => {
      if (!endTypes.has(id)) endTypes.set(id, await ItemService.findById(id))
      return endTypes.get(id) ?? null
    }
    for (const rel of relationships) {
      const source = await endType(rel.sourceId)
      const target = await endType(rel.targetId)
      this.assertCatalogEnds(rel.relationshipType, source, target)
      await this.assertNoDecompositionCycle(
        rel.relationshipType,
        source,
        target,
      )
    }

    // Replace + insert as one unit: either the new structure is in place or
    // the old one never moved.
    let inserted: Array<typeof itemRelationships.$inferSelect>
    try {
      inserted = await db.transaction(async (tx) => {
        const cleared: Array<typeof itemRelationships.$inferSelect> = []
        if (options?.replaceExisting) {
          const typesBySource = new Map<string, Set<string>>()
          for (const rel of relationships) {
            const types = typesBySource.get(rel.sourceId) ?? new Set<string>()
            types.add(rel.relationshipType)
            typesBySource.set(rel.sourceId, types)
          }

          for (const [sourceId, types] of typesBySource) {
            cleared.push(
              ...(await tx
                .delete(itemRelationships)
                .where(
                  and(
                    eq(itemRelationships.sourceId, sourceId),
                    inArray(itemRelationships.relationshipType, [...types]),
                  ),
                )
                .returning()),
            )
          }
        }

        const rows = await tx
          .insert(itemRelationships)
          .values(
            relationships.map((r) => ({
              sourceId: r.sourceId,
              targetId: r.targetId,
              relationshipType: r.relationshipType,
              quantity: r.data?.quantity ?? null,
              referenceDesignator: r.data?.referenceDesignator ?? null,
              findNumber: r.data?.findNumber ?? null,
              // Caller keys only: a reserved key in a line's metadata would
              // otherwise land verbatim on any edge type that is not stamped.
              metadata: stampInitialAffirmation(
                userMetadataOf(r.data?.metadata),
                r,
                r.userId,
              ),
              option: r.data?.option ?? null,
              targetMakeCode: r.data?.targetMakeCode ?? null,
              createdBy: r.userId,
            })),
          )
          .returning()
        await this.clearDesignationOfNestedTargets(rows, tx)

        // Verification links written or replaced here move the derived
        // status of the requirements they point at, as the single path does.
        const verifiedTargets = [...cleared, ...rows]
          .filter((edge) => edge.relationshipType === VERIFIED_BY_RELATIONSHIP)
          .map((edge) => edge.targetId)
        if (verifiedTargets.length > 0) {
          const targetRows = await tx
            .select({ masterId: items.masterId })
            .from(items)
            .where(inArray(items.id, [...new Set(verifiedTargets)]))
          await rollupVerificationForMasters(
            tx,
            targetRows.map((row) => row.masterId),
            { actorId: relationships[0]?.userId ?? null, cause: 'link' },
          )
        }

        // The batch records what the one-at-a-time mutators record: each edge
        // a replacement cleared, then each edge written. An edge replaced by
        // an identical one is both, since it is a new row. This path used to
        // record nothing at all.
        const actorBySource = new Map(
          relationships.map((rel) => [rel.sourceId, rel.userId]),
        )
        const actorByEdge = new Map(
          relationships.map((rel) => [
            `${rel.sourceId}:${rel.targetId}:${rel.relationshipType}`,
            rel.userId,
          ]),
        )
        await publishStructureEdges(
          tx,
          RELATIONSHIP_REMOVED,
          cleared.map((edge) => ({
            edge,
            actorId: actorBySource.get(edge.sourceId) ?? null,
          })),
        )
        await publishStructureEdges(
          tx,
          RELATIONSHIP_ADDED,
          rows.map((edge) => ({
            edge,
            actorId:
              actorByEdge.get(
                `${edge.sourceId}:${edge.targetId}:${edge.relationshipType}`,
              ) ?? null,
          })),
        )
        return rows
      })
    } catch (error) {
      // Which edge collided is in the driver's `detail`, but its `message` is
      // the whole INSERT with every bound parameter. Report neither.
      if (isUniqueViolation(error, { table: 'item_relationships' })) {
        throw new ValidationError(
          'One or more relationships already exist (a child may repeat on a ' +
            'parent only under a different option condition, target ' +
            'execution or, on a BOM line, reference designators)',
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
              referenceDesignator: rel.data?.referenceDesignator,
              targetMakeCode: rel.data?.targetMakeCode,
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

    // The delete and its fact commit together. The best-effort commit below
    // stays **outside** this transaction deliberately: the event's contract is
    // that the edge is gone if and only if the event exists, while history's
    // contract is already warn-and-continue — folding it in would turn a
    // history failure into a rolled-back BOM edit, which is a regression sold
    // as a fix.
    const targetItemForEvent = await ItemService.findById(relationship.targetId)
    await db.transaction(async (tx) => {
      await tx
        .delete(itemRelationships)
        .where(eq(itemRelationships.id, relationshipId))

      // A verification link removed changes what the requirement's derived
      // status is computed from, whichever path removed it.
      if (
        relationship.relationshipType === VERIFIED_BY_RELATIONSHIP &&
        targetItemForEvent
      ) {
        await rollupVerificationForMasters(tx, [targetItemForEvent.masterId], {
          actorId: userId,
          cause: 'unlink',
          testCaseId: relationship.sourceId,
        })
      }

      // The payload carries the values the edge *had*: a consumer reacting to
      // a removal needs to know what was removed, and by then there is nothing
      // left to look up.
      if (sourceItem && targetItemForEvent) {
        await publishDomainEvent(tx, RELATIONSHIP_REMOVED, {
          actorId: userId,
          subject: {
            id: relationship.sourceId,
            masterId: sourceItem.masterId,
          },
          context: { designId: sourceItem.designId ?? undefined },
          payload: structurePayload(
            relationship,
            sourceItem,
            targetItemForEvent,
          ),
        })
      }
    })

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
                          referenceDesignator: relationship.referenceDesignator,
                          targetMakeCode: relationship.targetMakeCode,
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
   * Update a relationship's properties (quantity, referenceDesignator,
   * findNumber, metadata, option and targetMakeCode). `option: null` makes the
   * line fixed again; `targetMakeCode: null` removes the execution pin.
   *
   * `metadata` replaces the caller's keys as a whole — an object is the new
   * set, `null` clears them — and never touches a reserved key: a trace
   * claim's affirmation survives any metadata edit, and cannot be forged or
   * erased through one (see `items/relationships/metadata.ts` in commons).
   */
  static async updateRelationship(
    relationshipId: string,
    userId: string,
    data: {
      quantity?: string | null
      referenceDesignator?: string | null
      findNumber?: number | null
      metadata?: Record<string, unknown> | null
      option?: OptionCondition | null
      targetMakeCode?: string | null
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

    const option =
      data.option === undefined
        ? undefined
        : await this.normalizeOption(
            existing.sourceId,
            existing.relationshipType,
            data.option,
          )
    const targetMakeCode =
      data.targetMakeCode === undefined
        ? undefined
        : await this.normalizeTargetMake(
            existing.targetId,
            existing.relationshipType,
            data.targetMakeCode,
          )
    const metadata =
      data.metadata === undefined
        ? undefined
        : withUserMetadata(existing.metadata, data.metadata)
    const referenceDesignator =
      data.referenceDesignator === undefined
        ? undefined
        : normalizeReferenceDesignator(data.referenceDesignator)
    const nextOption = option === undefined ? existing.option : option
    const nextTargetMakeCode =
      targetMakeCode === undefined ? existing.targetMakeCode : targetMakeCode
    const nextReferenceDesignator =
      referenceDesignator === undefined
        ? existing.referenceDesignator
        : referenceDesignator
    if (
      optionConditionKey(nextOption) !== optionConditionKey(existing.option) ||
      nextTargetMakeCode !== existing.targetMakeCode ||
      referenceDesignatorKey(
        existing.relationshipType,
        nextReferenceDesignator,
      ) !==
        referenceDesignatorKey(
          existing.relationshipType,
          existing.referenceDesignator,
        )
    ) {
      // Changing the condition or the designators can collide with a sibling
      // line on the same child; say so before the index does.
      const collision = await db
        .select({ id: itemRelationships.id })
        .from(itemRelationships)
        .where(
          and(
            ne(itemRelationships.id, existing.id),
            eq(itemRelationships.sourceId, existing.sourceId),
            eq(itemRelationships.targetId, existing.targetId),
            eq(itemRelationships.relationshipType, existing.relationshipType),
            nextOption
              ? eq(itemRelationships.option, nextOption)
              : isNull(itemRelationships.option),
            nextTargetMakeCode
              ? eq(itemRelationships.targetMakeCode, nextTargetMakeCode)
              : isNull(itemRelationships.targetMakeCode),
            referenceDesignatorMatches(
              existing.relationshipType,
              nextReferenceDesignator,
            ),
          ),
        )
        .limit(1)
      if (collision.length > 0) {
        throw relationshipExistsError(
          existing.sourceId,
          existing.targetId,
          existing.relationshipType,
          nextReferenceDesignator,
        )
      }
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
    if (referenceDesignator !== undefined)
      updateData.referenceDesignator = referenceDesignator
    if (data.findNumber !== undefined) updateData.findNumber = data.findNumber
    if (metadata !== undefined) updateData.metadata = metadata
    if (option !== undefined) updateData.option = option
    if (targetMakeCode !== undefined) updateData.targetMakeCode = targetMakeCode

    // Which of the line's properties actually changed, hoisted above the
    // write. The commit's own comparison below is computed two guards deep —
    // inside a design *and* a branch resolution that does not run for an edge
    // whose source has no design — so the event needs its own, available to
    // both.
    const metadataChanged =
      metadata !== undefined && !sameUserMetadata(existing.metadata, metadata)
    const changedFields = (
      [
        ['quantity', existing.quantity, data.quantity],
        [
          'referenceDesignator',
          existing.referenceDesignator,
          referenceDesignator,
        ],
        ['findNumber', existing.findNumber, data.findNumber],
        [
          'option',
          optionConditionKey(existing.option),
          option === undefined ? undefined : optionConditionKey(option),
        ],
        ['targetMakeCode', existing.targetMakeCode, targetMakeCode],
      ] as const
    )
      .filter(([, before, after]) => after !== undefined && before !== after)
      .map(([field]): string => field)
    // A JSON document, so compared by content rather than by reference.
    if (metadataChanged) changedFields.push('metadata')

    const sourceItem = await ItemService.findById(existing.sourceId)
    const targetItem = await ItemService.findById(existing.targetId)

    const updated = await db.transaction(async (tx) => {
      let row: typeof itemRelationships.$inferSelect | undefined
      try {
        ;[row] = await tx
          .update(itemRelationships)
          .set(updateData)
          .where(eq(itemRelationships.id, relationshipId))
          .returning()
      } catch (error) {
        // Changing the condition or the designators can collide with a
        // sibling line on the same child; translate the index's refusal.
        if (isUniqueViolation(error, { table: 'item_relationships' })) {
          throw relationshipExistsError(
            existing.sourceId,
            existing.targetId,
            existing.relationshipType,
            nextReferenceDesignator,
          )
        }
        throw error
      }

      if (!row) {
        throw new NotFoundError('ItemRelationship', relationshipId)
      }

      // Nothing changed is not an edit, and the payload schema forbids an
      // empty `changedFields` anyway.
      if (changedFields.length > 0 && sourceItem && targetItem) {
        await publishDomainEvent(tx, RELATIONSHIP_UPDATED, {
          actorId: userId,
          subject: { id: existing.sourceId, masterId: sourceItem.masterId },
          context: { designId: sourceItem.designId ?? undefined },
          payload: {
            ...structurePayload(row, sourceItem, targetItem),
            changedFields: [...changedFields],
          },
        })
      }

      return row
    })

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
            targetMakeCode !== undefined &&
            existing.targetMakeCode !== targetMakeCode
          ) {
            fieldChanges.push({
              fieldName: `bom_target_execution_changed`,
              fieldPath: `relationships.${existing.relationshipType}`,
              oldValue: {
                targetItemNumber: targetLabel,
                targetMakeCode: existing.targetMakeCode,
              },
              newValue: {
                targetItemNumber: targetLabel,
                targetMakeCode,
              },
              fieldCategory: 'relationship',
            })
          }

          if (
            referenceDesignator !== undefined &&
            existing.referenceDesignator !== referenceDesignator
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
                referenceDesignator,
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

          // The caller's keys only, on both sides: the reserved ones did not
          // change, and an affirmation in a diff would read as if they had.
          if (metadataChanged) {
            fieldChanges.push({
              fieldName: `bom_metadata_changed`,
              fieldPath: `relationships.${existing.relationshipType}`,
              oldValue: {
                targetItemNumber: targetLabel,
                metadata: userMetadataOf(existing.metadata),
              },
              newValue: {
                targetItemNumber: targetLabel,
                metadata: userMetadataOf(metadata),
              },
              fieldCategory: 'relationship',
            })
          }

          if (
            option !== undefined &&
            optionConditionKey(option) !== optionConditionKey(existing.option)
          ) {
            fieldChanges.push({
              fieldName: `bom_option_changed`,
              fieldPath: `relationships.${existing.relationshipType}`,
              oldValue: {
                targetItemNumber: targetLabel,
                option: existing.option,
              },
              newValue: {
                targetItemNumber: targetLabel,
                option,
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
