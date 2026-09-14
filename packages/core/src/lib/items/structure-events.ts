// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Structure facts: the payload every `relationship.*` event carries, and the
 * recording of edges written in bulk.
 */

import { inArray } from 'drizzle-orm'
import { items } from '../db/schema'
import { publishDomainEvent } from '../events'
import type { RELATIONSHIP_ADDED, RELATIONSHIP_REMOVED } from '../events'
import type { itemRelationships } from '../db/schema'
import type { TransactionClient } from '../db'

type Edge = typeof itemRelationships.$inferSelect

/** One end of a structure edge, as a structure fact names it. */
export interface StructureEnd {
  id: string
  masterId: string
  itemType: string
  itemNumber: string
  designId?: string | null
}

/**
 * The shape all three structure events share.
 *
 * Both ends carry a master id as well as a version id, because the table
 * references item *version* rows and a version id alone is useless to a
 * consumer across revisions. The line's three scalars ride along — a
 * documented exception to "payloads state what happened, not values",
 * because for a BOM line those three *are* what happened.
 */
export function structurePayload(
  edge: Edge,
  source: StructureEnd,
  target: StructureEnd,
) {
  return {
    relationshipId: edge.id,
    relationshipType: edge.relationshipType,
    sourceId: source.id,
    sourceMasterId: source.masterId,
    sourceItemType: source.itemType,
    sourceItemNumber: source.itemNumber,
    targetId: target.id,
    targetMasterId: target.masterId,
    targetItemType: target.itemType,
    targetItemNumber: target.itemNumber,
    designId: source.designId ?? null,
    quantity: edge.quantity,
    referenceDesignator: edge.referenceDesignator,
    findNumber: edge.findNumber,
  }
}

/**
 * Record structure edges written in bulk, one fact per edge, in the caller's
 * transaction.
 *
 * For the writers that add or clear many edges at once rather than through
 * `ItemRelationshipService`'s one-at-a-time mutators: its batch path, and the
 * usage copies that bring an existing subtree into a design. Both ends of
 * every edge are read in one query, so a batch costs one read rather than two
 * per edge. For a removal, pass the rows the delete returned: the items at
 * both ends outlive the edge.
 */
export async function publishStructureEdges(
  tx: TransactionClient,
  definition: typeof RELATIONSHIP_ADDED | typeof RELATIONSHIP_REMOVED,
  edges: ReadonlyArray<{ edge: Edge; actorId: string | null }>,
): Promise<void> {
  if (edges.length === 0) return

  const endIds = [
    ...new Set(edges.flatMap(({ edge }) => [edge.sourceId, edge.targetId])),
  ]
  const ends = new Map(
    (
      await tx
        .select({
          id: items.id,
          masterId: items.masterId,
          itemType: items.itemType,
          itemNumber: items.itemNumber,
          designId: items.designId,
        })
        .from(items)
        .where(inArray(items.id, endIds))
    ).map((end) => [end.id, end]),
  )

  for (const { edge, actorId } of edges) {
    const source = ends.get(edge.sourceId)
    const target = ends.get(edge.targetId)
    // Both ends are foreign keys, so neither can be missing inside the
    // transaction that wrote the edge.
    if (!source || !target) continue
    await publishDomainEvent(tx, definition, {
      actorId,
      subject: { id: source.id, masterId: source.masterId },
      context: { designId: source.designId ?? undefined },
      payload: structurePayload(edge, source, target),
    })
  }
}
