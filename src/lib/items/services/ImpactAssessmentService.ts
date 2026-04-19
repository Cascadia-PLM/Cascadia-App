// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
  changeOrderAffectedItems,
  changeOrderImpactReports,
  changeOrderImpactedItems,
  changeOrderRisks,
  changeOrders,
  items,
  workflowInstances,
} from '../../db/schema'
import { CrossDesignReferenceService } from '../../services/CrossDesignReferenceService'
import { ItemService } from './ItemService'
import { ChangeOrderService } from './ChangeOrderService'
import type { Risk } from '../types/change-order'

export type ImpactRelationshipType =
  | 'bom_where_used'
  | 'definition_instance'
  | 'definition_source'
  | 'usage_cousin'
  | 'cross_design_ref'

export interface WhereUsedNode {
  itemId: string
  masterId: string
  itemNumber: string
  revision: string
  name: string
  itemType: string
  state: string
  depth: number
  path: Array<string>
  quantity?: string
  findNumber?: number
  referenceDesignator?: string
  // Cross-design reference fields
  designId?: string | null
  designCode?: string | null
  designName?: string | null
  // Dedup metadata: how many ECO-affected items reference this parent
  affectedByCount?: number
  // Source affected items that this parent references
  sourceAffectedItems?: Array<{
    affectedItemId: string
    itemNumber: string
    changeAction: string
  }>
  // Recommendation for released parents
  recommendation?: 'revise' | null
}

export interface AncestorNode {
  itemId: string
  itemNumber: string
  revision: string
  name: string
  itemType: string
  state: string
  designId: string | null
  depth: number
}

export interface ImpactOptions {
  maxDepth?: number
  includeDocuments?: boolean
  includeCrossChanges?: boolean
}

export interface CrossDesignImpactedPart {
  itemId: string
  itemNumber: string
  name: string
  changeAction: string
  revision: string
  relationshipType: ImpactRelationshipType
  relationshipLabel: string
  // The item in the external design that is impacted
  targetItemId?: string
  targetItemNumber?: string
  targetItemName?: string
}

export interface CrossDesignImpact {
  designId: string
  designCode: string
  designName: string
  impactedParts: Array<CrossDesignImpactedPart>
  summary: Record<string, number> // e.g. { revise: 5, release: 2 }
  relationshipSummary: Record<string, number> // e.g. { bom_where_used: 3, definition_instance: 2 }
}

export interface ImpactAnalysis {
  whereUsed: Array<WhereUsedNode>
  documents: Array<any>
  relatedChanges: Array<any>
  totalImpactedItems: number
  maxDepth: number
  risks: Array<Risk>
  crossDesignImpacts: Array<CrossDesignImpact>
}

/**
 * Service for analyzing impact of changes
 * Handles where-used traversal, document analysis, and risk identification
 */
