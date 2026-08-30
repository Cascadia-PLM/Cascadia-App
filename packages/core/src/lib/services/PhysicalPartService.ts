// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { PhysicalPart } from '@/lib/items/types/physical-part'
import { db } from '@/lib/db'
import { physicalPartAccessScopeCondition } from '@/lib/db/filters'
import { likeContains } from '@/lib/db/like-pattern'
import { items, parts, physicalParts } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { ItemService } from '@/lib/items/services/ItemService'

/**
 * Registration and lookup for PhysicalParts (serialized units and lots).
 *
 * Register is find-or-create on the traceability identity
 * (partMasterId + serialNumber|lotNumber) so register-on-consumption can
 * call it blindly: the first scan of a serial creates the record, every
 * later scan returns it. See docs/features/physical-parts-and-traceability.md.
 */

export const physicalPartRegisterSchema = z
  .object({
    partMasterId: z.string().uuid({ message: 'Part is required' }),
    serialNumber: z.string().trim().min(1).max(200).optional(),
    lotNumber: z.string().trim().min(1).max(200).optional(),
    manufacturerPartId: z.string().uuid().optional(),
    erpRef: z.string().max(200).optional(),
    notes: z.string().max(5000).optional(),
  })
  .refine((v) => !!v.serialNumber !== !!v.lotNumber, {
    message: 'Provide exactly one of serialNumber or lotNumber',
  })

export type PhysicalPartRegisterInput = z.infer<
  typeof physicalPartRegisterSchema
>

export interface RegisterResult {
  physicalPart: PhysicalPartRecord
  /** false when the identity already existed (idempotent re-register) */
  created: boolean
}

/** Joined item + physical_parts row returned by lookups. */
export interface PhysicalPartRecord {
  id: string
  itemNumber: string
  name: string | null
  state: string
  instanceKind: 'unit' | 'lot'
  partMasterId: string
  serialNumber: string | null
  lotNumber: string | null
  manufacturerPartId: string | null
  asBuiltItemId: string | null
  producingWorkOrderId: string | null
  erpRef: string | null
  notes: string | null
  createdAt: Date
  /** Current version of the referenced Part lineage (for display) */
  partItemNumber: string | null
  partName: string | null
}

const recordColumns = {
  id: items.id,
  itemNumber: items.itemNumber,
  name: items.name,
  state: items.state,
  instanceKind: physicalParts.instanceKind,
  partMasterId: physicalParts.partMasterId,
  serialNumber: physicalParts.serialNumber,
  lotNumber: physicalParts.lotNumber,
  manufacturerPartId: physicalParts.manufacturerPartId,
  asBuiltItemId: physicalParts.asBuiltItemId,
  producingWorkOrderId: physicalParts.producingWorkOrderId,
  erpRef: physicalParts.erpRef,
  notes: physicalParts.notes,
  createdAt: items.createdAt,
  // Scalar subqueries (not joins) so branch copies with isCurrent=true can
  // never fan a physical part out into duplicate rows.
  partItemNumber: sql<
    string | null
  >`(select i.item_number from items i where i.master_id = ${physicalParts.partMasterId} and i.is_current = true and i.item_type = 'Part' order by i.created_at desc limit 1)`,
  partName: sql<
    string | null
  >`(select i.name from items i where i.master_id = ${physicalParts.partMasterId} and i.is_current = true and i.item_type = 'Part' order by i.created_at desc limit 1)`,
}

