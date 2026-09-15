// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { NotFoundError } from '../errors'
import { db } from '../db'
import { branchItems } from '../db/schema'
import {
  changeOrderDesigns,
  itemRelationships,
  items,
} from '../db/schema/items'
import { designs } from '../db/schema/designs'
import { CrossDesignReferenceService } from './CrossDesignReferenceService'
import { DesignService } from './DesignService'
import { VersionResolver } from './VersionResolver'
import type { OptionCondition } from '@/lib/types/variants'
import type { VersionContext } from './VersionResolver'
import type { BOMTreeNode, OrphanItem } from '@/lib/types/bom'
import { optionConditionKey } from '@/lib/types/variants'

// The tree this service builds is the same shape the design-structure endpoint
// builds and the BOM components render, so it is declared once in lib/types.
export type { BOMTreeNode, OrphanItem }

export interface ChangeOrderDesignStructure {
  roots: Array<BOMTreeNode>
  orphans: Array<OrphanItem>
  affectedItemIds: Array<string>
  ecoBranch: {
    id: string | null
    mergeStatus: string | null
    itemsAffected: number
  } | null
  design: {
    id: string
    name: string
    description: string | null
  }
  versionContext: {
    type: VersionContext['type']
    isHistorical: boolean
    mergedAt: Date | null
  }
}

/** How far cross-design BOM expansion will chase children before giving up. */
const MAX_EXPANSION_DEPTH = 10

type ExternalItem = typeof items.$inferSelect & {
  designCode?: string | null
  designName?: string | null
}

type BomRelationship = {
  rel: typeof itemRelationships.$inferSelect
  sourceMasterId: string
}

/**
 * Builds the version-resolved BOM tree a change order shows for one design.
 *
 * This lived inside the `GET /:id/designs/:designId/structure` handler, where
 * it could not be reused by the impact panel or the comparison views that want
 * the same tree, and could not be tested without going through HTTP. Nothing
 * about it is HTTP-shaped.
 */
export class ChangeOrderStructureService {
  /**
   * Resolve the version context for every design this change order touches.
   *
   * The map matters as much as the single context: a BOM edge can cross into
   * another design that the same change order is also changing, and that target
   * must resolve at *its* design's vantage point, not this one's.
   */
  private static resolveDesignContexts(
    allChangeOrderDesigns: Array<typeof changeOrderDesigns.$inferSelect>,
  ): Map<string, VersionContext> {
    const contexts = new Map<string, VersionContext>()
    for (const changeOrderDesign of allChangeOrderDesigns) {
      if (
        changeOrderDesign.mergeStatus === 'merged' &&
        changeOrderDesign.mergeCommitId
      ) {
        contexts.set(changeOrderDesign.designId, {
          type: 'commit',
          commitId: changeOrderDesign.mergeCommitId,
        })
      } else if (changeOrderDesign.branchId) {
        contexts.set(changeOrderDesign.designId, {
          type: 'branch',
          branchId: changeOrderDesign.branchId,
        })
      } else {
        contexts.set(changeOrderDesign.designId, {
          type: 'released',
          designId: changeOrderDesign.designId,
        })
      }
    }
    return contexts
  }

  /** Code and name for a set of designs, for labelling cross-design nodes. */
  private static async loadDesignInfo(
    designIds: Iterable<string>,
  ): Promise<Map<string, { code: string | null; name: string }>> {
    const ids = [...new Set(designIds)]
    const infoMap = new Map<string, { code: string | null; name: string }>()
    if (ids.length === 0) return infoMap

    const rows = await db
      .select({ id: designs.id, code: designs.code, name: designs.name })
      .from(designs)
      .where(inArray(designs.id, ids))
    for (const d of rows) {
      infoMap.set(d.id, { code: d.code, name: d.name })
    }
    return infoMap
  }