export class ImpactAssessmentService {
  /**
   * Run complete impact analysis for a change order
   */
  static async analyzeImpact(
    changeOrderId: string,
    options: ImpactOptions = {},
  ): Promise<ImpactAnalysis> {
    const startTime = Date.now()

    const {
      maxDepth = 15,
      includeDocuments = true,
      includeCrossChanges = true,
    } = options

    // Get affected items
    const affectedItems =
      await ChangeOrderService.getAffectedItems(changeOrderId)

    const whereUsedMap = new Map<string, Array<WhereUsedNode>>()
    const documentMap = new Map<string, Array<any>>()
    const allImpactedItemIds = new Set<string>()

    // Analyze each affected item
    for (const affected of affectedItems) {
      if (!affected.affectedItemId) continue

      // Get where-used tree
      const whereUsed = await this.findWhereUsed(affected.affectedItemId, {
        maxDepth,
      })
      whereUsedMap.set(affected.affectedItemId, whereUsed)

      // Track all impacted items
      whereUsed.forEach((node) => allImpactedItemIds.add(node.itemId))

      // Get related documents if requested
      if (includeDocuments) {
        const docs = await ItemService.getRelated(
          affected.affectedItemId,
          'Document',
        )
        if (docs.length > 0) {
          documentMap.set(affected.affectedItemId, docs)
        }
      }
    }

    // Calculate max depth
    let maxDepthFound = 0
    whereUsedMap.forEach((nodes) => {
      nodes.forEach((node) => {
        if (node.depth > maxDepthFound) {
          maxDepthFound = node.depth
        }
      })
    })

    // Build lookup of affected items for O(1) access
    const affectedItemIds = new Set(
      affectedItems.map((a) => a.affectedItemId).filter(Boolean),
    )
    const affectedById = new Map<string, any>()
    for (const a of affectedItems) {
      if (a.affectedItemId) affectedById.set(a.affectedItemId, a)
    }

    // Flatten where-used results with dedup by masterId:depth
    // Same logical part (masterId) at same depth = one row; keeps highest revision
    const whereUsedDedup = new Map<string, WhereUsedNode>()
    whereUsedMap.forEach((nodes, sourceAffectedItemId) => {
      const sourceAffected = affectedById.get(sourceAffectedItemId)
      const sourceInfo = sourceAffected
        ? {
            affectedItemId: sourceAffectedItemId,
            itemNumber:
              sourceAffected.affectedItemDetails?.itemNumber ??
              sourceAffected.itemNumber ??
              '',
            changeAction: sourceAffected.changeAction ?? '',
          }
        : null

      for (const node of nodes) {
        // Skip items that are already ECO-affected — they're directly changed, not "impacted"
        if (affectedItemIds.has(node.itemId)) continue
        const key = `${node.masterId}:${node.depth}`
        const existing = whereUsedDedup.get(key)
        if (existing) {
          existing.affectedByCount = (existing.affectedByCount ?? 1) + 1
          // Keep highest revision (later itemId)
          if (node.revision > existing.revision) {
            existing.itemId = node.itemId
            existing.revision = node.revision
            existing.state = node.state
          }
          // Merge source affected items (avoid duplicates)
          if (sourceInfo && existing.sourceAffectedItems) {
            if (
              !existing.sourceAffectedItems.some(
                (s) => s.affectedItemId === sourceInfo.affectedItemId,
              )
            ) {
              existing.sourceAffectedItems.push(sourceInfo)
            }
          }
        } else {
          whereUsedDedup.set(key, {
            ...node,
            affectedByCount: 1,
            sourceAffectedItems: sourceInfo ? [sourceInfo] : [],
          })
        }
      }
    })

    // Set recommendation for released parents
    const allWhereUsed = Array.from(whereUsedDedup.values())
    for (const node of allWhereUsed) {
      node.recommendation = node.state === 'Released' ? 'revise' : null
    }

    // Flatten documents
    const allDocuments: Array<any> = []
    documentMap.forEach((docs) => allDocuments.push(...docs))

    // Detect related changes (if requested)
    const relatedChanges = includeCrossChanges
      ? await this.findRelatedChanges(
          changeOrderId,
          Array.from(allImpactedItemIds),
        )
      : []

    // Build impact data for risk analysis
    const impactData = {
      affectedItems,
      whereUsedCount: allWhereUsed.length,
      maxDepth: maxDepthFound,
      documentCount: allDocuments.length,
      conflictingChanges: relatedChanges,
      topLevelAssemblies: allWhereUsed.filter((n) => n.depth === 1),
      whereUsed: allWhereUsed, // Include full whereUsed for cross-design analysis
    }

    // Identify risks
    const risks = this.identifyRisks(impactData, affectedItems, whereUsedMap)

    // Build cross-design impact summary
    const crossDesignImpacts = await this.buildCrossDesignImpacts(
      affectedItems,
      whereUsedMap,
    )

    // Store impacted items in database
    await this.storeImpactedItems(changeOrderId, allWhereUsed, allDocuments)

    // Store risks in database
    await this.storeRisks(changeOrderId, risks)

    // Calculate risk level for change order
    const riskLevel = this.calculateOverallRiskLevel(risks)

    // Generate and store report
    const generationDuration = Date.now() - startTime
    const reportData = {
      whereUsed: allWhereUsed,
      documents: allDocuments,
      relatedChanges,
      risks,
      crossDesignImpacts,
      summary: {
        totalImpactedItems: allImpactedItemIds.size,
        maxDepth: maxDepthFound,
        whereUsedCount: allWhereUsed.length,
        documentCount: allDocuments.length,
        riskCount: risks.length,
        criticalRisks: risks.filter((r) => r.severity === 'critical').length,
      },
    }

    await this.storeImpactReport(changeOrderId, {
      totalImpactedItems: allImpactedItemIds.size,
      maxBOMDepth: maxDepthFound,
      reportData,
      generationDurationMs: generationDuration,
    })

    // Update change order with risk level and status
    await db
      .update(changeOrders)
      .set({
        riskLevel,
        impactAssessmentStatus: 'completed',
      })
      .where(eq(changeOrders.itemId, changeOrderId))

    return {
      whereUsed: allWhereUsed,
      documents: allDocuments,
      relatedChanges,
      totalImpactedItems: allImpactedItemIds.size,
      maxDepth: maxDepthFound,
      risks,
      crossDesignImpacts,
    }
  }

