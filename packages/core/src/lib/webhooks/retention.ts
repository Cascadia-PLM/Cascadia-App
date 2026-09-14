// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import type { DbInstance } from '@/lib/db'
import { webhookDeliveries, webhookSubscriptions } from '@/lib/db/schema'
import { webhookLogger } from '@/lib/logging/logger'

/**
 * Retention for the delivery log.
 *
 * `webhook_deliveries` grows at events times subscriptions, and it ships with
 * its pruner rather than after it — nothing else in this tree prunes anything,
 * and a delivery log is the fastest-growing table the event wave adds.
 *
 * **This rides stage 3's prune job rather than adding a second maintenance
 * type.** One type means one set of scheduler-suite count updates instead of a
 * second round of the same churn, and the two horizons have nothing to do with
 * each other — the event log's floor is the minimum consumer cursor, while a
 * delivery's fate is already settled the moment it stops being pending. So: two
 * functions behind one handler.
 *
 * **A pending row is never deleted, whatever its age.** Expiry is the pump's
 * decision and carries its own reason and its own status; deleting a pending row
 * here would silently drop a delivery a receiver is still owed, and would do it
 * with no record at all.
 *
 * The one pending row this does touch is a deleted subscription's, which no
 * receiver is owed and the pump will never visit. It is expired, with a reason,
 * and then ages out like any other settled row.
 */

/** Days of delivery history kept by default. */
export const DEFAULT_DELIVERY_RETENTION_DAYS = 30

/** Rows deleted per statement, so a large backlog is not one long lock. */
const DEFAULT_BATCH_SIZE = 1000

/** Batches per run, so one job cannot run for an unbounded time. */
const DEFAULT_MAX_BATCHES = 50

export interface PruneDeliveriesOptions {
  /** Delete settled deliveries last updated before this. */
  cutoff: Date
  batchSize?: number
  maxBatches?: number
  signal?: AbortSignal
  /** The expiry stamp's clock; injectable for tests. */
  now?: Date
}

export interface PruneDeliveriesResult {
  deleted: number
  batches: number
  /** More remained than `maxBatches` allowed — the next run continues. */
  hasMore: boolean
  /**
   * Pending deliveries of deleted subscriptions, expired by this run. Nothing
   * would ever have sent them.
   */
  expired: number
  /**
   * Pending rows older than the cutoff that a live subscription is still owed,
   * left alone and reported.
   */
  pendingSkipped: number
}

/** The fixed error a deleted subscription's pending delivery is expired with. */
export const DELETED_SUBSCRIPTION_EXPIRY_ERROR =
  'Expired: the subscription was deleted before this was delivered'

/**
 * Delete settled deliveries older than the cutoff, in batches.
 *
 * Select-ids-then-delete-by-id, like the event pruner: a single
 * `DELETE … WHERE updated_at < $1` over a large table takes one lock for its
 * whole duration, and the pump is writing to the same rows.
 */
export async function pruneWebhookDeliveries(
  database: DbInstance,
  options: PruneDeliveriesOptions,
): Promise<PruneDeliveriesResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES
  const now = options.now ?? new Date()

  // First, what nothing will ever settle. Deleting a subscription expires its
  // pending rows in the same transaction; these are the rows a fan-out already
  // running at that moment inserted after it, which would otherwise stay
  // pending for good — and keep the warning below firing for a healthy pump.
  let expired = 0
  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (options.signal?.aborted) break

    const orphans = await database
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId),
      )
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          isNotNull(webhookSubscriptions.deletedAt),
        ),
      )
      .limit(batchSize)

    if (orphans.length === 0) break

    await database
      .update(webhookDeliveries)
      .set({
        status: 'expired',
        error: DELETED_SUBSCRIPTION_EXPIRY_ERROR,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            webhookDeliveries.id,
            orphans.map((row) => row.id),
          ),
          eq(webhookDeliveries.status, 'pending'),
        ),
      )

    expired += orphans.length
    if (orphans.length < batchSize) break
  }

  let deleted = 0
  let batches = 0
  let hasMore = false

  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (options.signal?.aborted) {
      hasMore = true
      break
    }

    const candidates = await database
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          // Never a pending row. This is the whole safety property of the
          // function, and it is a `ne` rather than an `inArray` of the three
          // settled statuses on purpose: a status added later is excluded by
          // default only if the predicate names what must survive.
          ne(webhookDeliveries.status, 'pending'),
          lt(webhookDeliveries.updatedAt, options.cutoff),
        ),
      )
      .limit(batchSize)

    if (candidates.length === 0) break

    await database.delete(webhookDeliveries).where(
      inArray(
        webhookDeliveries.id,
        candidates.map((row) => row.id),
      ),
    )

    deleted += candidates.length
    batches += 1

    if (candidates.length < batchSize) break
    if (batch === maxBatches - 1) hasMore = true
  }

  // Reported rather than acted on: a pile of ancient pending rows means the pump
  // is not running, which is an operational fact worth surfacing and not
  // something a pruner should paper over by deleting them. Counted over the
  // subscriptions the pump actually sends for — a disabled subscription's
  // backlog is waiting for an operator, not for a pump.
  const [pending] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .innerJoin(
      webhookSubscriptions,
      eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId),
    )
    .where(
      and(
        eq(webhookDeliveries.status, 'pending'),
        lt(webhookDeliveries.createdAt, options.cutoff),
        isNull(webhookSubscriptions.deletedAt),
        eq(webhookSubscriptions.enabled, true),
        isNull(webhookSubscriptions.disabledAt),
      ),
    )

  const pendingSkipped = pending?.count ?? 0
  if (pendingSkipped > 0) {
    webhookLogger.warn(
      { pendingSkipped },
      'Webhook deliveries are still pending from before the retention cutoff — ' +
        'is the delivery pump running?',
    )
  }

  return { deleted, batches, hasMore, expired, pendingSkipped }
}