  /** BOM edges out of any revision of the given master items. */
  private static async loadBomRelationshipsByMasterId(
    masterIds: Array<string>,
  ): Promise<Array<BomRelationship>> {
    if (masterIds.length === 0) return []
    return db
      .select({ rel: itemRelationships, sourceMasterId: items.masterId })
      .from(itemRelationships)
      .innerJoin(items, eq(itemRelationships.sourceId, items.id))
      .where(
        and(
          inArray(items.masterId, masterIds),
          eq(itemRelationships.relationshipType, 'BOM'),
        ),
      )
  }

  /**
   * Keep only the BOM lines the revision in view owns.
   *
   * `loadBomRelationshipsByMasterId` deliberately reaches across every revision
   * sharing a masterId, because a line's *target* may name a superseded
   * revision and the resolution below re-points it. But a version's own rows
   * ARE its structure — the rule the merge applies at release and the branch
   * BOM reader applies when a part is opened — and every step that mints a
   * version row carries the source's lines onto it (copyRelationshipsToItem),
   * so a version with no rows has an emptied structure, not a missing one.
   *
   * Without this every superseded revision's lines are unioned in, and
   * resolving their targets at context collapses them onto the same items: a
   * child that has itself been revised appears once per distinct revision the
   * parent's history named, and a line a later revision dropped comes back.
   * There is deliberately no fallback to other versions' rows when the
   * revision in view owns none: that fallback resurrected a line deleted on
   * the branch the moment it was the last one. A master this view did not
   * resolve keeps its edges, since there is no version to hold them against.
   */
  private static keepLinesOwnedByVersionInView(
    relationships: Array<BomRelationship>,
    resolvedIdByMasterId: Map<string, string>,
  ): Array<BomRelationship> {
    return relationships.filter((r) => {
      const resolvedId = resolvedIdByMasterId.get(r.sourceMasterId)
      return resolvedId === undefined || resolvedId === r.rel.sourceId
    })
  }

