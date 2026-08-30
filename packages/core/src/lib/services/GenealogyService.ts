// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import {
  RELATIONSHIP_CONSUMES,
  RELATIONSHIP_PRODUCES,
} from './WorkOrderMaterialService'
import { db } from '@/lib/db'
import { physicalPartAccessScopeCondition } from '@/lib/db/filters'
import { itemRelationships, items, physicalParts } from '@/lib/db/schema'
import { NotFoundError } from '@/lib/errors'

/**
 * Build genealogy, derived — never stored — from Consumes/Produces edges
 * (docs/features/physical-parts-and-traceability.md Phase 4).
 *
 * Downward (composition): unit → producing WO → consumed targets → each
 * consumed unit's own producing WO → …  Upward (where-used): unit/lot →
 * consuming WOs → their produced units → …
 *
 * Precision is WO-level in v1: every material consumed by a WO attributes
 * to every unit that WO produced. Documented simplification, acceptable at
 * HMLV quantities; per-unit allocation is a later refinement.
 */

export interface GenealogyNode {
  /** items.id of the node (PhysicalPart item, or Part version row for bulk) */
  itemId: string
  kind: 'unit' | 'lot' | 'bulk'
  physicalPartNumber: string | null
  serialNumber: string | null
  lotNumber: string | null
  state: string | null
  partItemNumber: string | null
  partName: string | null
  /** Quantity consumed in the parent's context (composition direction) */
  quantity: number | null
  /** WO that produced this node (composition) or consumed it (where-used) */
  workOrder: { id: string; itemNumber: string } | null
  children: Array<GenealogyNode>
}

const MAX_DEPTH = 10

async function loadPhysicalNode(
  itemId: string,
): Promise<Omit<GenealogyNode, 'children' | 'workOrder' | 'quantity'> | null> {
  const [row] = await db
    .select({
      itemId: items.id,
      physicalPartNumber: items.itemNumber,
      state: items.state,
      instanceKind: physicalParts.instanceKind,
      serialNumber: physicalParts.serialNumber,
      lotNumber: physicalParts.lotNumber,
      partMasterId: physicalParts.partMasterId,
    })
    .from(items)
    .innerJoin(physicalParts, eq(physicalParts.itemId, items.id))
    .where(eq(items.id, itemId))
    .limit(1)
  if (!row) return null

  const [partInfo] = await db
    .select({ itemNumber: items.itemNumber, name: items.name })
    .from(items)
    .where(
      and(
        eq(items.masterId, row.partMasterId),
        eq(items.itemType, 'Part'),
        eq(items.isCurrent, true),
      ),
    )
    .limit(1)

  return {
    itemId: row.itemId,
    kind: row.instanceKind as 'unit' | 'lot',
    physicalPartNumber: row.physicalPartNumber,
    serialNumber: row.serialNumber,
    lotNumber: row.lotNumber,
    state: row.state,
    partItemNumber: partInfo?.itemNumber ?? null,
    partName: partInfo?.name ?? null,
  }
}

export class GenealogyService {
  /** Composition (downward): everything that went into this unit. */
  static async getComposition(
    physicalPartItemId: string,
    depth = 0,
    visited = new Set<string>(),
  ): Promise<Array<GenealogyNode>> {
    if (depth >= MAX_DEPTH || visited.has(physicalPartItemId)) return []
    visited.add(physicalPartItemId)

    const [unit] = await db
      .select({ producingWorkOrderId: physicalParts.producingWorkOrderId })
      .from(physicalParts)
      .where(eq(physicalParts.itemId, physicalPartItemId))
      .limit(1)
    if (!unit?.producingWorkOrderId) return []

    const [wo] = await db
      .select({ id: items.id, itemNumber: items.itemNumber })
      .from(items)
      .where(eq(items.id, unit.producingWorkOrderId))
      .limit(1)
    if (!wo) return []

    const consumed = await db
      .select({
        targetId: itemRelationships.targetId,
        quantity: itemRelationships.quantity,
        targetItemType: items.itemType,
        targetItemNumber: items.itemNumber,
        targetName: items.name,
        targetRevision: items.revision,
      })
      .from(itemRelationships)
      .innerJoin(items, eq(itemRelationships.targetId, items.id))
      .where(
        and(
          eq(itemRelationships.sourceId, wo.id),
          eq(itemRelationships.relationshipType, RELATIONSHIP_CONSUMES),
        ),
      )
      .orderBy(itemRelationships.createdAt)

    const nodes: Array<GenealogyNode> = []
    for (const line of consumed) {
      if (line.targetItemType === 'PhysicalPart') {
        const base = await loadPhysicalNode(line.targetId)
        if (!base) continue
        nodes.push({
          ...base,
          quantity: Number(line.quantity ?? 1),
          workOrder: wo,
          children: await this.getComposition(
            line.targetId,
            depth + 1,
            visited,
          ),
        })
      } else {
        // Bulk line: the target is the pinned part version row
        nodes.push({
          itemId: line.targetId,
          kind: 'bulk',
          physicalPartNumber: null,
          serialNumber: null,
          lotNumber: null,
          state: null,
          partItemNumber: line.targetItemNumber,
          partName: line.targetName
            ? `${line.targetName} (Rev ${line.targetRevision})`
            : `Rev ${line.targetRevision}`,
          quantity: Number(line.quantity ?? 1),
          workOrder: wo,
          children: [],
        })
      }
    }
    return nodes
  }

