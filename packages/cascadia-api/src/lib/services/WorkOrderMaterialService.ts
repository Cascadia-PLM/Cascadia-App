// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { PhysicalPartService } from './PhysicalPartService'
import { ThreadCacheService } from './ThreadCacheService'
import { db } from '@/lib/db'
import {
  itemRelationships,
  items,
  parts,
  physicalParts,
  workOrders,
} from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { serviceLogger } from '@/lib/logging/logger'

/**
 * Material consumption for work orders, recorded as `Consumes` edges in
 * item_relationships (docs/features/physical-parts-and-traceability.md §4.6).
 *
 * Edge convention: the operational item (the work order) is ALWAYS the
 * source. Versioned items appear only as targets (bulk consumption pins the
 * exact part version). Merge/checkout relationship copying is scoped to the
 * sourceId of the versioned item being processed, so these edges are
 * invisible to the versioning machinery — verified against
 * ChangeOrderMergeService before this design was adopted.
 *
 * Invariants (service-enforced; all writes flow through here):
 * - A serialized unit is consumed by at most one work order at a time.
 *   Guarded by an atomic compare-and-set on items.state ('Available' →
 *   'Consumed') in the same transaction as the edge insert.
 * - Unit edges carry quantity 1; lot/bulk edges accumulate quantity on a
 *   single edge per (workOrder, target).
 * - Removing a unit edge returns the unit to 'Available' atomically.
 */

export const RELATIONSHIP_CONSUMES = 'Consumes'
export const RELATIONSHIP_PRODUCES = 'Produces'

export const consumeMaterialSchema = z
  .object({
    partMasterId: z.string().uuid({ message: 'Part is required' }),
    serialNumber: z.string().trim().min(1).max(200).optional(),
    lotNumber: z.string().trim().min(1).max(200).optional(),
    /** For lot and bulk consumption; units are always quantity 1 */
    quantity: z.number().positive().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => !(v.serialNumber && v.lotNumber), {
    message: 'Provide at most one of serialNumber or lotNumber',
  })
  .refine((v) => !(v.serialNumber && v.quantity && v.quantity !== 1), {
    message: 'Serialized units are consumed one at a time',
  })

export type ConsumeMaterialInput = z.infer<typeof consumeMaterialSchema>

export const produceUnitsSchema = z.object({
  serialNumbers: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
})

export interface ProducedUnit {
  unitItemId: string
  physicalPartNumber: string
  state: string
  serialNumber: string | null
  partMasterId: string
  asBuiltItemId: string | null
  createdAt: Date
}

export interface MaterialLine {
  edgeId: string
  kind: 'unit' | 'lot' | 'bulk'
  quantity: number
  /** items.id of the edge target (PhysicalPart item or Part version row) */
  targetItemId: string
  partMasterId: string
  partItemNumber: string | null
  partName: string | null
  serialNumber: string | null
  lotNumber: string | null
  /** target Part revision for bulk lines (the pinned version) */
  partRevision: string | null
  physicalPartNumber: string | null
  physicalPartState: string | null
  createdAt: Date
  createdBy: string
}

async function getWorkOrderItem(workOrderItemId: string) {
  const [wo] = await db
    .select({ id: items.id, state: items.state, itemNumber: items.itemNumber })
    .from(items)
    .where(and(eq(items.id, workOrderItemId), eq(items.itemType, 'WorkOrder')))
    .limit(1)
  if (!wo) throw new NotFoundError('Work Order', workOrderItemId)
  return wo
}

function assertWorkOrderOpen(wo: { state: string; itemNumber: string }) {
  if (wo.state === 'Complete' || wo.state === 'Cancelled') {
    throw new ValidationError(
      `Work order ${wo.itemNumber} is ${wo.state} — materials can no longer be changed`,
    )
  }
}

/**
 * Invalidate cached threads after a physical edge write. Awaited (unlike the
 * fire-and-forget in ItemRelationshipService) so the bench flow reads its own
 * writes — scan, then refresh the thread — but failure-tolerant: a cache miss
 * is never worth failing the material record over. The edge endpoints alone
 * are not enough: the first consumption's WO and instance are new to every
 * cached graph, so the caller also passes the affected part lineage's version
 * rows — a part-focal cached thread always contains one of those.
 */
async function invalidateThreadCaches(itemIds: Array<string>): Promise<void> {
  try {
    await ThreadCacheService.invalidateForItems(itemIds)
  } catch (err) {
    serviceLogger.warn({ err }, 'Failed to invalidate thread cache')
  }
}

/** All version-row ids of a part lineage. */
async function lineageVersionIds(partMasterId: string): Promise<Array<string>> {
  const rows = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.masterId, partMasterId))
  return rows.map((r) => r.id)
}