  /**
   * Find where an item is used (recursive where-used query)
   * Includes design context for cross-design impact analysis
   */
  static async findWhereUsed(
    itemId: string,
    options: { maxDepth?: number } = {},
  ): Promise<Array<WhereUsedNode>> {
    const maxDepth = options.maxDepth || 15

    const result = await db.execute(sql`
      WITH RECURSIVE where_used AS (
        -- Base case: direct parents
        SELECT
          r.source_id as item_id,
          i.master_id,
          i.item_number,
          i.revision,
          i.name,
          i.item_type,
          i.state,
          i.design_id,
          1 as depth,
          ARRAY[r.target_id, r.source_id] as path,
          r.quantity,
          r.find_number,
          r.reference_designator
        FROM item_relationships r
        JOIN items i ON i.id = r.source_id
        WHERE r.target_id = ${itemId}
          AND r.relationship_type = 'BOM'
          AND i.is_current = true

        UNION ALL

        -- Recursive case: parents of parents
        SELECT
          r.source_id,
          i.master_id,
          i.item_number,
          i.revision,
          i.name,
          i.item_type,
          i.state,
          i.design_id,
          wu.depth + 1,
          wu.path || r.source_id,
          r.quantity,
          r.find_number,
          r.reference_designator
        FROM item_relationships r
        JOIN items i ON i.id = r.source_id
        JOIN where_used wu ON wu.item_id = r.target_id
        WHERE wu.depth < ${maxDepth}
          AND r.relationship_type = 'BOM'
          AND i.is_current = true
          AND NOT r.source_id = ANY(wu.path)  -- Prevent circular references
      )
      SELECT
        wu.*,
        d.code as design_code,
        d.name as design_name
      FROM where_used wu
      LEFT JOIN designs d ON d.id = wu.design_id
      ORDER BY depth, item_number
    `)

    return result.map((row: any) => ({
      itemId: row.item_id,
      masterId: row.master_id,
      itemNumber: row.item_number,
      revision: row.revision,
      name: row.name,
      itemType: row.item_type,
      state: row.state,
      depth: row.depth,
      path: row.path,
      quantity: row.quantity,
      findNumber: row.find_number,
      referenceDesignator: row.reference_designator,
      designId: row.design_id,
      designCode: row.design_code,
      designName: row.design_name,
    }))
  }

  /**
   * Find ancestor chain for an item within a specific design
   * Returns the path from the item to the root(s), ordered by depth (closest parent first)
   * Unlike findWhereUsed which finds ALL usages, this returns ancestors within the same design only
   */
  static async findAncestorChain(
    itemId: string,
    designId: string,
    options: { maxDepth?: number } = {},
  ): Promise<Array<AncestorNode>> {
    const maxDepth = options.maxDepth || 15

    const result = await db.execute(sql`
      WITH RECURSIVE ancestors AS (
        -- Base case: direct parents within the same design
        SELECT
          r.source_id as item_id,
          i.item_number,
          i.revision,
          i.name,
          i.item_type,
          i.state,
          i.design_id,
          1 as depth,
          ARRAY[r.target_id, r.source_id] as path
        FROM item_relationships r
        JOIN items i ON i.id = r.source_id
        WHERE r.target_id = ${itemId}
          AND r.relationship_type = 'BOM'
          AND i.is_current = true
          AND i.design_id = ${designId}

        UNION ALL

        -- Recursive case: parents of parents, still within design
        SELECT
          r.source_id,
          i.item_number,
          i.revision,
          i.name,
          i.item_type,
          i.state,
          i.design_id,
          a.depth + 1,
          a.path || r.source_id
        FROM item_relationships r
        JOIN items i ON i.id = r.source_id
        JOIN ancestors a ON a.item_id = r.target_id
        WHERE a.depth < ${maxDepth}
          AND r.relationship_type = 'BOM'
          AND i.is_current = true
          AND i.design_id = ${designId}
          AND NOT r.source_id = ANY(a.path)  -- Prevent circular references
      )
      SELECT DISTINCT ON (item_id) * FROM ancestors
      ORDER BY item_id, depth
    `)

    // Map and sort by depth (closest parent first)
    const ancestors = result.map((row: any) => ({
      itemId: row.item_id,
      itemNumber: row.item_number,
      revision: row.revision,
      name: row.name,
      itemType: row.item_type,
      state: row.state,
      designId: row.design_id,
      depth: row.depth,
    }))

    return ancestors.sort(
      (a: AncestorNode, b: AncestorNode) => a.depth - b.depth,
    )
  }

