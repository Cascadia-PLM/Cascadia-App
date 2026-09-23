// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { ThreadCacheService } from './ThreadCacheService'
import { WorkOrderMaterialService } from './WorkOrderMaterialService'
import { db } from '@/lib/db'
import {
  itemRelationships,
  items,
  vaultFiles,
  workOrders,
} from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { serviceLogger } from '@/lib/logging/logger'
import { SATISFIES_RELATIONSHIP } from '@/lib/services/RequirementService'

/**
 * Qualification evidence and rollup
 * (docs/features/physical-parts-and-traceability.md Phase 5).
 *
 * An `Evidences` edge asserts, by a human, that a physical instance's
 * documentation satisfies a requirement — e.g. "this feedstock lot's mill
 * cert covers REQ-000012". Edge convention holds: the PhysicalPart
 * (operational) is the source; the Requirement version row is the target.
 *
 * The rollup answers the customer question directly: for a work order,
 * every requirement flowing in via the built part and consumed materials
 * (SATISFIES edges), marked satisfied where evidence exists, plus a gap
 * list of consumed materials carrying no evidence at all. Assertion is
 * human; the system tracks and flags — no automated cert parsing.
 */

export const RELATIONSHIP_EVIDENCES = 'Evidences'

export const addEvidenceSchema = z.object({
  requirementId: z.string().uuid({ message: 'Requirement is required' }),
  note: z.string().max(2000).optional(),
})

export interface EvidenceLink {
  edgeId: string
  requirementItemId: string
  requirementMasterId: string
  requirementNumber: string
  requirementName: string | null
  note: string | null
  createdAt: Date
  createdBy: string
}

export interface QualificationRow {
  requirementMasterId: string
  requirementItemId: string
  requirementNumber: string
  requirementName: string | null
  /** The part that brought this requirement into scope */
  viaPartNumber: string | null
  viaPartName: string | null
  satisfied: boolean
  evidence: Array<{
    physicalPartItemId: string
    physicalPartNumber: string
    serialNumber: string | null
    lotNumber: string | null
    note: string | null
  }>
}

export interface QualificationGap {
  physicalPartItemId: string
  physicalPartNumber: string | null
  serialNumber: string | null
  lotNumber: string | null
  partItemNumber: string | null
  fileCount: number
}