export class WorkOrderMaterialService {
  /** All material lines consumed by a work order. */
  static async list(workOrderItemId: string): Promise<Array<MaterialLine>> {
    await getWorkOrderItem(workOrderItemId)

    const rows = await db
      .select({
        edgeId: itemRelationships.id,
        quantity: itemRelationships.quantity,
        createdAt: itemRelationships.createdAt,
        createdBy: itemRelationships.createdBy,
        targetItemId: items.id,
        targetItemType: items.itemType,
        targetItemNumber: items.itemNumber,
        targetName: items.name,
        targetState: items.state,
        targetRevision: items.revision,
        targetMasterId: items.masterId,
        ppInstanceKind: physicalParts.instanceKind,
        ppPartMasterId: physicalParts.partMasterId,
        ppSerialNumber: physicalParts.serialNumber,
        ppLotNumber: physicalParts.lotNumber,
      })
      .from(itemRelationships)
      .innerJoin(items, eq(itemRelationships.targetId, items.id))
      .leftJoin(physicalParts, eq(physicalParts.itemId, items.id))
      .where(
        and(
          eq(itemRelationships.sourceId, workOrderItemId),
          eq(itemRelationships.relationshipType, RELATIONSHIP_CONSUMES),
        ),
      )
      .orderBy(itemRelationships.createdAt)

    const lines: Array<MaterialLine> = []
    for (const row of rows) {
      const isPhysical = row.targetItemType === 'PhysicalPart'
      const partMasterId = isPhysical
        ? (row.ppPartMasterId ?? '')
        : row.targetMasterId

      // Resolve current part number/name for the lineage (display only)
      const [partInfo] = await db
        .select({ itemNumber: items.itemNumber, name: items.name })
        .from(items)
        .where(
          and(
            eq(items.masterId, partMasterId),
            eq(items.itemType, 'Part'),
            eq(items.isCurrent, true),
          ),
        )
        .limit(1)

      lines.push({
        edgeId: row.edgeId,
        kind: isPhysical
          ? ((row.ppInstanceKind ?? 'unit') as 'unit' | 'lot')
          : 'bulk',
        quantity: Number(row.quantity ?? 1),
        targetItemId: row.targetItemId,
        partMasterId,
        partItemNumber: isPhysical
          ? (partInfo?.itemNumber ?? null)
          : row.targetItemNumber,
        partName: isPhysical ? (partInfo?.name ?? null) : row.targetName,
        serialNumber: row.ppSerialNumber,
        lotNumber: row.ppLotNumber,
        partRevision: isPhysical ? null : row.targetRevision,
        physicalPartNumber: isPhysical ? row.targetItemNumber : null,
        physicalPartState: isPhysical ? row.targetState : null,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
      })
    }
    return lines
  }