  /**
   * Find related change orders that affect the same items
   */
  static async findRelatedChanges(
    currentChangeOrderId: string,
    impactedItemIds: Array<string>,
  ): Promise<Array<any>> {
    if (impactedItemIds.length === 0) return []

    // Find other active change orders that affect any of the impacted items
    // Join to workflowInstances and check completedAt IS NULL to exclude closed ECOs
    const relatedChanges = await db
      .selectDistinct({
        changeOrderId: changeOrderAffectedItems.changeOrderId,
        itemNumber: items.itemNumber,
        state: items.state,
      })
      .from(changeOrderAffectedItems)
      .innerJoin(items, eq(items.id, changeOrderAffectedItems.changeOrderId))
      .innerJoin(workflowInstances, eq(workflowInstances.itemId, items.id))
      .where(
        and(
          inArray(changeOrderAffectedItems.affectedItemId, impactedItemIds),
          sql`${changeOrderAffectedItems.changeOrderId} != ${currentChangeOrderId}`,
          isNull(workflowInstances.completedAt),
        ),
      )
      .limit(50)

    return relatedChanges
  }

  /**
   * Build cross-design impact summary by correlating affected items
   * with their where-used nodes in external designs, definition/usage
   * relationships, and cross-design references.
   *
   * Five phases:
   * 1. BOM Where-Used — parent assemblies in external designs
   * 2. Definition Instances — usages of affected definitions in external designs
   * 2.5. Definition Sources — source designs of affected usage items (e.g. STD-LIB)
   * 3. Usage Cousins — sibling usages of the same definition in external designs
   * 4. Cross-Design References — explicit references from external designs
   */
  private static async buildCrossDesignImpacts(
    affectedItems: Array<any>,
    whereUsedMap: Map<string, Array<WhereUsedNode>>,
  ): Promise<Array<CrossDesignImpact>> {
    // Collect all design IDs that belong to the ECO's own scope
    const ecoDesignIds = new Set(
      affectedItems
        .map((a) => a.affectedItemDetails?.designId ?? a.designId)
        .filter(Boolean),
    )
    const ecoDesignIdArr = Array.from(ecoDesignIds) as Array<string>

    // Map: external designId -> { designCode, designName, parts by compositeKey }
    // compositeKey = `${itemId}:${relationshipType}` to allow same item under multiple types
    const designMap = new Map<
      string,
      {
        designCode: string
        designName: string
        parts: Map<string, CrossDesignImpactedPart>
      }
    >()

    // Build a lookup of affected items by their ID for quick access
    const affectedById = new Map<string, any>()
    for (const affected of affectedItems) {
      if (affected.affectedItemId) {
        affectedById.set(affected.affectedItemId, affected)
      }
    }

    // Helper to add a part to the designMap
    const addPart = (
      designId: string,
      designCode: string,
      designName: string,
      part: CrossDesignImpactedPart,
    ) => {
      if (!designMap.has(designId)) {
        designMap.set(designId, {
          designCode,
          designName: designName || designCode,
          parts: new Map(),
        })
      }
      const compositeKey = `${part.itemId}:${part.targetItemId ?? ''}:${part.relationshipType}`
      const entry = designMap.get(designId)!
      if (!entry.parts.has(compositeKey)) {
        entry.parts.set(compositeKey, part)
      }
    }

    // ── Phase 1: BOM Where-Used (existing logic) ──
    for (const [affectedItemId, whereUsedNodes] of whereUsedMap) {
      const affected = affectedById.get(affectedItemId)
      if (!affected) continue

      for (const node of whereUsedNodes) {
        if (!node.designId || !node.designCode) continue
        if (ecoDesignIds.has(node.designId)) continue

        const details = affected.affectedItemDetails
        addPart(
          node.designId,
          node.designCode,
          node.designName || node.designCode,
          {
            itemId: affectedItemId,
            itemNumber: details?.itemNumber ?? '',
            name: details?.name ?? '',
            changeAction: affected.changeAction ?? '',
            revision: details?.revision ?? '',
            relationshipType: 'bom_where_used',
            relationshipLabel: `Used in BOM of ${node.designCode}`,
            targetItemId: node.itemId,
            targetItemNumber: node.itemNumber,
            targetItemName: node.name,
          },
        )
      }
    }

    // ── Phase 2: Definition Instances ──
    // Find affected items that are definitions (usageOf is null)
    const definitionIds = affectedItems
      .filter(
        (a) =>
          a.affectedItemId &&
          (a.affectedItemDetails?.usageOf == null ||
            a.affectedItemDetails?.usageOf === undefined),
      )
      .map((a) => a.affectedItemId as string)

    if (definitionIds.length > 0) {
      // Find all usages of these definitions in external designs
      const usages = await db
        .select({
          id: items.id,
          usageOf: items.usageOf,
          designId: items.designId,
          itemNumber: items.itemNumber,
          name: items.name,
          revision: items.revision,
        })
        .from(items)
        .where(
          and(inArray(items.usageOf, definitionIds), eq(items.isCurrent, true)),
        )

      for (const usage of usages) {
        if (!usage.designId || ecoDesignIds.has(usage.designId)) continue

        // Look up the affected definition to get its changeAction
        const affected = affectedById.get(usage.usageOf!)
        if (!affected) continue

        // Get design info — we need designCode/designName
        // Use a sub-query or join; for efficiency we'll batch this after
        // For now, collect and resolve design info
        const designInfo = await this.getDesignInfo(usage.designId)
        if (!designInfo) continue

        const defDetails = affected.affectedItemDetails
        addPart(usage.designId, designInfo.code, designInfo.name, {
          itemId: affected.affectedItemId!,
          itemNumber: defDetails?.itemNumber ?? '',
          name: defDetails?.name ?? '',
          changeAction: affected.changeAction ?? '',
          revision: defDetails?.revision ?? '',
          relationshipType: 'definition_instance',
          relationshipLabel: `Instance of definition ${defDetails?.itemNumber ?? ''}`,
          targetItemId: usage.id,
          targetItemNumber: usage.itemNumber ?? '',
          targetItemName: usage.name ?? '',
        })
      }
    }

    // ── Phase 2.5: Definition Sources ──
    // Find the source designs of affected items that are usages.
    // This surfaces the STD-LIB (or any source design) as an external impact
    // when the ECO items are usages of definitions in another design.
    const usageAffectedForSource = affectedItems.filter(
      (a) => a.affectedItemId && a.affectedItemDetails?.usageOf != null,
    )

    if (usageAffectedForSource.length > 0) {
      const sourceDefinitionIds = usageAffectedForSource
        .map((a) => a.affectedItemDetails!.usageOf as string)
        .filter(Boolean)

      // Batch fetch all definitions in one query
      const definitions = await db
        .select({
          id: items.id,
          designId: items.designId,
          itemNumber: items.itemNumber,
          name: items.name,
        })
        .from(items)
        .where(inArray(items.id, sourceDefinitionIds))

      const definitionById = new Map(definitions.map((d) => [d.id, d]))

      for (const affected of usageAffectedForSource) {
        const defId = affected.affectedItemDetails!.usageOf as string
        const definition = definitionById.get(defId)
        if (!definition || !definition.designId) continue
        if (ecoDesignIds.has(definition.designId)) continue

        const designInfo = await this.getDesignInfo(definition.designId)
        if (!designInfo) continue

        const details = affected.affectedItemDetails!
        addPart(definition.designId, designInfo.code, designInfo.name, {
          itemId: affected.affectedItemId!,
          itemNumber: details.itemNumber ?? '',
          name: details.name ?? '',
          changeAction: affected.changeAction ?? '',
          revision: details.revision ?? '',
          relationshipType: 'definition_source',
          relationshipLabel: `Usage of ${definition.itemNumber ?? designInfo.code} from ${designInfo.code}`,
          targetItemId: definition.id,
          targetItemNumber: definition.itemNumber ?? '',
          targetItemName: definition.name ?? '',
        })
      }
    }

    // ── Phase 3: Usage Cousins ──
    // Find affected items that are usages (usageOf is set)
    const usageAffected = affectedItems.filter(
      (a) => a.affectedItemId && a.affectedItemDetails?.usageOf != null,
    )

    if (usageAffected.length > 0) {
      const parentDefinitionIds = usageAffected
        .map((a) => a.affectedItemDetails.usageOf as string)
        .filter(Boolean)

      if (parentDefinitionIds.length > 0) {
        // Find sibling usages of the same definitions
        const cousins = await db
          .select({
            id: items.id,
            usageOf: items.usageOf,
            designId: items.designId,
            itemNumber: items.itemNumber,
            name: items.name,
            revision: items.revision,
          })
          .from(items)
          .where(
            and(
              inArray(items.usageOf, parentDefinitionIds),
              eq(items.isCurrent, true),
            ),
          )

        // Build a set of affected item IDs so we can exclude them
        const affectedItemIds = new Set(
          affectedItems.map((a) => a.affectedItemId).filter(Boolean),
        )

        for (const cousin of cousins) {
          if (!cousin.designId || ecoDesignIds.has(cousin.designId)) continue
          // Exclude the affected item itself
          if (affectedItemIds.has(cousin.id)) continue

          // Find the affected usage that shares the same definition
          const relatedAffected = usageAffected.find(
            (a) => a.affectedItemDetails?.usageOf === cousin.usageOf,
          )
          if (!relatedAffected) continue

          const designInfo = await this.getDesignInfo(cousin.designId)
          if (!designInfo) continue

          const relDetails = relatedAffected.affectedItemDetails
          addPart(cousin.designId, designInfo.code, designInfo.name, {
            itemId: relatedAffected.affectedItemId!,
            itemNumber: relDetails?.itemNumber ?? '',
            name: relDetails?.name ?? '',
            changeAction: relatedAffected.changeAction ?? '',
            revision: relDetails?.revision ?? '',
            relationshipType: 'usage_cousin',
            relationshipLabel: `Sibling usage of ${relDetails?.itemNumber ?? ''}`,
            targetItemId: cousin.id,
            targetItemNumber: cousin.itemNumber ?? '',
            targetItemName: cousin.name ?? '',
          })
        }
      }
    }

    // ── Phase 4: Cross-Design References ──
    const allAffectedItemIds = affectedItems
      .map((a) => a.affectedItemId as string)
      .filter(Boolean)

    if (allAffectedItemIds.length > 0 && ecoDesignIdArr.length > 0) {
      const crossRefs = await CrossDesignReferenceService.getReferencesToItems(
        allAffectedItemIds,
        ecoDesignIdArr,
      )

      for (const ref of crossRefs) {
        const affected = affectedById.get(ref.referencedItemId)
        if (!affected) continue

        const details = affected.affectedItemDetails
        addPart(ref.referencingDesignId, ref.designCode, ref.designName, {
          itemId: ref.referencedItemId,
          itemNumber: details?.itemNumber ?? '',
          name: details?.name ?? '',
          changeAction: affected.changeAction ?? '',
          revision: details?.revision ?? '',
          relationshipType: 'cross_design_ref',
          relationshipLabel: `Referenced from ${ref.designCode}`,
        })
      }
    }

    // ── Assembly: Convert to array, compute summaries ──
    const impacts: Array<CrossDesignImpact> = []
    for (const [designId, data] of designMap) {
      const impactedParts = Array.from(data.parts.values())
      const summary: Record<string, number> = {}
      const relationshipSummary: Record<string, number> = {}
      for (const part of impactedParts) {
        summary[part.changeAction] = (summary[part.changeAction] || 0) + 1
        relationshipSummary[part.relationshipType] =
          (relationshipSummary[part.relationshipType] || 0) + 1
      }
      impacts.push({
        designId,
        designCode: data.designCode,
        designName: data.designName,
        impactedParts,
        summary,
        relationshipSummary,
      })
    }

    // Sort by most impacted design first
    impacts.sort((a, b) => b.impactedParts.length - a.impactedParts.length)

    return impacts
  }