export class QualificationService {
  /** Assert that a physical instance's documents evidence a requirement. */
  static async addEvidence(
    physicalPartItemId: string,
    requirementId: string,
    userId: string,
    note?: string,
  ): Promise<EvidenceLink> {
    const [pp] = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.id, physicalPartItemId),
          eq(items.itemType, 'PhysicalPart'),
        ),
      )
      .limit(1)
    if (!pp) throw new NotFoundError('PhysicalPart', physicalPartItemId)

    const [req] = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(eq(items.id, requirementId), eq(items.itemType, 'Requirement')),
      )
      .limit(1)
    if (!req) throw new NotFoundError('Requirement', requirementId)

    const [existing] = await db
      .select({ id: itemRelationships.id })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, physicalPartItemId),
          eq(itemRelationships.targetId, requirementId),
          eq(itemRelationships.relationshipType, RELATIONSHIP_EVIDENCES),
        ),
      )
      .limit(1)
    if (existing) {
      throw new ValidationError(
        'This instance already evidences that requirement',
      )
    }

    await db.insert(itemRelationships).values({
      sourceId: physicalPartItemId,
      targetId: requirementId,
      relationshipType: RELATIONSHIP_EVIDENCES,
      metadata: note ? { note } : null,
      createdBy: userId,
    })

    // Awaited so the evidence dialog's thread refresh reads its own write;
    // failure-tolerant — a stale cache is never worth failing the assertion.
    try {
      await ThreadCacheService.invalidateForRelationship(
        physicalPartItemId,
        requirementId,
      )
    } catch (err) {
      serviceLogger.warn({ err }, 'Failed to invalidate thread cache')
    }

    const links = await this.listEvidence(physicalPartItemId)
    return links.find((l) => l.requirementItemId === requirementId)!
  }

  static async removeEvidence(
    physicalPartItemId: string,
    edgeId: string,
  ): Promise<void> {
    const deleted = await db
      .delete(itemRelationships)
      .where(
        and(
          eq(itemRelationships.id, edgeId),
          eq(itemRelationships.sourceId, physicalPartItemId),
          eq(itemRelationships.relationshipType, RELATIONSHIP_EVIDENCES),
        ),
      )
      .returning({ targetId: itemRelationships.targetId })
    const removed = deleted[0]
    if (!removed) throw new NotFoundError('Evidence link', edgeId)

    try {
      await ThreadCacheService.invalidateForRelationship(
        physicalPartItemId,
        removed.targetId,
      )
    } catch (err) {
      serviceLogger.warn({ err }, 'Failed to invalidate thread cache')
    }
  }

  static async listEvidence(
    physicalPartItemId: string,
  ): Promise<Array<EvidenceLink>> {
    const rows = await db
      .select({
        edgeId: itemRelationships.id,
        metadata: itemRelationships.metadata,
        createdAt: itemRelationships.createdAt,
        createdBy: itemRelationships.createdBy,
        requirementItemId: items.id,
        requirementMasterId: items.masterId,
        requirementNumber: items.itemNumber,
        requirementName: items.name,
      })
      .from(itemRelationships)
      .innerJoin(items, eq(itemRelationships.targetId, items.id))
      .where(
        and(
          eq(itemRelationships.sourceId, physicalPartItemId),
          eq(itemRelationships.relationshipType, RELATIONSHIP_EVIDENCES),
        ),
      )
      .orderBy(itemRelationships.createdAt)

    return rows.map((r) => ({
      edgeId: r.edgeId,
      requirementItemId: r.requirementItemId,
      requirementMasterId: r.requirementMasterId,
      requirementNumber: r.requirementNumber,
      requirementName: r.requirementName,
      note: ((r.metadata as { note?: string } | null)?.note ?? null) || null,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
    }))
  }

  /**
   * The qualification picture for one work order: requirements in scope
   * (via the built part and every consumed material's part lineage, through
   * SATISFIES edges), satisfaction from Evidences edges on this WO's
   * consumed instances, and the gap list of instances with no evidence.
   */
  static async rollupForWorkOrder(workOrderItemId: string): Promise<{
    rows: Array<QualificationRow>
    gaps: Array<QualificationGap>
  }> {
    const [wo] = await db
      .select({ id: items.id, partId: workOrders.partId })
      .from(items)
      .innerJoin(workOrders, eq(workOrders.itemId, items.id))
      .where(eq(items.id, workOrderItemId))
      .limit(1)
    if (!wo) throw new NotFoundError('Work Order', workOrderItemId)

    const materials = await WorkOrderMaterialService.list(workOrderItemId)

    // Part version rows in scope: the built part version + every version of
    // each consumed material's lineage (SATISFIES edges hang off versions).
    const lineageMasterIds = [
      ...new Set(materials.map((m) => m.partMasterId).filter(Boolean)),
    ]
    const scopeVersionRows: Array<{
      id: string
      itemNumber: string
      name: string | null
    }> = []
    if (wo.partId) {
      const [built] = await db
        .select({
          id: items.id,
          itemNumber: items.itemNumber,
          name: items.name,
        })
        .from(items)
        .where(eq(items.id, wo.partId))
        .limit(1)
      if (built) scopeVersionRows.push(built)
    }
    if (lineageMasterIds.length > 0) {
      const versions = await db
        .select({
          id: items.id,
          itemNumber: items.itemNumber,
          name: items.name,
        })
        .from(items)
        .where(
          and(
            inArray(items.masterId, lineageMasterIds),
            eq(items.itemType, 'Part'),
          ),
        )
      scopeVersionRows.push(...versions)
    }
    if (scopeVersionRows.length === 0) return { rows: [], gaps: [] }

    // Requirements linked from any in-scope part version
    const satisfiesEdges = await db
      .select({
        sourceId: itemRelationships.sourceId,
        requirementItemId: items.id,
        requirementMasterId: items.masterId,
        requirementNumber: items.itemNumber,
        requirementName: items.name,
      })
      .from(itemRelationships)
      .innerJoin(items, eq(itemRelationships.targetId, items.id))
      .where(
        and(
          inArray(
            itemRelationships.sourceId,
            scopeVersionRows.map((v) => v.id),
          ),
          eq(itemRelationships.relationshipType, SATISFIES_RELATIONSHIP),
          eq(items.itemType, 'Requirement'),
        ),
      )

    // Evidence from this WO's consumed physical instances
    const consumedPhysicalIds = materials
      .filter((m) => m.kind !== 'bulk')
      .map((m) => m.targetItemId)
    const evidenceEdges =
      consumedPhysicalIds.length > 0
        ? await db
            .select({
              sourceId: itemRelationships.sourceId,
              metadata: itemRelationships.metadata,
              requirementMasterId: items.masterId,
            })
            .from(itemRelationships)
            .innerJoin(items, eq(itemRelationships.targetId, items.id))
            .where(
              and(
                inArray(itemRelationships.sourceId, consumedPhysicalIds),
                eq(itemRelationships.relationshipType, RELATIONSHIP_EVIDENCES),
              ),
            )
        : []

    const materialByItemId = new Map(materials.map((m) => [m.targetItemId, m]))
    const viaByVersionId = new Map(scopeVersionRows.map((v) => [v.id, v]))

    // One row per requirement lineage; evidence matches on requirement master
    const rowsByMaster = new Map<string, QualificationRow>()
    for (const edge of satisfiesEdges) {
      const via = viaByVersionId.get(edge.sourceId)
      const existing = rowsByMaster.get(edge.requirementMasterId)
      if (existing) continue
      const evidence = evidenceEdges
        .filter((e) => e.requirementMasterId === edge.requirementMasterId)
        .map((e) => {
          const material = materialByItemId.get(e.sourceId)
          return {
            physicalPartItemId: e.sourceId,
            physicalPartNumber: material?.physicalPartNumber ?? '',
            serialNumber: material?.serialNumber ?? null,
            lotNumber: material?.lotNumber ?? null,
            note:
              ((e.metadata as { note?: string } | null)?.note ?? null) || null,
          }
        })
      rowsByMaster.set(edge.requirementMasterId, {
        requirementMasterId: edge.requirementMasterId,
        requirementItemId: edge.requirementItemId,
        requirementNumber: edge.requirementNumber,
        requirementName: edge.requirementName,
        viaPartNumber: via?.itemNumber ?? null,
        viaPartName: via?.name ?? null,
        satisfied: evidence.length > 0,
        evidence,
      })
    }

    // Gaps: consumed instances with neither evidence links nor documents
    const evidencedSources = new Set(evidenceEdges.map((e) => e.sourceId))
    const gaps: Array<QualificationGap> = []
    for (const material of materials) {
      if (material.kind === 'bulk') continue
      if (evidencedSources.has(material.targetItemId)) continue
      const files = await db
        .select({ id: vaultFiles.id })
        .from(vaultFiles)
        .where(eq(vaultFiles.itemId, material.targetItemId))
      if (files.length === 0) {
        gaps.push({
          physicalPartItemId: material.targetItemId,
          physicalPartNumber: material.physicalPartNumber,
          serialNumber: material.serialNumber,
          lotNumber: material.lotNumber,
          partItemNumber: material.partItemNumber,
          fileCount: 0,
        })
      }
    }

    return { rows: [...rowsByMaster.values()], gaps }
  }
}