  /** Where-used (upward): every unit this instance went into. */
  static async getWhereUsed(
    physicalPartItemId: string,
    depth = 0,
    visited = new Set<string>(),
  ): Promise<Array<GenealogyNode>> {
    if (depth >= MAX_DEPTH || visited.has(physicalPartItemId)) return []
    visited.add(physicalPartItemId)

    // WOs that consumed this instance
    const consumingEdges = await db
      .select({ workOrderId: itemRelationships.sourceId })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.targetId, physicalPartItemId),
          eq(itemRelationships.relationshipType, RELATIONSHIP_CONSUMES),
        ),
      )
    if (consumingEdges.length === 0) return []

    const woIds = [...new Set(consumingEdges.map((e) => e.workOrderId))]
    const wos = await db
      .select({ id: items.id, itemNumber: items.itemNumber })
      .from(items)
      .where(inArray(items.id, woIds))

    const nodes: Array<GenealogyNode> = []
    for (const wo of wos) {
      const produced = await db
        .select({ unitId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, wo.id),
            eq(itemRelationships.relationshipType, RELATIONSHIP_PRODUCES),
          ),
        )
      for (const p of produced) {
        const base = await loadPhysicalNode(p.unitId)
        if (!base) continue
        nodes.push({
          ...base,
          quantity: null,
          workOrder: wo,
          children: await this.getWhereUsed(p.unitId, depth + 1, visited),
        })
      }
      // A consuming WO with no produced units still matters for trace
      if (produced.length === 0) {
        nodes.push({
          itemId: wo.id,
          kind: 'bulk',
          physicalPartNumber: null,
          serialNumber: null,
          lotNumber: null,
          state: null,
          partItemNumber: null,
          partName: `Consumed by ${wo.itemNumber} (no produced units recorded)`,
          quantity: null,
          workOrder: wo,
          children: [],
        })
      }
    }
    return nodes
  }

  /** Full genealogy for a physical part: the record plus both directions. */
  static async forPhysicalPart(physicalPartItemId: string) {
    const node = await loadPhysicalNode(physicalPartItemId)
    if (!node) throw new NotFoundError('PhysicalPart', physicalPartItemId)

    const [composition, whereUsed] = await Promise.all([
      this.getComposition(physicalPartItemId),
      this.getWhereUsed(physicalPartItemId),
    ])
    return { physicalPart: node, composition, whereUsed }
  }

  /**
   * Recall query: end items reachable upward from every instance matching a
   * serial or lot identity. "Which shipped units contain lot L?" is one call.
   *
   * `accessDesignIds` bounds the *seeds* and is required for the reason it is
   * required on `PhysicalPartService.search`: this is the second list surface
   * on the type, and leaving it open would have kept the whole disclosure
   * reachable through a sibling route after the index was closed. `partMasterId`
   * is the shape that matters — it enumerates every unit and lot of a lineage
   * together with the end items each was built into, which is a dump rather
   * than the oracle a known serial gives.
   *
   * The seeds are the boundary; the upward traversal from an admitted seed is
   * not re-checked, exactly as `forPhysicalPart` does not re-check the graph it
   * walks from an id the route already gated. Genealogy crossing a program
   * boundary from a reachable seed is a pre-existing property of both, and one
   * to settle on its own rather than under cover of this scoping.
   *
   * `null` is cross-program authority; `[]` is a caller who reaches no design
   * and must still see the design-less lineages the by-id gate ungates, so the
   * guard is on truthiness and never on `.length`.
   */
  static async recall(criteria: {
    serialNumber?: string
    lotNumber?: string
    partMasterId?: string
    accessDesignIds: Array<string> | null
  }) {
    const conditions = []
    if (criteria.serialNumber) {
      conditions.push(eq(physicalParts.serialNumber, criteria.serialNumber))
    }
    if (criteria.lotNumber) {
      conditions.push(eq(physicalParts.lotNumber, criteria.lotNumber))
    }
    if (criteria.partMasterId) {
      conditions.push(eq(physicalParts.partMasterId, criteria.partMasterId))
    }
    // Naming no identity at all still returns nothing, so this guard counts
    // only the caller's own filters — pushing the access predicate before it
    // would turn "recall with no criteria" into "every instance you may read".
    if (conditions.length === 0) return []

    if (criteria.accessDesignIds) {
      conditions.push(
        physicalPartAccessScopeCondition(criteria.accessDesignIds),
      )
    }

    // `physicalPartAccessScopeCondition` is written against `items`, which this
    // query had no reason to join until now.
    const matches = await db
      .select({ itemId: physicalParts.itemId })
      .from(physicalParts)
      .innerJoin(items, eq(items.id, physicalParts.itemId))
      .where(and(...conditions))

    const results = []
    for (const match of matches) {
      const node = await loadPhysicalNode(match.itemId)
      if (!node) continue
      const whereUsed = await this.getWhereUsed(match.itemId)
      // End items = leaves of the upward tree (units nothing else consumed)
      const endItems: Array<GenealogyNode> = []
      const collect = (nodes: Array<GenealogyNode>) => {
        for (const n of nodes) {
          if (n.children.length === 0) endItems.push({ ...n, children: [] })
          else collect(n.children)
        }
      }
      collect(whereUsed)
      results.push({ physicalPart: node, endItems })
    }
    return results
  }
}
