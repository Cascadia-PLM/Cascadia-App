// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

const itemIdentity = {
  itemId: z.string().uuid(),
  masterId: z.string().uuid(),
  itemType: z.string(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  designId: z.string().uuid().nullable(),
  revision: z.string(),
  state: z.string(),
}

export const itemUpdatedPayloadSchema = z.object({
  ...itemIdentity,
  /** The branch the edit landed on; null for an item outside any design. */
  branchId: z.string().uuid().nullable(),
  /**
   * Names of the fields whose values changed. The values themselves live on
   * the commit — payloads state what happened, not the new content.
   */
  changedFields: z.array(z.string()).min(1),
  commitId: z.string().uuid().nullable(),
})

export type ItemUpdatedPayload = z.infer<typeof itemUpdatedPayloadSchema>

/**
 * An item's content changed. Emitted in the transaction that wrote the
 * change — a direct edit on main or an outside-design item, a working-copy
 * save on an ECO or workspace branch (both the first save and every later
 * one), a lifecycle-field write by the release machinery (which also emits
 * `item.released`), or a change order's state restamped from the workflow
 * instance it starts, when that moves it. Never emitted for a save that
 * changed nothing.
 *
 * ## What this does NOT fire for
 *
 * More than a dozen non-test files write the `items` table outside `ItemService`, so
 * "every change to an item fires `item.updated`" is **not** true of this
 * codebase and a rule written on that assumption will be wrong. Each writer
 * has a verdict; the exempt ones are exempt for a reason, not by oversight.
 *
 * **Covered by a more specific fact — read that one instead:**
 *
 * - A lifecycle transition writes `state`, `modifiedAt` and `modifiedBy`
 *   directly (`LifecycleInstanceService`). It is `lifecycle.transitioned`, and
 *   a rule keyed on "any change to this item" would otherwise miss the single
 *   most important change in a PLM system.
 * - The release machinery's own writes — revision assignment, supersession,
 *   conflict resolution onto a working copy (`ChangeOrderMergeService`,
 *   `ConflictDetectionService`) — are `item.released` and `item.obsoleted`,
 *   with `design.released` summarising the design.
 * - A change order's own milestones are `change_order.released` and
 *   `change_order.cancelled` (`ChangeOrderService`).
 * - Deleting a workspace, or removing a draft from one, hard-deletes the draft
 *   (`BranchService`). It is `item.deleted`, one per draft.
 * - A usage copied into a design is a new master (`UsageService`). It is
 *   `item.created`.
 *
 * **Derived bookkeeping, not a content edit:**
 *
 * - `inDesignStructure` toggling, wherever it happens — the designation helper,
 *   `ItemRelationshipService`, `UsageService`, and the design structure route.
 *   It is a presentation flag recomputed from structure, so the fact worth
 *   subscribing to is the structure edge, not its shadow on the item row.
 * - `lockedBy` / `lockedAt` on the item detail route. An advisory lock is not
 *   an edit; nothing about the item's content changed.
 *
 * **Volume paths, deliberately silent:**
 *
 * - The design-clone job and MBOM generation each mint thousands of masters in
 *   one operation. Emitting per row would flood the log and every matching
 *   webhook subscription for something the jobs system already reports as one
 *   completion. If a consumer ever needs it the right shape is a single
 *   `design.cloned` summary, not ten thousand `item.created`.
 *
 * **Known gaps, with their fixes named rather than discovered:**
 *
 * - `WorkOrderMaterialService` writes `state: 'Consumed'` and back to
 *   `'Available'` on physical parts directly. That is a real state change with
 *   no fact behind it; the consumption edge is the thing worth minting, and it
 *   is a catalog question rather than an emission one.
 * - The item detail route's properties handler writes `name` and `state`
 *   straight to the base table with no service in between. It already computes
 *   an `updatedFields` list, so an emit is cheap — it is listed here rather
 *   than done because the same handler writes `state` directly, which is a
 *   lifecycle-rule question that wants settling first.
 * - `work-instructions` reassigns an output part's `designId` on creation.
 */
export const ITEM_UPDATED = defineDomainEvent({
  type: 'item.updated',
  schemaVersion: 1,
  description: "An item's fields changed; the commit carries the values",
  subjectType: 'item',
  payloadSchema: itemUpdatedPayloadSchema,
})

export const itemDeletedPayloadSchema = z.object(itemIdentity)

export type ItemDeletedPayload = z.infer<typeof itemDeletedPayloadSchema>

/**
 * An item ceased to exist for every reader.
 *
 * Two shapes, and the distinction is `context.branchId`. Without it, a hard
 * delete off `main` — the row and everything cascading from it, gone. With it,
 * the retirement of a branch-born draft that never left its branch: created by
 * `createOnBranch` and destroyed by `deleteOnBranch` before any release, so no
 * other reader ever saw it and nothing downstream of `main` is affected.
 *
 * Deliberately *not* this: deleting an item that exists on `main`. That is a
 * branch-scoped deletion, it is a commit on the branch, and it reaches `main`
 * as an `item.released` carrying `changeType: 'deleted'` — the item is retired
 * through its lifecycle rather than removed.
 */
export const ITEM_DELETED = defineDomainEvent({
  type: 'item.deleted',
  schemaVersion: 1,
  description: 'An item was deleted',
  subjectType: 'item',
  payloadSchema: itemDeletedPayloadSchema,
})

export const itemObsoletedPayloadSchema = z.object({
  changeOrderId: z.string().uuid(),
  designId: z.string().uuid(),
  itemId: z.string().uuid(),
  masterId: z.string().uuid(),
  itemType: z.string(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  /** The revision that was obsoleted; obsoleting keeps it. */
  revision: z.string(),
})

export type ItemObsoletedPayload = z.infer<typeof itemObsoletedPayloadSchema>

/**
 * A change order's 'obsolete' action moved an item into its obsolete state.
 * Emitted inside the release transaction, in place of `item.released`, so an
 * ERP consumer can retire the part without inspecting a payload.
 */
export const ITEM_OBSOLETED = defineDomainEvent({
  type: 'item.obsoleted',
  schemaVersion: 1,
  description: 'A change order obsoleted an item',
  subjectType: 'item',
  payloadSchema: itemObsoletedPayloadSchema,
})