  /**
   * Get design code and name by ID (cached per analysis run)
   */
  private static async getDesignInfo(
    designId: string,
  ): Promise<{ code: string; name: string } | null> {
    const result = await db.execute(
      sql`SELECT code, name FROM designs WHERE id = ${designId} LIMIT 1`,
    )
    if (result.length === 0) return null
    const row = result[0] as any
    return { code: row.code, name: row.name }
  }

  /**
   * Identify risks based on impact analysis
   */
  private static identifyRisks(
    impactData: any,
    affectedItems: Array<any>,
    whereUsedMap?: Map<string, Array<WhereUsedNode>>,
  ): Array<Risk> {
    const risks: Array<Risk> = []

    // High fan-out risk
    if (impactData.whereUsedCount > 50) {
      risks.push({
        changeOrderId: affectedItems[0].changeOrderId,
        category: 'production',
        severity: 'high',
        description: `High impact: affected items are used in ${impactData.whereUsedCount} assemblies - widespread production impact`,
        affectedItems: impactData.topLevelAssemblies
          .slice(0, 10)
          .map((a: any) => a.itemNumber),
        requiresAcknowledgement: true,
        acknowledgedBy: null,
        acknowledgedAt: null,
      })
    }

    // Deep BOM hierarchy risk
    if (impactData.maxDepth > 7) {
      risks.push({
        changeOrderId: affectedItems[0].changeOrderId,
        category: 'production',
        severity: 'medium',
        description: `Change affects ${impactData.maxDepth} levels of assemblies - complex propagation`,
        requiresAcknowledgement: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
      })
    }

    // Document compliance risk
    if (impactData.documentCount > 10) {
      risks.push({
        changeOrderId: affectedItems[0].changeOrderId,
        category: 'compliance',
        severity: 'medium',
        description: `${impactData.documentCount} documents reference affected items - may require document updates`,
        requiresAcknowledgement: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
      })
    }

    // Concurrent change conflict risk
    if (impactData.conflictingChanges.length > 0) {
      risks.push({
        changeOrderId: affectedItems[0].changeOrderId,
        category: 'schedule',
        severity: 'critical',
        description: `Conflicts with ${impactData.conflictingChanges.length} other active change orders`,
        affectedItems: impactData.conflictingChanges.map(
          (c: any) => c.itemNumber,
        ),
        requiresAcknowledgement: true,
        acknowledgedBy: null,
        acknowledgedAt: null,
      })
    }

    // Obsolescence without replacement risk
    const obsoletingWithoutReplacement = affectedItems.filter(
      (a) => a.changeAction === 'obsolete' && !a.replacementItemId,
    )
    if (
      obsoletingWithoutReplacement.length > 0 &&
      impactData.whereUsedCount > 0
    ) {
      risks.push({
        changeOrderId: affectedItems[0].changeOrderId,
        category: 'production',
        severity: 'critical',
        description: `Obsoleting ${obsoletingWithoutReplacement.length} items without replacement while still in use`,
        affectedItems: obsoletingWithoutReplacement.map(
          (a: any) => a.affectedItemDetails?.itemNumber ?? a.affectedItemId,
        ),
        mitigation:
          'Provide replacement items or remove from active BOMs first',
        requiresAcknowledgement: true,
        acknowledgedBy: null,
        acknowledgedAt: null,
      })
    }

    // Mass release risk
    const releaseCount = affectedItems.filter(
      (a) => a.changeAction === 'release',
    ).length
    if (releaseCount > 20) {
      risks.push({
        changeOrderId: affectedItems[0].changeOrderId,
        category: 'schedule',
        severity: 'medium',
        description: `Releasing ${releaseCount} items simultaneously - large scope change`,
        requiresAcknowledgement: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
      })
    }

    // Cross-design usage risk
    // Identify which ECO-affected parts are used in external designs
    const affectedDesignIds = new Set(
      affectedItems.map((a: any) => a.designId).filter(Boolean),
    )
    const externalDesigns = new Map<string, string>() // designCode -> designName
    const sourcePartNumbers: Array<string> = [] // ECO parts causing cross-design impact

    if (whereUsedMap) {
      // Use the detailed map to trace back to source ECO parts
      const affectedById = new Map<string, any>()
      for (const a of affectedItems) {
        if (a.affectedItemId) affectedById.set(a.affectedItemId, a)
      }

      for (const [affectedItemId, nodes] of whereUsedMap) {
        let hasExternalRef = false
        for (const node of nodes) {
          if (
            node.designCode &&
            node.designId &&
            !affectedDesignIds.has(node.designId)
          ) {
            externalDesigns.set(
              node.designCode,
              node.designName || node.designCode,
            )
            hasExternalRef = true
          }
        }
        if (hasExternalRef) {
          const affected = affectedById.get(affectedItemId)
          const itemNumber = affected?.affectedItemDetails?.itemNumber
          if (itemNumber && !sourcePartNumbers.includes(itemNumber)) {
            sourcePartNumbers.push(itemNumber)
          }
        }
      }
    } else {
      // Fallback: use flattened whereUsed nodes
      const whereUsedNodes =
        (impactData.whereUsed as Array<WhereUsedNode> | undefined) ?? []
      for (const node of whereUsedNodes) {
        if (
          node.designCode &&
          node.designId &&
          !affectedDesignIds.has(node.designId)
        ) {
          externalDesigns.set(
            node.designCode,
            node.designName || node.designCode,
          )
        }
      }
    }

    if (externalDesigns.size > 0) {
      const designList = Array.from(externalDesigns.keys())
      risks.push({
        changeOrderId: affectedItems[0].changeOrderId,
        category: 'cross-design',
        severity: externalDesigns.size > 3 ? 'high' : 'medium',
        description: `Part is used in ${externalDesigns.size} other design(s): ${designList.slice(0, 5).join(', ')}${designList.length > 5 ? ` and ${designList.length - 5} more` : ''}`,
        affectedItems: sourcePartNumbers.slice(0, 10),
        requiresAcknowledgement: externalDesigns.size > 3,
        acknowledgedBy: null,
        acknowledgedAt: null,
      })
    }

    return risks
  }

