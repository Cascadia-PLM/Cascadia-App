// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Checkout locks, and the facts that record them changing.
 *
 * `CheckoutService` changes one lock at a time, at a person's request. The
 * writers here change them as a side effect of something larger — a release,
 * a cancellation, an item leaving a change order or a workspace — and live
 * apart from it so the services doing those things can record the locks they
 * release without importing the checkout service, which imports most of them.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { branchItems } from '../db/schema'
import {
  ITEM_CHECKED_IN,
  ITEM_CHECKED_OUT,
  ITEM_CHECKOUT_CANCELLED,
  publishDomainEvent,
} from '../events'
import type { TransactionClient } from '../db'

type BranchItemRow = typeof branchItems.$inferSelect

/** A branch, and the design it belongs to: where a checkout fact happened. */
export interface LockScope {
  branchId: string
  designId: string
}

/**
 * The three checkout facts share one payload: which master, which version
 * the branch tracks, which branch, which design. `actorId` is the user whose
 * lock changed.
 */
export async function publishCheckoutEvent(
  tx: TransactionClient,
  definition:
    | typeof ITEM_CHECKED_OUT
    | typeof ITEM_CHECKED_IN
    | typeof ITEM_CHECKOUT_CANCELLED,
  row: BranchItemRow,
  branchId: string,
  designId: string,
  userId: string,
): Promise<void> {
  await publishDomainEvent(tx, definition, {
    actorId: userId,
    subject: { id: row.currentItemId ?? undefined, masterId: row.itemMasterId },
    context: { designId, branchId },
    payload: {
      itemMasterId: row.itemMasterId,
      itemId: row.currentItemId,
      branchId,
      designId,
    },
  })
}

/**
 * Release the checkout locks held on a branch — every one, or those on the
 * named masters — and record each release, in the caller's transaction.
 *
 * The writers that end a branch's working life used to clear `checkedOutBy`
 * with a bare update and record nothing: a release checked in every item on
 * the branch, a cancellation dropped every lock, and removing an item from a
 * change order or a workspace discarded its holder's claim. A projection of
 * "who has what checked out" built from `item.checked_out` therefore kept one
 * stuck lock per item per release. Each release is recorded here as the fact
 * the holder would have produced by hand: `item.checked_in` when the branch's
 * changes are kept, as by a release, and `item.checkout_cancelled` when they
 * are discarded.
 *
 * `actorId` is the holder, as on every checkout fact: the user whose lock
 * changed. Whoever caused the release is the actor of the fact that caused it.
 *
 * The rows are locked as they are read, so a checkout racing this either
 * commits first and is released here, or waits and finds the row released.
 */
export async function releaseBranchLocks(
  tx: TransactionClient,
  scope: LockScope & { itemMasterIds?: ReadonlyArray<string> },
  outcome: 'checked_in' | 'checkout_cancelled',
): Promise<number> {
  if (scope.itemMasterIds?.length === 0) return 0

  const held = await tx
    .select()
    .from(branchItems)
    .where(
      and(
        eq(branchItems.branchId, scope.branchId),
        isNotNull(branchItems.checkedOutBy),
        scope.itemMasterIds
          ? inArray(branchItems.itemMasterId, [...scope.itemMasterIds])
          : undefined,
      ),
    )
    .for('update')
  if (held.length === 0) return 0

  await tx
    .update(branchItems)
    .set({ checkedOutBy: null, checkedOutAt: null })
    .where(
      inArray(
        branchItems.id,
        held.map((row) => row.id),
      ),
    )

  const definition =
    outcome === 'checked_in' ? ITEM_CHECKED_IN : ITEM_CHECKOUT_CANCELLED
  for (const row of held) {
    if (!row.checkedOutBy) continue
    await publishCheckoutEvent(
      tx,
      definition,
      row,
      scope.branchId,
      scope.designId,
      row.checkedOutBy,
    )
  }
  return held.length
}

/**
 * Record a lock that moved with its branch row onto another branch.
 *
 * Adoption re-homes a workspace's branch rows onto a change order's branch,
 * locks and all: the holder keeps their claim, on a different branch. To a
 * consumer keyed on the branch and the master, that is a check-in on the
 * branch the row left — its changes kept, since they went with it — and a
 * checkout on the branch it joined.
 */
export async function recordLockTransfer(
  tx: TransactionClient,
  row: BranchItemRow,
  from: LockScope,
  to: LockScope,
): Promise<void> {
  if (!row.checkedOutBy) return
  await publishCheckoutEvent(
    tx,
    ITEM_CHECKED_IN,
    row,
    from.branchId,
    from.designId,
    row.checkedOutBy,
  )
  await publishCheckoutEvent(
    tx,
    ITEM_CHECKED_OUT,
    row,
    to.branchId,
    to.designId,
    row.checkedOutBy,
  )
}