  /**
   * Consume material on a work order. Branches on the part's trackingMode:
   * serial → register-on-consumption + atomic Available→Consumed;
   * lot → find-or-create lot, accumulate qty on one edge;
   * none → edge to the current part version row, accumulate qty.
   */
  static async consume(
    workOrderItemId: string,
    input: ConsumeMaterialInput,
    userId: string,
  ): Promise<Array<MaterialLine>> {
    const data = consumeMaterialSchema.parse(input)
    const wo = await getWorkOrderItem(workOrderItemId)
    assertWorkOrderOpen(wo)

    /** items.id of the consumed target, set per tracking branch */
    let consumedTargetId: string

    // Resolve the part's tracking mode (current version of the lineage).
    const [part] = await db
      .select({
        itemId: items.id,
        itemNumber: items.itemNumber,
        trackingMode: parts.trackingMode,
      })
      .from(items)
      .innerJoin(parts, eq(parts.itemId, items.id))
      .where(
        and(
          eq(items.masterId, data.partMasterId),
          eq(items.itemType, 'Part'),
          eq(items.isCurrent, true),
        ),
      )
      .limit(1)
    if (!part) throw new NotFoundError('Part', data.partMasterId)

    if (part.trackingMode === 'serial') {
      if (!data.serialNumber) {
        throw new ValidationError(
          `Part ${part.itemNumber} is serial-tracked — scan or enter the serial number`,
        )
      }
      // Register-on-consumption: the first scan creates the unit.
      const { physicalPart } = await PhysicalPartService.register(
        {
          partMasterId: data.partMasterId,
          serialNumber: data.serialNumber,
          notes: data.notes,
        },
        userId,
      )

      await db.transaction(async (tx) => {
        // Atomic compare-and-set guards double consumption: only an
        // Available unit can transition, and the edge rides the same txn.
        // Engine-level state write (same class as change-order release):
        // Available↔Consumed matches the seeded lifecycle exactly, and the
        // WI-2.2 transition endpoint adopts diverged stored state, so any
        // later manual transition reconciles cleanly. The CAS-plus-edge
        // atomicity is the reason this cannot ride transitionFreeItem().
        const claimed = await tx
          .update(items)
          .set({
            state: 'Consumed',
            modifiedBy: userId,
            modifiedAt: new Date(),
          })
          .where(
            and(eq(items.id, physicalPart.id), eq(items.state, 'Available')),
          )
          .returning({ id: items.id })
        if (claimed.length === 0) {
          throw new ValidationError(
            `Serial ${data.serialNumber} is ${physicalPart.state === 'Available' ? 'already being consumed' : physicalPart.state.toLowerCase()} — it cannot be consumed twice`,
          )
        }
        await tx.insert(itemRelationships).values({
          sourceId: workOrderItemId,
          targetId: physicalPart.id,
          relationshipType: RELATIONSHIP_CONSUMES,
          quantity: '1',
          createdBy: userId,
        })
      })
      consumedTargetId = physicalPart.id
    } else if (part.trackingMode === 'lot') {
      if (!data.lotNumber) {
        throw new ValidationError(
          `Part ${part.itemNumber} is lot-tracked — enter the lot number`,
        )
      }
      const quantity = data.quantity ?? 1
      const { physicalPart } = await PhysicalPartService.register(
        {
          partMasterId: data.partMasterId,
          lotNumber: data.lotNumber,
          notes: data.notes,
        },
        userId,
      )
      if (physicalPart.state === 'Scrapped') {
        throw new ValidationError(
          `Lot ${data.lotNumber} is scrapped and cannot be consumed`,
        )
      }
      await this.accumulateEdge(
        workOrderItemId,
        physicalPart.id,
        quantity,
        userId,
      )
      consumedTargetId = physicalPart.id
    } else {
      // Bulk: pin the exact current part version as the target.
      const quantity = data.quantity ?? 1
      if (data.serialNumber || data.lotNumber) {
        throw new ValidationError(
          `Part ${part.itemNumber} is not tracked — record a quantity only, or set its Tracking first`,
        )
      }
      await this.accumulateEdge(workOrderItemId, part.itemId, quantity, userId)
      consumedTargetId = part.itemId
    }

    await invalidateThreadCaches([
      workOrderItemId,
      consumedTargetId,
      ...(await lineageVersionIds(data.partMasterId)),
    ])

    return this.list(workOrderItemId)
  }