  /**
   * Calculate overall risk level for the change order
   */
  private static calculateOverallRiskLevel(
    risks: Array<Risk>,
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (risks.some((r) => r.severity === 'critical')) return 'critical'
    if (risks.some((r) => r.severity === 'high')) return 'high'
    if (risks.some((r) => r.severity === 'medium')) return 'medium'
    return 'low'
  }

  /**
   * Store impacted items in database
   */
  private static async storeImpactedItems(
    changeOrderId: string,
    whereUsed: Array<WhereUsedNode>,
    documents: Array<any>,
  ): Promise<void> {
    // Clear existing impacted items
    await db
      .delete(changeOrderImpactedItems)
      .where(eq(changeOrderImpactedItems.changeOrderId, changeOrderId))

    // Insert where-used items
    for (const node of whereUsed) {
      await db.insert(changeOrderImpactedItems).values({
        changeOrderId,
        impactedItemId: node.itemId,
        impactType: 'where_used',
        impactSeverity:
          node.depth <= 2 ? 'high' : node.depth <= 5 ? 'medium' : 'low',
        depth: node.depth,
        path: node.path,
        metadata: {
          quantity: node.quantity,
          findNumber: node.findNumber,
          referenceDesignator: node.referenceDesignator,
        },
      })
    }

    // Insert document references
    for (const doc of documents) {
      await db.insert(changeOrderImpactedItems).values({
        changeOrderId,
        impactedItemId: doc.id,
        impactType: 'document_reference',
        impactSeverity: 'medium',
      })
    }
  }