  static async getDesignStructure(
    changeOrderId: string,
    designId: string,
    options: { expandExternal?: boolean } = {},
  ): Promise<ChangeOrderDesignStructure> {
    const { expandExternal = true } = options

    const design = await DesignService.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId)
    }

    // ALL associations, not just this design's — multi-design change orders
    // need every vantage point to resolve cross-design edges.
    const allChangeOrderDesigns = await db
      .select()
      .from(changeOrderDesigns)
      .where(eq(changeOrderDesigns.changeOrderId, changeOrderId))

    const changeOrderDesignAssoc = allChangeOrderDesigns.find(
      (ed) => ed.designId === designId,
    )

    const changeOrderDesignContexts = this.resolveDesignContexts(
      allChangeOrderDesigns,
    )
    // This design's own context, resolved by the same rules
    const versionContext: VersionContext = changeOrderDesignContexts.get(
      designId,
    ) ?? {
      type: 'released',
      designId,
    }

    // Items already on the change order, matched by both id and masterId — a
    // revised item's branch version has a different id than the row recorded
    // when it was added.
    const affectedItems =
      await ChangeOrderService.getAffectedItems(changeOrderId)
    const affectedItemIds = new Set(
      affectedItems
        .map((a) => a.affectedItemId)
        .filter((id): id is string => Boolean(id)),
    )
    const affectedItemMasterIds = new Set(
      affectedItems
        .map((a) => a.affectedItemMasterId)
        .filter((id): id is string => Boolean(id)),
    )
    const changeActionMap = new Map<string, string>()
    const changeActionByMasterIdMap = new Map<string, string>()
    for (const ai of affectedItems) {
      if (ai.affectedItemId) {
        changeActionMap.set(ai.affectedItemId, ai.changeAction)
      }
      if (ai.affectedItemMasterId) {
        changeActionByMasterIdMap.set(ai.affectedItemMasterId, ai.changeAction)
      }
    }

    // Counted from the rows already loaded above, by the same function
    // `getSummary` uses — this used to run its own query against the same
    // table for a number it was holding the data to compute.
    const changeOrderBranch = changeOrderDesignAssoc
      ? {
          id: changeOrderDesignAssoc.branchId,
          mergeStatus: changeOrderDesignAssoc.mergeStatus,
          itemsAffected:
            ChangeOrderService.countAffectedItemsByDesign(
              affectedItems,
            ).byDesign.get(designId) ?? 0,
        }
      : null

    // For Library designs, also track items changed on the ECO branch
    const branchChangedMasterIds = new Set<string>()
    if (design.designType === 'Library' && changeOrderDesignAssoc?.branchId) {
      const changedItems = await db
        .select({ itemMasterId: branchItems.itemMasterId })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, changeOrderDesignAssoc.branchId),
            isNotNull(branchItems.changeType),
          ),
        )
      for (const item of changedItems) {
        branchChangedMasterIds.add(item.itemMasterId)
      }
    }

    const { items: contextItems } = await VersionResolver.getItemsAtContext(
      designId,
      versionContext,
    )

    const allItems = contextItems.map((i) => ({
      id: i.id,
      masterId: i.masterId,
      itemNumber: i.itemNumber,
      name: i.name,
      revision: i.revision,
      state: i.state,
      itemType: i.itemType,
      designId: i.designId,
      inDesignStructure: i.inDesignStructure,
    }))

    const itemIds = allItems.map((i) => i.id)
    const masterIds = allItems.map((i) => i.masterId)

    // Query by masterId to catch edges authored on any revision, then narrow
    // to the ones the revision in view owns and resolve targets at context.
    const resolvedIdByMasterId = new Map(
      allItems.map((i) => [i.masterId, i.id]),
    )
    let relationships = this.keepLinesOwnedByVersionInView(
      await this.loadBomRelationshipsByMasterId(masterIds),
      resolvedIdByMasterId,
    )

    const seenRelationships = new Set<string>()
    const uniqueRelationships: Array<BomRelationship> = []
    for (const r of relationships) {
      const key = `${r.sourceMasterId}-${r.rel.targetId}`
      if (!seenRelationships.has(key)) {
        seenRelationships.add(key)
        uniqueRelationships.push(r)
      }
    }
    relationships = uniqueRelationships

    // Targets that live in another design
    const externalTargetIds = relationships
      .map((r) => r.rel.targetId)
      .filter((id) => !itemIds.includes(id))

    let externalItems: Array<ExternalItem> = []

    if (externalTargetIds.length > 0) {
      const resolvedTargets = await VersionResolver.resolveRelationshipTargets(
        externalTargetIds,
        versionContext,
        changeOrderDesignContexts,
      )

      const designInfoMap = await this.loadDesignInfo(
        [...resolvedTargets.values()]
          .map((item) => item.designId)
          .filter((id): id is string => Boolean(id)),
      )

      for (const [, resolved] of resolvedTargets) {
        const designInfo = resolved.designId
          ? designInfoMap.get(resolved.designId)
          : null
        externalItems.push({
          ...resolved,
          designCode: designInfo?.code ?? null,
          designName: designInfo?.name ?? null,
        })
      }
    }

    // Chase external items' own children so a cross-design reference shows its
    // subtree rather than a leaf.
    if (expandExternal && externalItems.length > 0) {
      const allExternalItemIds = new Set(externalItems.map((i) => i.id))
      const allExternalMasterIds = new Set(externalItems.map((i) => i.masterId))
      const allExternalItems = [...externalItems]
      let currentExternalMasterIds = [...externalItems.map((i) => i.masterId)]
      let depth = 0

      while (
        currentExternalMasterIds.length > 0 &&
        depth < MAX_EXPANSION_DEPTH
      ) {
        depth++

        const externalRelationships = this.keepLinesOwnedByVersionInView(
          await this.loadBomRelationshipsByMasterId(currentExternalMasterIds),
          new Map(allExternalItems.map((i) => [i.masterId, i.id])),
        )

        if (externalRelationships.length === 0) break

        const newUniqueRelationships: Array<BomRelationship> = []
        for (const r of externalRelationships) {
          const key = `${r.sourceMasterId}-${r.rel.targetId}`
          if (!seenRelationships.has(key)) {
            seenRelationships.add(key)
            newUniqueRelationships.push(r)
          }
        }

        if (newUniqueRelationships.length === 0) break

        relationships = [...relationships, ...newUniqueRelationships]

        const newExternalTargetIds = newUniqueRelationships
          .map((r) => r.rel.targetId)
          .filter((id) => !itemIds.includes(id) && !allExternalItemIds.has(id))

        if (newExternalTargetIds.length === 0) break

        const newResolvedTargets =
          await VersionResolver.resolveRelationshipTargets(
            newExternalTargetIds,
            versionContext,
            changeOrderDesignContexts,
          )

        const newDesignInfoMap = await this.loadDesignInfo(
          [...newResolvedTargets.values()]
            .map((item) => item.designId)
            .filter((id): id is string => Boolean(id)),
        )

        const newMasterIds: Array<string> = []
        for (const [, resolved] of newResolvedTargets) {
          if (!allExternalMasterIds.has(resolved.masterId)) {
            allExternalMasterIds.add(resolved.masterId)
            allExternalItemIds.add(resolved.id)
            newMasterIds.push(resolved.masterId)

            const designInfo = resolved.designId
              ? newDesignInfoMap.get(resolved.designId)
              : null
            allExternalItems.push({
              ...resolved,
              designCode: designInfo?.code ?? null,
              designName: designInfo?.name ?? null,
            })
          }
        }

        currentExternalMasterIds = newMasterIds
      }

      externalItems = allExternalItems
    }

    const externalDesignMap = new Map(
      externalItems.map((item) => [
        item.id,
        { code: item.designCode, name: item.designName },
      ]),
    )

    const childrenMap = new Map<
      string,
      Array<{
        childId: string
        childMasterId: string
        relationshipId: string
        quantity?: number
        findNumber?: number
        option?: OptionCondition | null
        targetMakeCode?: string | null
      }>
    >()
    const hasParent = new Set<string>()

    // A parent holds one row per child *master*, not per relationship row.
    // Narrowing to the owning revision above removes the common source of a
    // repeat, but the fallback for a version that owns no lines still reaches
    // across revisions, and two of those can name two revisions of one child
    // that resolve to the same item.
    const childKeysBySource = new Map<string, Set<string>>()
    const addChild = (
      sourceMasterId: string,
      child: {
        childId: string
        childMasterId: string
        relationshipId: string
        quantity?: number
        findNumber?: number
        option?: OptionCondition | null
        targetMakeCode?: string | null
      },
    ) => {
      let recorded = childKeysBySource.get(sourceMasterId)
      if (!recorded) {
        recorded = new Set<string>()
        childKeysBySource.set(sourceMasterId, recorded)
      }
      const childKey = [
        child.childMasterId,
        optionConditionKey(child.option),
        child.targetMakeCode ?? '',
      ].join('\u0000')
      if (recorded.has(childKey)) return
      recorded.add(childKey)

      const siblings = childrenMap.get(sourceMasterId)
      if (siblings) {
        siblings.push(child)
      } else {
        childrenMap.set(sourceMasterId, [child])
      }
      hasParent.add(child.childMasterId)
    }

    const localItemById = new Map(allItems.map((i) => [i.id, i]))
    const localItemByMasterId = new Map(allItems.map((i) => [i.masterId, i]))
    const externalItemById = new Map(externalItems.map((i) => [i.id, i]))
    const externalItemByMasterId = new Map(
      externalItems.map((i) => [i.masterId, i]),
    )

    // Targets in neither set: batch their masterIds rather than looking each up
    // inside the children loop.
    const unknownTargetIds: Array<string> = []
    for (const r of relationships) {
      const targetId = r.rel.targetId
      if (!localItemById.has(targetId) && !externalItemById.has(targetId)) {
        unknownTargetIds.push(targetId)
      }
    }

    const unknownTargetMasterIds = new Map<string, string>()
    if (unknownTargetIds.length > 0) {
      const targetLookups = await db
        .select({ id: items.id, masterId: items.masterId })
        .from(items)
        .where(inArray(items.id, unknownTargetIds))
      for (const t of targetLookups) {
        unknownTargetMasterIds.set(t.id, t.masterId)
      }
    }

    for (const r of relationships) {
      const sourceMasterId = r.sourceMasterId
      if (!childrenMap.has(sourceMasterId)) {
        childrenMap.set(sourceMasterId, [])
      }

      const targetId = r.rel.targetId
      let targetMasterId: string | null = null
      let targetItem =
        localItemById.get(targetId) || externalItemById.get(targetId)

      if (targetItem) {
        targetMasterId = targetItem.masterId
      } else {
        targetMasterId = unknownTargetMasterIds.get(targetId) ?? null
        if (targetMasterId) {
          // The edge points at a revision we did not resolve; fall back to
          // whichever revision of that master we did.
          targetItem =
            localItemByMasterId.get(targetMasterId) ||
            externalItemByMasterId.get(targetMasterId)
        }
      }

      if (targetMasterId && targetItem) {
        addChild(sourceMasterId, {
          childId: targetItem.id,
          childMasterId: targetMasterId,
          relationshipId: r.rel.id,
          quantity: r.rel.quantity ? Number(r.rel.quantity) : undefined,
          findNumber: r.rel.findNumber ?? undefined,
          option: r.rel.option ?? null,
          targetMakeCode: r.rel.targetMakeCode ?? null,
        })
      }
    }

    const itemByMasterIdMap = new Map([
      ...allItems.map(
        (i) =>
          [
            i.masterId,
            {
              ...i,
              designCode: undefined as string | undefined,
              designName: undefined as string | undefined,
            },
          ] as const,
      ),
      ...externalItems.map(
        (i) =>
          [
            i.masterId,
            {
              ...i,
              designCode: i.designCode ?? undefined,
              designName: i.designName ?? undefined,
            },
          ] as const,
      ),
    ])

    // Traversal is by masterId, so a node found through two different revisions
    // collapses to one.
    const buildNode = (
      masterId: string,
      visited: Set<string>,
    ): BOMTreeNode | null => {
      if (visited.has(masterId)) return null // Prevent cycles
      const item = itemByMasterIdMap.get(masterId)
      if (!item) return null

      visited.add(masterId)

      const isExternal = item.designId !== designId
      const designInfo = isExternal ? externalDesignMap.get(item.id) : null

      const children = childrenMap.get(masterId) || []
      const childNodes = children
        .map((c) => {
          const node = buildNode(c.childMasterId, new Set(visited))
          if (node) {
            node.quantity = c.quantity
            node.findNumber = c.findNumber
            node.relationshipId = c.relationshipId
            node.option = c.option ?? null
            node.targetMakeCode = c.targetMakeCode ?? null
          }
          return node
        })
        .filter((n): n is BOMTreeNode => n !== null)

      const isInEco =
        affectedItemIds.has(item.id) || affectedItemMasterIds.has(masterId)
      const changeAction =
        changeActionMap.get(item.id) ??
        changeActionByMasterIdMap.get(masterId) ??
        null

      return {
        itemId: item.id,
        masterId, // Include for frontend deduplication across designs
        itemNumber: item.itemNumber,
        name: item.name,
        revision: item.revision,
        state: item.state,
        itemType: item.itemType,
        designId: item.designId,
        isInEco,
        isBranchChanged: branchChangedMasterIds.has(masterId),
        changeAction,
        children: childNodes.length > 0 ? childNodes : undefined,
        designCode: designInfo?.code ?? item.designCode ?? undefined,
        designName: designInfo?.name ?? item.designName ?? undefined,
        isExternal,
      }
    }

    // Cross-design references join the tree as additional roots.
    const crossRefs = await CrossDesignReferenceService.getReferencesForDesign(
      designId,
      changeOrderDesignAssoc?.branchId,
    )

    const crossRefMasterIds = new Set<string>()

    if (crossRefs.length > 0) {
      const crossRefItemIdsToFetch = crossRefs
        .filter((ref) => ref.inDesignStructure !== false)
        .map((ref) => ref.referencedItemId)

      if (crossRefItemIdsToFetch.length > 0) {
        const resolvedCrossRefItems =
          await VersionResolver.resolveRelationshipTargets(
            crossRefItemIdsToFetch,
            versionContext,
            changeOrderDesignContexts,
          )

        const crossRefDesignInfoMap = await this.loadDesignInfo(
          [...resolvedCrossRefItems.values()]
            .map((item) => item.designId)
            .filter((id): id is string => Boolean(id)),
        )

        for (const [, resolvedItem] of resolvedCrossRefItems) {
          crossRefMasterIds.add(resolvedItem.masterId)
          const designInfo = resolvedItem.designId
            ? crossRefDesignInfoMap.get(resolvedItem.designId)
            : null
          itemByMasterIdMap.set(resolvedItem.masterId, {
            ...resolvedItem,
            designCode: designInfo?.code ?? undefined,
            designName: designInfo?.name ?? undefined,
          })
          if (designInfo?.code || designInfo?.name) {
            externalDesignMap.set(resolvedItem.id, {
              code: designInfo.code,
              name: designInfo.name,
            })
          }
        }

        let currentMasterIds = [...crossRefMasterIds]
        const allDiscoveredMasterIds = new Set(crossRefMasterIds)
        let depth = 0

        while (currentMasterIds.length > 0 && depth < MAX_EXPANSION_DEPTH) {
          depth++

          // Query by resolved sourceId rather than masterId here: masterId
          // would pull edges authored on every revision, not the one in view.
          const currentResolvedIds = currentMasterIds
            .map((mid) => itemByMasterIdMap.get(mid)?.id)
            .filter((id): id is string => id !== undefined)

          if (currentResolvedIds.length === 0) break

          const childRels = await db
            .select({ rel: itemRelationships, sourceMasterId: items.masterId })
            .from(itemRelationships)
            .innerJoin(items, eq(itemRelationships.sourceId, items.id))
            .where(
              and(
                inArray(itemRelationships.sourceId, currentResolvedIds),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          if (childRels.length === 0) break

          const newTargetIds: Array<string> = []
          for (const r of childRels) {
            const key = `${r.sourceMasterId}-${r.rel.targetId}`
            if (seenRelationships.has(key)) continue
            seenRelationships.add(key)

            const targetId = r.rel.targetId
            const targetMasterId =
              localItemById.get(targetId)?.masterId ??
              externalItemById.get(targetId)?.masterId ??
              unknownTargetMasterIds.get(targetId) ??
              null

            const targetItem = targetMasterId
              ? itemByMasterIdMap.get(targetMasterId)
              : undefined

            if (!targetMasterId || !targetItem) {
              // Defer: we do not know this item yet
              newTargetIds.push(targetId)
            } else {
              addChild(r.sourceMasterId, {
                childId: targetItem.id,
                childMasterId: targetMasterId,
                relationshipId: r.rel.id,
                quantity: r.rel.quantity ? Number(r.rel.quantity) : undefined,
                findNumber: r.rel.findNumber ?? undefined,
              })
            }
          }

          const uniqueNewTargetIds = [
            ...new Set(
              newTargetIds.filter(
                (id) => !localItemById.has(id) && !externalItemById.has(id),
              ),
            ),
          ]

          if (uniqueNewTargetIds.length > 0) {
            const newItems = await db
              .select({
                id: items.id,
                itemNumber: items.itemNumber,
                name: items.name,
                revision: items.revision,
                state: items.state,
                itemType: items.itemType,
                inDesignStructure: items.inDesignStructure,
                designId: items.designId,
                masterId: items.masterId,
                designCode: designs.code,
                designName: designs.name,
              })
              .from(items)
              .leftJoin(designs, eq(items.designId, designs.id))
              .where(inArray(items.id, uniqueNewTargetIds))

            for (const item of newItems) {
              itemByMasterIdMap.set(item.masterId, {
                ...item,
                designCode: item.designCode ?? undefined,
                designName: item.designName ?? undefined,
              })
              if (item.designCode || item.designName) {
                externalDesignMap.set(item.id, {
                  code: item.designCode,
                  name: item.designName,
                })
              }
            }

            // Back-fill the edges deferred above, now that their targets exist
            for (const r of childRels) {
              if (!newTargetIds.includes(r.rel.targetId)) continue

              const fetched = newItems.find((i) => i.id === r.rel.targetId)
              if (!fetched) continue

              addChild(r.sourceMasterId, {
                childId: fetched.id,
                childMasterId: fetched.masterId,
                relationshipId: r.rel.id,
                quantity: r.rel.quantity ? Number(r.rel.quantity) : undefined,
                findNumber: r.rel.findNumber ?? undefined,
              })
            }
          }

          const nextMasterIds: Array<string> = []
          for (const r of childRels) {
            const targetId = r.rel.targetId
            const targetItem =
              localItemById.get(targetId) ?? externalItemById.get(targetId)
            const masterId =
              targetItem?.masterId ?? unknownTargetMasterIds.get(targetId)
            // Also check newly fetched items
            const fetchedMasterId = (() => {
              for (const [mid, item] of itemByMasterIdMap) {
                if (item.id === targetId) return mid
              }
              return undefined
            })()
            const resolvedMasterId = masterId ?? fetchedMasterId
            if (
              resolvedMasterId &&
              !allDiscoveredMasterIds.has(resolvedMasterId)
            ) {
              allDiscoveredMasterIds.add(resolvedMasterId)
              nextMasterIds.push(resolvedMasterId)
            }
          }
          currentMasterIds = nextMasterIds
        }
      }
    }

    // Roots: Parts designated top-level that nothing else points at — the
    // rule GET /designs/:id/structure applies, so a child removed on the
    // branch is offered below as a non-structure item rather than promoted.
    let roots: Array<BOMTreeNode> = []
    for (const item of allItems) {
      if (
        !hasParent.has(item.masterId) &&
        item.itemType === 'Part' &&
        item.inDesignStructure === true
      ) {
        const node = buildNode(item.masterId, new Set())
        if (node) {
          roots.push(node)
        }
      }
    }

    for (const masterId of crossRefMasterIds) {
      const node = buildNode(masterId, new Set())
      if (node) {
        roots.push(node)
      }
    }

    roots.sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

    // A Library design holds everything the program shares, so showing all of
    // it would bury the change. Keep only subtrees the change order touches.
    if (design.designType === 'Library') {
      const hasAffectedDescendant = (node: BOMTreeNode): boolean => {
        if (node.isInEco) return true
        if (node.masterId && branchChangedMasterIds.has(node.masterId)) {
          return true
        }
        return node.children?.some(hasAffectedDescendant) ?? false
      }
      roots = roots.filter(hasAffectedDescendant)
    }

    let orphans: Array<OrphanItem> = allItems
      .filter((item) => {
        if (item.itemType !== 'Part') return true
        return !hasParent.has(item.masterId) && item.inDesignStructure !== true
      })
      .map((item) => ({
        id: item.id,
        itemNumber: item.itemNumber,
        name: item.name,
        revision: item.revision,
        state: item.state,
        itemType: item.itemType,
        isInEco:
          affectedItemIds.has(item.id) ||
          affectedItemMasterIds.has(item.masterId),
        isBranchChanged: branchChangedMasterIds.has(item.masterId),
        changeAction:
          changeActionMap.get(item.id) ??
          changeActionByMasterIdMap.get(item.masterId) ??
          null,
      }))
      .sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

    if (design.designType === 'Library') {
      orphans = orphans.filter((item) => item.isInEco || item.isBranchChanged)
    }

    return {
      roots,
      orphans,
      affectedItemIds: Array.from(affectedItemIds),
      ecoBranch: changeOrderBranch,
      design: {
        id: design.id,
        name: design.name,
        description: design.description,
      },
      versionContext: {
        type: versionContext.type,
        isHistorical: versionContext.type === 'commit',
        mergedAt: changeOrderDesignAssoc?.mergedAt || null,
      },
    }
  }
}
