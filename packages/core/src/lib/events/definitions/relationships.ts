// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

/**
 * Both ends of the edge, and the line's own three values.
 *
 * **Master ids as well as version ids, on both ends.** The relationship table
 * references item *version* rows, so a version id alone is useless to a
 * consumer across revisions: the edge from rev A of an assembly to rev C of a
 * screw is, to anything outside this database, the same BOM line as the one
 * from rev B to rev C. The master id is the identity that survives a release.
 *
 * **Quantity, reference designator and find number are carried**, which is a
 * deliberate and documented exception to "payloads state what happened, not
 * values". For a BOM line those three *are* what happened — they are the line.
 * They are three scalars, and while the commit does carry two of them inside a
 * free-form JSON field, a consumer should not have to fetch and parse a commit
 * to read a quantity.
 */
const relationshipIdentity = {
  relationshipId: z.string().uuid(),
  /** `BOM`, `Reference`, `Consumes`, … */
  relationshipType: z.string(),

  /** The version row the edge starts at, and the identity behind it. */
  sourceId: z.string().uuid(),
  sourceMasterId: z.string().uuid(),
  sourceItemType: z.string(),
  sourceItemNumber: z.string(),

  /** The version row the edge points at, and the identity behind it. */
  targetId: z.string().uuid(),
  targetMasterId: z.string().uuid(),
  targetItemType: z.string(),
  targetItemNumber: z.string(),

  /** The design the source belongs to; null for an item outside one. */
  designId: z.string().uuid().nullable(),

  /** Decimal, as a string — the column is `numeric(10,3)`. */
  quantity: z.string().nullable(),
  referenceDesignator: z.string().nullable(),
  findNumber: z.number().int().nullable(),
}

export const relationshipAddedPayloadSchema = z.object(relationshipIdentity)
export type RelationshipAddedPayload = z.infer<
  typeof relationshipAddedPayloadSchema
>

/**
 * A structure edge was created by hand.
 *
 * ## The boundary, which a consumer must read before trusting this stream
 *
 * `relationship.*` is the **hand-edited structure stream**. It is scoped to the
 * writes a person drives through the UI or an API call —
 * `ItemRelationshipService`'s mutators, one edge at a time or in a batch, and
 * the usage copies that pull an existing subtree into a design — and it is
 * deliberately *not* complete genealogy. Read as complete, it will be wrong,
 * and wrong in a direction that matters.
 *
 * Silent by design:
 *
 * - **The version-carry path.** Every working-copy mint, rebase and release
 *   re-creates the same logical edges onto a new version row. Those are not new
 *   BOM lines — nobody edited anything — and emitting them would turn a single
 *   checkout into a structure storm.
 * - **The release's re-pointing** of edges onto the revision that reached main,
 *   for the same reason.
 * - **`Consumes`, `Produces` and `Evidences` edges**, which the work-order and
 *   qualification services write. Those are physical traceability rather than
 *   engineering structure, and their facts belong to the work-order family.
 * - **MBOM generation and the design-clone job**, which copy a whole design's
 *   structure in one operation: the volume paths `item.updated` describes.
 *
 * So: this stream answers "what did somebody change about the structure", not
 * "what is the structure". For the latter, read the BOM.
 */
export const RELATIONSHIP_ADDED = defineDomainEvent({
  type: 'relationship.added',
  schemaVersion: 1,
  description: 'A structure edge was created',
  subjectType: 'item',
  payloadSchema: relationshipAddedPayloadSchema,
})

export const relationshipRemovedPayloadSchema = z.object(relationshipIdentity)
export type RelationshipRemovedPayload = z.infer<
  typeof relationshipRemovedPayloadSchema
>

/**
 * A structure edge was deleted by hand.
 *
 * The payload carries the values the edge **had** — a consumer reacting to a
 * removal needs to know what was removed, and by the time it reads the event
 * there is nothing left to look up. Same boundary as `relationship.added`.
 */
export const RELATIONSHIP_REMOVED = defineDomainEvent({
  type: 'relationship.removed',
  schemaVersion: 1,
  description: 'A structure edge was removed',
  subjectType: 'item',
  payloadSchema: relationshipRemovedPayloadSchema,
})

export const relationshipUpdatedPayloadSchema = z.object({
  ...relationshipIdentity,
  /**
   * Which of the line's properties changed, in the `item.updated` style rather
   * than one event type per property. Values above are the new ones.
   */
  changedFields: z.array(z.string()).min(1),
})
export type RelationshipUpdatedPayload = z.infer<
  typeof relationshipUpdatedPayloadSchema
>

/**
 * A structure edge's own properties changed — quantity, reference designator,
 * find number.
 *
 * Never emitted when nothing changed: a save that submits the same values is
 * not an edit, and the schema forbids an empty `changedFields` anyway. Same
 * boundary as `relationship.added`.
 */
export const RELATIONSHIP_UPDATED = defineDomainEvent({
  type: 'relationship.updated',
  schemaVersion: 1,
  description: "A structure edge's quantity or position changed",
  subjectType: 'item',
  payloadSchema: relationshipUpdatedPayloadSchema,
})