  /**
   * Store risks in database
   */
  private static async storeRisks(
    changeOrderId: string,
    risks: Array<Risk>,
  ): Promise<void> {
    // Clear existing risks
    await db
      .delete(changeOrderRisks)
      .where(eq(changeOrderRisks.changeOrderId, changeOrderId))

    // Insert new risks
    for (const risk of risks) {
      await db.insert(changeOrderRisks).values({
        changeOrderId,
        category: risk.category,
        severity: risk.severity,
        description: risk.description,
        affectedItems: risk.affectedItems || [],
        mitigation: risk.mitigation || null,
        requiresAcknowledgement: risk.requiresAcknowledgement,
      })
    }
  }

  /**
   * Store impact report in database
   */
  private static async storeImpactReport(
    changeOrderId: string,
    report: {
      totalImpactedItems: number
      maxBOMDepth: number
      reportData: any
      generationDurationMs: number
    },
  ): Promise<void> {
    // Delete existing report if any
    await db
      .delete(changeOrderImpactReports)
      .where(eq(changeOrderImpactReports.changeOrderId, changeOrderId))

    // Insert new report
    await db.insert(changeOrderImpactReports).values({
      changeOrderId,
      totalImpactedItems: report.totalImpactedItems,
      maxBOMDepth: report.maxBOMDepth,
      reportData: report.reportData,
      generationDurationMs: report.generationDurationMs,
    })
  }
}