export class PhysicalPartService {
  /**
   * Find-or-create a physical instance by its traceability identity.
   * Validates the part's trackingMode matches the identity kind.
   */
  static async register(
    input: PhysicalPartRegisterInput,
    userId: string,
  ): Promise<RegisterResult> {
    const data = physicalPartRegisterSchema.parse(input)
    const instanceKind = data.serialNumber ? 'unit' : 'lot'

    // Resolve the current Part version for this lineage.
    const [part] = await db
      .select({
        itemId: items.id,
        name: items.name,
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

    const requiredMode = instanceKind === 'unit' ? 'serial' : 'lot'
    if (part.trackingMode !== requiredMode) {
      throw new ValidationError(
        `Part ${part.itemNumber} is ${
          part.trackingMode === 'none'
            ? 'not tracked'
            : `${part.trackingMode}-tracked`
        }; a ${instanceKind === 'unit' ? 'serial number' : 'lot number'} requires trackingMode '${requiredMode}'. Update the part's Tracking setting first.`,
      )
    }

    const existing = await this.findByIdentity(data.partMasterId, {
      serialNumber: data.serialNumber,
      lotNumber: data.lotNumber,
    })
    if (existing) return { physicalPart: existing, created: false }

    const identityLabel = data.serialNumber
      ? `SN ${data.serialNumber}`
      : `Lot ${data.lotNumber}`

    try {
      const created = await ItemService.create<PhysicalPart>(
        'PhysicalPart',
        {
          itemType: 'PhysicalPart',
          name: `${part.name ?? part.itemNumber} · ${identityLabel}`,
          instanceKind,
          partMasterId: data.partMasterId,
          serialNumber: data.serialNumber,
          lotNumber: data.lotNumber,
          manufacturerPartId: data.manufacturerPartId,
          erpRef: data.erpRef,
          notes: data.notes,
        },
        userId,
      )
      const physicalPart = await this.getById(created.id!)
      return { physicalPart, created: true }
    } catch (error) {
      // Unique violation → another request registered the same identity
      // concurrently. Return the winner; register stays idempotent.
      if ((error as { code?: string }).code === '23505') {
        const winner = await this.findByIdentity(data.partMasterId, {
          serialNumber: data.serialNumber,
          lotNumber: data.lotNumber,
        })
        if (winner) return { physicalPart: winner, created: false }
      }
      throw error
    }
  }

  static async getById(itemId: string): Promise<PhysicalPartRecord> {
    const [row] = await db
      .select(recordColumns)
      .from(items)
      .innerJoin(physicalParts, eq(physicalParts.itemId, items.id))
      .where(eq(items.id, itemId))
      .limit(1)
    if (!row) throw new NotFoundError('PhysicalPart', itemId)
    return row as PhysicalPartRecord
  }

  static async findByIdentity(
    partMasterId: string,
    identity: { serialNumber?: string; lotNumber?: string },
  ): Promise<PhysicalPartRecord | null> {
    const identityCondition = identity.serialNumber
      ? eq(physicalParts.serialNumber, identity.serialNumber)
      : identity.lotNumber
        ? eq(physicalParts.lotNumber, identity.lotNumber)
        : null
    if (!identityCondition) {
      throw new ValidationError('serialNumber or lotNumber is required')
    }

    const [row] = await db
      .select(recordColumns)
      .from(items)
      .innerJoin(physicalParts, eq(physicalParts.itemId, items.id))
      .where(
        and(eq(physicalParts.partMasterId, partMasterId), identityCondition),
      )
      .limit(1)
    return (row as PhysicalPartRecord | undefined) ?? null
  }

  /**
   * The index for physical instances.
   *
   * `accessDesignIds` is the caller's reach, and it is **required** rather than
   * optional on purpose. Every other field here is a user-supplied filter, and
   * for as long as this one was absent the only list path for the type ran with
   * no boundary at all: one request returned every serial, lot, ERP reference
   * and technician note in the instance to anyone holding `physical_parts:read`
   * — which all five seeded roles do. Requiring it costs the single production
   * caller one argument and makes a future caller state its scope rather than
   * inherit "everything" by omission. `WorkOrderService.search` takes the same
   * axis optionally; that shape fails open, and is not worth copying.
   *
   * `null` is cross-program authority, matching
   * `AccessControlService.getAccessibleDesignIds`. An empty array is **not**
   * null and must not be treated as one: it says the caller reaches no design,
   * and the guard below is on truthiness for exactly that reason. `[]` still
   * builds the predicate — `inArray(col, [])` compiles to `false`, so the
   * lineage disjunct goes false while the design-less disjunct keeps admitting
   * the units the by-id gate ungates. A `.length > 0` guard here would skip the
   * predicate entirely and hand the whole table to the one caller with the
   * least reach of all.
   *
   * The predicate itself is `physicalPartAccessScopeCondition`, the same
   * expression `accessScopeCondition` scopes `GET /api/v1/items` on and the
   * one-query twin of `requirePhysicalPartAccess`. Reusing it rather than
   * hand-rolling the rule is what keeps this list and the by-id routes from
   * answering one question two ways — including its deliberate fail-*open* on
   * a lineage that carries no design.
   */
  static async search(criteria: {
    q?: string
    partMasterId?: string
    instanceKind?: 'unit' | 'lot'
    state?: string
    accessDesignIds: Array<string> | null
    limit?: number
  }): Promise<Array<PhysicalPartRecord>> {
    const limit = Math.min(criteria.limit ?? 100, 500)
    const conditions = []

    if (criteria.accessDesignIds) {
      conditions.push(
        physicalPartAccessScopeCondition(criteria.accessDesignIds),
      )
    }

    if (criteria.q) {
      const term = likeContains(criteria.q)
      conditions.push(
        or(
          ilike(physicalParts.serialNumber, term),
          ilike(physicalParts.lotNumber, term),
          ilike(items.itemNumber, term),
          ilike(items.name, term),
        ),
      )
    }
    if (criteria.partMasterId) {
      conditions.push(eq(physicalParts.partMasterId, criteria.partMasterId))
    }
    if (criteria.instanceKind) {
      conditions.push(eq(physicalParts.instanceKind, criteria.instanceKind))
    }
    if (criteria.state) {
      conditions.push(eq(items.state, criteria.state))
    }

    const rows = await db
      .select(recordColumns)
      .from(items)
      .innerJoin(physicalParts, eq(physicalParts.itemId, items.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(items.createdAt))
      .limit(limit)

    return rows as Array<PhysicalPartRecord>
  }
}
