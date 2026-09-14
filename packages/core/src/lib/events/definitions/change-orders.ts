// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

const releasedItemSchema = z.object({
  /** The version row that reached main (or was obsoleted / removed). */
  itemId: z.string().uuid(),
  /**
   * The version this one supersedes, when the release minted a new row —
   * null when the same row stayed current (a state-only release, a promote,
   * an obsolete) or when the item is new. A consumer that has to act on the
   * outgoing revision rather than the incoming one needs the row, not just
   * its letter: `previousRevision` cannot be resolved back to a version
   * because a master carries the same letter on more than one row over its
   * life.
   */
  previousItemId: z.string().uuid().nullable(),
  masterId: z.string().uuid(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  itemType: z.string(),
  /** Empty string when the item is new in this release. */
  previousRevision: z.string(),
  newRevision: z.string(),
  changeType: z.enum(['modified', 'added', 'deleted']),
  /**
   * The affected-item action behind this entry, or null for branch content
   * merged to main.
   */
  action: z.enum(['revise', 'release', 'promote', 'obsolete']).nullable(),
})

export const designReleasedPayloadSchema = z.object({
  changeOrderId: z.string().uuid(),
  /**
   * How the change order names itself to a person — `releaseLabel`'s
   * rendering, e.g. "ECO-000042 (Engineering Change Order)". Carried because
   * a consumer writing human-facing text (a watermark's reason, a webhook's
   * summary) would otherwise have to read the change order back, and the
   * label it reads then is not necessarily the one that released.
   */
  changeOrderLabel: z.string(),
  designId: z.string().uuid(),
  /**
   * The change-order branch that was merged; null when this summary covers
   * affected-item actions applied without a merge — a branchless release, or
   * the pass that follows a branch merge.
   */
  branchId: z.string().uuid().nullable(),
  /** The branch the release landed on (main). */
  targetBranchId: z.string().uuid(),
  /** The merge commit, or the release commit of a branchless release. */
  mergeCommitId: z.string().uuid(),
  /** itemNumber → newly assigned revision letter. */
  revisionsAssigned: z.record(z.string(), z.string()),
  /** Per-item outcome of the release on this design. */
  items: z.array(releasedItemSchema),
})

export type DesignReleasedPayload = z.infer<typeof designReleasedPayloadSchema>

/**
 * A change order released on one design: its branch merged to main with
 * revisions assigned, or affected-item actions applied to the design's items.
 * Emitted **inside** the transaction that released them, after that design's
 * per-item events — the fact the ERP sync, the superseded watermark, the
 * work-instruction alert and the audit anchor key on.
 *
 * Once per design **per release pass**, not once per design. A design whose
 * branch merged and which also carries affected-item actions the merge did not
 * perform — a promote, an obsolete, a revise with no working copy — receives
 * two: the merge's, carrying its `branchId`, and the post-merge pass's, with a
 * null `branchId` and a release commit of its own, covering only what that
 * pass released. The two item lists are disjoint. A change order spanning
 * several designs emits these for each, all before the single
 * `change_order.released` that closes the release.
 * `correlationId` is the change order's id on every event of a release, so a
 * consumer can group them without parsing payloads.
 */
export const DESIGN_RELEASED = defineDomainEvent({
  type: 'design.released',
  schemaVersion: 1,
  description:
    'A change order released on one design: merged or applied, revisions assigned',
  subjectType: 'design',
  payloadSchema: designReleasedPayloadSchema,
})

export const changeOrderReleasedPayloadSchema = z.object({
  changeOrderId: z.string().uuid(),
  changeOrderNumber: z.string(),
  /** Every design the change order links, released or not. */
  designIds: z.array(z.string().uuid()),
  /**
   * One entry per release pass per design — a branch merge, or the affected
   * items released without one — naming the commit that recorded it (the
   * merge commit or the release commit) and the revisions it assigned. A
   * design released by both passes appears twice, as it has two
   * `design.released` facts. Read from those commits, so a release finished
   * by a retry still reports what the first attempt merged.
   */
  releases: z.array(
    z.object({
      designId: z.string().uuid(),
      mergeCommitId: z.string().uuid().nullable(),
      revisionsAssigned: z.record(z.string(), z.string()),
    }),
  ),
  totalRevisionsAssigned: z.number().int(),
})

export type ChangeOrderReleasedPayload = z.infer<
  typeof changeOrderReleasedPayloadSchema
>

/**
 * A change order completed its release — every design merged or applied,
 * and the lifecycle reached its `finalKind: 'release'` state. Emitted in the
 * transaction that writes that final state (after `lifecycle.transitioned`),
 * which is the last write of a release: by the time a consumer sees this
 * event, every `design.released` and `item.released` of the same change
 * order is already visible below it.
 */
export const CHANGE_ORDER_RELEASED = defineDomainEvent({
  type: 'change_order.released',
  schemaVersion: 1,
  description:
    'A change order completed its release across every design it links',
  subjectType: 'change_order',
  payloadSchema: changeOrderReleasedPayloadSchema,
})

export const changeOrderCancelledPayloadSchema = z.object({
  changeOrderId: z.string().uuid(),
  changeOrderNumber: z.string(),
  designIds: z.array(z.string().uuid()),
})

export type ChangeOrderCancelledPayload = z.infer<
  typeof changeOrderCancelledPayloadSchema
>

/**
 * A change order was cancelled: its branches archived unmerged and the
 * lifecycle reached its `finalKind: 'cancel'` state. Emitted in the
 * transaction that writes that final state.
 */
export const CHANGE_ORDER_CANCELLED = defineDomainEvent({
  type: 'change_order.cancelled',
  schemaVersion: 1,
  description: 'A change order was cancelled without releasing',
  subjectType: 'change_order',
  payloadSchema: changeOrderCancelledPayloadSchema,
})