  /** One edge per (workOrder, target); repeated consumption adds quantity. */
  private static async accumulateEdge(
    workOrderItemId: string,
    targetItemId: string,
    quantity: number,
    userId: string,
  ) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(itemRelationships)
        .set({
          quantity: sql`${itemRelationships.quantity} + ${quantity}`,
        })
        .where(
          and(
            eq(itemRelationships.sourceId, workOrderItemId),
            eq(itemRelationships.targetId, targetItemId),
            eq(itemRelationships.relationshipType, RELATIONSHIP_CONSUMES),
          ),
        )
        .returning({ id: itemRelationships.id })
      if (updated.length === 0) {
        await tx.insert(itemRelationships).values({
          sourceId: workOrderItemId,
          targetId: targetItemId,
          relationshipType: RELATIONSHIP_CONSUMES,
          quantity: String(quantity),
          createdBy: userId,
        })
      }
    })
  }

  /**
   * Record units produced by a work order. Serial-tracked built parts only:
   * each serial is registered (find-or-create), stamped with
   * producingWorkOrderId + asBuiltItemId (the exact part version the WO
   * pins via partId), and linked with a Produces edge. Idempotent per
   * serial; a serial produced by a *different* WO is rejected — a unit is
   * born exactly once.
   */
  static async produce(
    workOrderItemId: string,
    serialNumbers: Array<string>,
    userId: string,
  ): Promise<Array<ProducedUnit>> {
    const wo = await getWorkOrderItem(workOrderItemId)
    if (wo.state === 'Cancelled') {
      throw new ValidationError(
        `Work order ${wo.itemNumber} is Cancelled — it cannot produce units`,
      )
    }

    const [woRow] = await db
      .select({ partId: workOrders.partId })
      .from(workOrders)
      .where(eq(workOrders.itemId, workOrderItemId))
      .limit(1)
    if (!woRow?.partId) {
      throw new ValidationError(
        `Work order ${wo.itemNumber} has no part — set the part it builds before recording produced units`,
      )
    }

    // The built part version the WO pins; its lineage is the unit's part.
    const [builtPart] = await db
      .select({
        id: items.id,
        masterId: items.masterId,
        itemNumber: items.itemNumber,
        trackingMode: parts.trackingMode,
      })
      .from(items)
      .innerJoin(parts, eq(parts.itemId, items.id))
      .where(eq(items.id, woRow.partId))
      .limit(1)
    if (!builtPart) throw new NotFoundError('Part', woRow.partId)
    if (builtPart.trackingMode !== 'serial') {
      throw new ValidationError(
        `Part ${builtPart.itemNumber} is not serial-tracked — set its Tracking to record produced serials`,
      )
    }

    const cleaned = [
      ...new Set(serialNumbers.map((s) => s.trim()).filter(Boolean)),
    ]
    if (cleaned.length === 0) {
      throw new ValidationError('Provide at least one serial number')
    }

    const producedUnitIds: Array<string> = []
    for (const serialNumber of cleaned) {
      const { physicalPart } = await PhysicalPartService.register(
        { partMasterId: builtPart.masterId, serialNumber },
        userId,
      )
      if (
        physicalPart.producingWorkOrderId &&
        physicalPart.producingWorkOrderId !== workOrderItemId
      ) {
        throw new ValidationError(
          `Serial ${serialNumber} was already produced by another work order — a unit is born exactly once`,
        )
      }
      await db.transaction(async (tx) => {
        await tx
          .update(physicalParts)
          .set({
            producingWorkOrderId: workOrderItemId,
            asBuiltItemId: woRow.partId,
          })
          .where(eq(physicalParts.itemId, physicalPart.id))
        const existingEdge = await tx
          .select({ id: itemRelationships.id })
          .from(itemRelationships)
          .where(
            and(
              eq(itemRelationships.sourceId, workOrderItemId),
              eq(itemRelationships.targetId, physicalPart.id),
              eq(itemRelationships.relationshipType, RELATIONSHIP_PRODUCES),
            ),
          )
          .limit(1)
        if (existingEdge.length === 0) {
          await tx.insert(itemRelationships).values({
            sourceId: workOrderItemId,
            targetId: physicalPart.id,
            relationshipType: RELATIONSHIP_PRODUCES,
            quantity: '1',
            createdBy: userId,
          })
        }
      })
      producedUnitIds.push(physicalPart.id)
    }

    await invalidateThreadCaches([
      workOrderItemId,
      ...producedUnitIds,
      ...(await lineageVersionIds(builtPart.masterId)),
    ])

    const produced = await this.listProduced(workOrderItemId)

    // For serial-tracked built parts, completed quantity is derived from
    // the units that actually exist — not from execution sign-offs.
    await db
      .update(workOrders)
      .set({ quantityCompleted: produced.length })
      .where(eq(workOrders.itemId, workOrderItemId))

    return produced
  }

  /** Units produced by a work order (Produces edges). */
  static async listProduced(
    workOrderItemId: string,
  ): Promise<Array<ProducedUnit>> {
    await getWorkOrderItem(workOrderItemId)

    const rows = await db
      .select({
        unitItemId: items.id,
        physicalPartNumber: items.itemNumber,
        state: items.state,
        serialNumber: physicalParts.serialNumber,
        partMasterId: physicalParts.partMasterId,
        asBuiltItemId: physicalParts.asBuiltItemId,
        createdAt: itemRelationships.createdAt,
      })
      .from(itemRelationships)
      .innerJoin(items, eq(itemRelationships.targetId, items.id))
      .innerJoin(physicalParts, eq(physicalParts.itemId, items.id))
      .where(
        and(
          eq(itemRelationships.sourceId, workOrderItemId),
          eq(itemRelationships.relationshipType, RELATIONSHIP_PRODUCES),
        ),
      )
      .orderBy(itemRelationships.createdAt)

    return rows
  }

  /** Remove a material line; consumed units return to Available. */
  static async remove(
    workOrderItemId: string,
    edgeId: string,
    userId: string,
  ): Promise<Array<MaterialLine>> {
    const wo = await getWorkOrderItem(workOrderItemId)
    assertWorkOrderOpen(wo)

    let removedTargetId = ''
    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(itemRelationships)
        .where(
          and(
            eq(itemRelationships.id, edgeId),
            eq(itemRelationships.sourceId, workOrderItemId),
            eq(itemRelationships.relationshipType, RELATIONSHIP_CONSUMES),
          ),
        )
        .returning({ targetId: itemRelationships.targetId })
      const edge = deleted[0]
      if (!edge) throw new NotFoundError('Material line', edgeId)
      removedTargetId = edge.targetId

      // Units go back to stock; lots/bulk targets have no state to revert.
      await tx
        .update(items)
        .set({ state: 'Available', modifiedBy: userId, modifiedAt: new Date() })
        .where(
          and(
            eq(items.id, edge.targetId),
            eq(items.itemType, 'PhysicalPart'),
            eq(items.state, 'Consumed'),
          ),
        )
    })

    // Resolve the removed target's part lineage (instance or bulk version row)
    const [removedTarget] = await db
      .select({
        masterId: items.masterId,
        ppPartMasterId: physicalParts.partMasterId,
      })
      .from(items)
      .leftJoin(physicalParts, eq(physicalParts.itemId, items.id))
      .where(eq(items.id, removedTargetId))
      .limit(1)
    const removedLineage =
      removedTarget?.ppPartMasterId ?? removedTarget?.masterId
    await invalidateThreadCaches([
      workOrderItemId,
      removedTargetId,
      ...(removedLineage ? await lineageVersionIds(removedLineage) : []),
    ])

    return this.list(workOrderItemId)
  }
}
