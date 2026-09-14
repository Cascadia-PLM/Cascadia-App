// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

export const checkoutPayloadSchema = z.object({
  itemMasterId: z.string().uuid(),
  /**
   * The version the branch tracks for this master at the time of the event;
   * null when the branch records the item as removed.
   */
  itemId: z.string().uuid().nullable(),
  branchId: z.string().uuid(),
  designId: z.string().uuid(),
})

export type CheckoutPayload = z.infer<typeof checkoutPayloadSchema>

/**
 * A user took the edit lock on an item for a branch. Emitted with the
 * `branch_items` write that records the lock, whether that write created the
 * tracking row or claimed an existing one.
 */
export const ITEM_CHECKED_OUT = defineDomainEvent({
  type: 'item.checked_out',
  schemaVersion: 1,
  description: 'An item was checked out on a branch',
  subjectType: 'item',
  payloadSchema: checkoutPayloadSchema,
})

/**
 * The lock was released, keeping the branch's changes. Recorded by a check-in,
 * and for each lock a change order's release checks in on its branch — with
 * the holder as the actor either way, as on every checkout fact.
 */
export const ITEM_CHECKED_IN = defineDomainEvent({
  type: 'item.checked_in',
  schemaVersion: 1,
  description: 'An item was checked in on a branch',
  subjectType: 'item',
  payloadSchema: checkoutPayloadSchema,
})

/**
 * The lock was released and the branch's uncommitted edits discarded.
 * Recorded by a cancelled checkout, and for each lock discarded in bulk: a
 * change order's cancellation, an item removed from a change order or a
 * workspace, a workspace deleted. A lock that moves with adoption is instead a
 * check-in on the workspace and a checkout on the change order's branch.
 */
export const ITEM_CHECKOUT_CANCELLED = defineDomainEvent({
  type: 'item.checkout_cancelled',
  schemaVersion: 1,
  description: 'A checkout was cancelled, discarding branch edits',
  subjectType: 'item',
  payloadSchema: checkoutPayloadSchema,
})
