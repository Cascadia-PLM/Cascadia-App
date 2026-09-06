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

// The tree this service builds is the same shape the design-structure endpoint
// builds and the BOM components render, so it is declared once in lib/types.
export type { BOMTreeNode, OrphanItem }

export interface EcoDesignStructure {
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
export class EcoStructureService {
  /**
   * Resolve the version context for every design this change order touches.
   *
   * The map matters as much as the single context: a BOM edge can cross into
   * another design that the same change order is also changing, and that target
   * must resolve at *its* design's vantage point, not this one's.
   */
  private static resolveDesignContexts(
    allEcoDesigns: Array<typeof changeOrderDesigns.$inferSelect>,
  ): Map<string, VersionContext> {
    const contexts = new Map<string, VersionContext>()
    for (const ecoDesign of allEcoDesigns) {
      if (ecoDesign.mergeStatus === 'merged' && ecoDesign.mergeCommitId) {
        contexts.set(ecoDesign.designId, {
          type: 'commit',
          commitId: ecoDesign.mergeCommitId,
        })
      } else if (ecoDesign.branchId) {
        contexts.set(ecoDesign.designId, {
          type: 'branch',
          branchId: ecoDesign.branchId,
        })
      } else {
        contexts.set(ecoDesign.designId, {
          type: 'released',
          designId: ecoDesign.designId,
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

  static async getDesignStructure(
    changeOrderId: string,
    designId: string,
    options: { expandExternal?: boolean } = {},
  ): Promise<EcoDesignStructure> {
    const { expandExternal = true } = options

    const design = await DesignService.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId)
    }

    // ALL associations, not just this design's — multi-design change orders
    // need every vantage point to resolve cross-design edges.
    const allEcoDesigns = await db
      .select()
      .from(changeOrderDesigns)
      .where(eq(changeOrderDesigns.changeOrderId, changeOrderId))

    const ecoDesignAssoc = allEcoDesigns.find((ed) => ed.designId === designId)

    const ecoDesignContexts = this.resolveDesignContexts(allEcoDesigns)
    // This design's own context, resolved by the same rules
    const versionContext: VersionContext = ecoDesignContexts.get(designId) ?? {
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
    // `getEcoSummary` uses — this used to run its own query against the same
    // table for a number it was holding the data to compute.
    const ecoBranch = ecoDesignAssoc
      ? {
          id: ecoDesignAssoc.branchId,
          mergeStatus: ecoDesignAssoc.mergeStatus,
          itemsAffected:
            ChangeOrderService.countAffectedItemsByDesign(
              affectedItems,
            ).byDesign.get(designId) ?? 0,
        }
      : null

    // For Library designs, also track items changed on the ECO branch
    const branchChangedMasterIds = new Set<string>()
    if (design.designType === 'Library' && ecoDesignAssoc?.branchId) {
      const changedItems = await db
        .select({ itemMasterId: branchItems.itemMasterId })
        .from(branchItems)
        .where(
          and(
            eq(branchItems.branchId, ecoDesignAssoc.branchId),
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

    // Query by masterId to catch edges authored on any revision, then resolve
    // targets at context and drop the duplicates that produces.
    let relationships = await this.loadBomRelationshipsByMasterId(masterIds)

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
        ecoDesignContexts,
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

        const externalRelationships = await this.loadBomRelationshipsByMasterId(
          currentExternalMasterIds,
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
            ecoDesignContexts,
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
      }>
    >()
    const hasParent = new Set<string>()

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
        childrenMap.get(sourceMasterId)!.push({
          childId: targetItem.id,
          childMasterId: targetMasterId,
          relationshipId: r.rel.id,
          quantity: r.rel.quantity ? Number(r.rel.quantity) : undefined,
          findNumber: r.rel.findNumber ?? undefined,
          option: r.rel.option ?? null,
        })
        hasParent.add(targetMasterId)
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
      ecoDesignAssoc?.branchId,
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
            ecoDesignContexts,
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
              if (!childrenMap.has(r.sourceMasterId)) {
                childrenMap.set(r.sourceMasterId, [])
              }
              childrenMap.get(r.sourceMasterId)!.push({
                childId: targetItem.id,
                childMasterId: targetMasterId,
                relationshipId: r.rel.id,
                quantity: r.rel.quantity ? Number(r.rel.quantity) : undefined,
                findNumber: r.rel.findNumber ?? undefined,
              })
              hasParent.add(targetMasterId)
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

              if (!childrenMap.has(r.sourceMasterId)) {
                childrenMap.set(r.sourceMasterId, [])
              }
              const existing = childrenMap.get(r.sourceMasterId)!
              if (!existing.some((c) => c.childMasterId === fetched.masterId)) {
                existing.push({
                  childId: fetched.id,
                  childMasterId: fetched.masterId,
                  relationshipId: r.rel.id,
                  quantity: r.rel.quantity ? Number(r.rel.quantity) : undefined,
                  findNumber: r.rel.findNumber ?? undefined,
                })
                hasParent.add(fetched.masterId)
              }
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

    // Roots: structural Parts nothing else points at
    let roots: Array<BOMTreeNode> = []
    for (const item of allItems) {
      if (
        !hasParent.has(item.masterId) &&
        item.itemType === 'Part' &&
        item.inDesignStructure !== false
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
        if (item.inDesignStructure === false) return true
        return false
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
      ecoBranch,
      design: {
        id: design.id,
        name: design.name,
        description: design.description,
      },
      versionContext: {
        type: versionContext.type,
        isHistorical: versionContext.type === 'commit',
        mergedAt: ecoDesignAssoc?.mergedAt || null,
      },
    }
  }
}
