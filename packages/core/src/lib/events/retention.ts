// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, asc, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { DbInstance, TransactionClient } from '@/lib/db'
import { domainEvents, eventConsumers } from '@/lib/db/schema'
import { eventLogger } from '@/lib/logging/logger'

/**
 * How long a consumer may stay parked before retention gives up on it, when a
 * caller does not say: the retention window's own default.
 *
 * The prune job passes its configured window instead, so a consumer is
 * abandoned exactly when the events from the moment it parked start becoming
 * old enough to prune — not at a fixed month into a window that keeps events
 * for three, forfeiting a backlog retention would still have held for two more.
 */
export const DEFAULT_ABANDON_AFTER_DAYS = 90

export interface RetentionHorizon {
  /**
   * The highest seq it is safe to delete at or below, or null for unbounded.
   *
   * Null means no cursor row constrains the prune, so the age cutoff alone
   * decides: with no cursors, nobody is owed anything.
   */
  horizonSeq: number | null
  /**
   * The cursors sitting exactly at the floor — the consumers retention is
   * waiting on, which is what an operator needs when the log keeps growing.
   */
  pinnedBy: Array<string>
  /** Cursors excluded from the floor because retention gave up on them. */
  abandoned: Array<string>
  /**
   * Committed rows with a null seq. Real, undelivered, and invisible to every
   * consumer's scan — see `pruneDomainEvents`.
   */
  unsequenced: number
}

function abandonCutoff(abandonAfterDays: number): Date {
  return new Date(Date.now() - abandonAfterDays * 24 * 60 * 60 * 1000)
}

/**
 * Stamp `abandoned_at` on every consumer parked past the give-up horizon, and
 * return their ids.
 *
 * The one write retention makes to `event_consumers`, and a separate step from
 * computing the floor so that computing it stays a read — the prune reads the
 * floor again inside every batch. A non-positive horizon abandons nothing,
 * which is what "retain forever" passes.
 */
export async function abandonLongParkedConsumers(
  db: DbInstance | TransactionClient,
  options: { abandonAfterDays?: number } = {},
): Promise<Array<string>> {
  const abandonAfterDays =
    options.abandonAfterDays ?? DEFAULT_ABANDON_AFTER_DAYS
  if (abandonAfterDays <= 0) return []

  const now = new Date()
  const rows = await db
    .update(eventConsumers)
    .set({ abandonedAt: now, updatedAt: now })
    .where(
      and(
        isNull(eventConsumers.abandonedAt),
        isNotNull(eventConsumers.parkedAt),
        lt(eventConsumers.parkedAt, abandonCutoff(abandonAfterDays)),
      ),
    )
    .returning({ id: eventConsumers.id })
  const ids = rows.map((row) => row.id)
  if (ids.length > 0) {
    eventLogger.warn(
      { consumers: ids, abandonAfterDays },
      'Event consumers abandoned after being parked past the give-up horizon; ' +
        'their backlog is forfeit, and each must be forgotten to re-register',
    )
  }
  return ids
}

/** Committed events with no seq: undelivered, and invisible to every consumer. */
export async function countUnsequencedEvents(
  db: DbInstance | TransactionClient,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(domainEvents)
    .where(isNull(domainEvents.seq))
  return rows.at(0)?.count ?? 0
}

/**
 * How far the prune may go, and what it had to give up on to get there. A
 * read: `abandonLongParkedConsumers` is the step that records abandonment.
 *
 * The floor is the **minimum cursor across every row** in `event_consumers`,
 * and four cases decide that:
 *
 * - **A parked consumer participates exactly like a healthy one.** It is still
 *   owed its backlog; parking is a pause, not a forfeit.
 * - **An orphan cursor for a consumer no process registers participates too.**
 *   A pruning process can only see its own in-memory registry, and another
 *   process in a fleet may still hold that consumer — so a local registry must
 *   never decide what is deletable.
 * - **Zero cursor rows means null, which means unbounded.**
 * - **A null-seq row is never deleted, whatever its age.** Under read committed
 *   a session cannot see another transaction's uncommitted row, so any null-seq
 *   row a prune can see is a *committed* row on a database whose sequencing
 *   trigger was missing when it was written. It is real, undelivered, and
 *   invisible to every consumer's `seq > cursor` scan. Counted and reported
 *   rather than swept; boot sequences it.
 *
 * A **registered consumer with no cursor row does not participate**: the floor
 * is made of rows. A consumer declaring `startAt: 'origin'` means "the oldest
 * event still retained", so one that is registered but has never run — its
 * worker was down, or its `enabled` predicate said no until now — starts from
 * whatever retention has left by its first run.
 *
 * The consequence of the first two cases is that a parked or orphaned cursor
 * pins the horizon, which one extension that parks and is never fixed turns
 * into a log growing without bound while the prune reports success. So a
 * consumer parked past the give-up horizon is **excluded from the floor** —
 * catch-up becomes impossible and it must be forgotten to re-register — and the
 * exclusion is announced in the result and on the admin panel rather than
 * happening silently.
 */
export async function computeRetentionHorizon(
  db: DbInstance | TransactionClient,
  options: { abandonAfterDays?: number; countUnsequenced?: boolean } = {},
): Promise<RetentionHorizon> {
  const abandonAfterDays =
    options.abandonAfterDays ?? DEFAULT_ABANDON_AFTER_DAYS
  const cutoff = abandonAfterDays > 0 ? abandonCutoff(abandonAfterDays) : null

  const cursors = await db
    .select({
      id: eventConsumers.id,
      lastSeq: eventConsumers.lastSeq,
      parkedAt: eventConsumers.parkedAt,
      abandonedAt: eventConsumers.abandonedAt,
    })
    .from(eventConsumers)

  const abandoned: Array<string> = []
  const counted: Array<{ id: string; lastSeq: number }> = []
  for (const cursor of cursors) {
    const givenUp =
      cursor.abandonedAt !== null ||
      (cutoff !== null && cursor.parkedAt !== null && cursor.parkedAt < cutoff)
    if (givenUp) {
      abandoned.push(cursor.id)
      continue
    }
    counted.push({ id: cursor.id, lastSeq: cursor.lastSeq })
  }

  const horizonSeq =
    counted.length === 0 ? null : Math.min(...counted.map((c) => c.lastSeq))
  const pinnedBy =
    horizonSeq === null
      ? []
      : counted.filter((c) => c.lastSeq === horizonSeq).map((c) => c.id)

  const unsequenced =
    options.countUnsequenced === false ? 0 : await countUnsequencedEvents(db)
  if (unsequenced > 0) {
    eventLogger.warn(
      { unsequenced },
      'Domain events with no seq: committed, undelivered, and invisible to ' +
        'every consumer. They were written while the sequencing trigger was ' +
        'missing; the next app or worker boot sequences them. They are never pruned.',
    )
  }

  return { horizonSeq, pinnedBy, abandoned, unsequenced }
}

export interface PruneResult {
  deleted: number
  batches: number
  /** A full final batch — there is more to delete than `maxBatches` allowed. */
  hasMore: boolean
  unsequenced: number
}

/**
 * Delete events older than the cutoff that every consumer has passed.
 *
 * The horizon is a **parameter**, not something this computes, for two reasons:
 * it mirrors how the cache-cleanup handler delegates to its service, and it is
 * the only decomposition that makes the prune deterministically testable — an
 * unbounded prune against the shared test log would delete other suites'
 * committed rows.
 *
 * Batched, because Postgres has no `DELETE ... LIMIT`: each batch, in a
 * transaction of its own, selects ids ordered by seq and then deletes by id.
 * Three reasons it has to be:
 *
 * - The first run on an instance that has been logging for months can be a very
 *   large delete, holding a row lock and writing a WAL record per row.
 * - `JobTypeConfig.timeout` doubles as the stale-running lease, so a delete that
 *   outruns it is reaped and retried while still executing.
 * - The abort signal and the progress callback only have meaning between
 *   batches.
 */
export async function pruneDomainEvents(
  db: DbInstance,
  options: {
    cutoff: Date
    /**
     * The floor, or how to read it. A function is read again inside every
     * batch's own transaction, and is what the prune job passes: a prune can
     * run for minutes, and a cursor created meanwhile — a consumer's first run,
     * starting at the origin — must hold the floor for every batch after it
     * commits. A number is a fixed floor, which only a test wants.
     */
    horizonSeq:
      number | null | ((tx: TransactionClient) => Promise<number | null>)
    batchSize?: number
    maxBatches?: number
    signal?: AbortSignal
    onBatch?: (batches: number, deleted: number) => Promise<void> | void
  },
): Promise<PruneResult> {
  const { cutoff, horizonSeq, signal, onBatch } = options
  const batchSize = options.batchSize ?? 1000
  const maxBatches = options.maxBatches ?? 50

  let deleted = 0
  let batches = 0
  let hasMore = false

  while (batches < maxBatches) {
    if (signal?.aborted) break

    const removed = await db.transaction(async (tx) => {
      const floor =
        typeof horizonSeq === 'function' ? await horizonSeq(tx) : horizonSeq

      const conditions = [
        // Never a null seq, whatever its age.
        isNotNull(domainEvents.seq),
        lt(domainEvents.occurredAt, cutoff),
      ]
      if (floor !== null) {
        conditions.push(sql`${domainEvents.seq} <= ${floor}`)
      }

      const doomed = await tx
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(and(...conditions))
        .orderBy(asc(domainEvents.seq))
        .limit(batchSize)

      if (doomed.length > 0) {
        await tx.delete(domainEvents).where(
          inArray(
            domainEvents.id,
            doomed.map((row) => row.id),
          ),
        )
      }
      return doomed.length
    })

    if (removed === 0) break
    deleted += removed
    batches += 1
    hasMore = removed === batchSize
    await onBatch?.(batches, deleted)
    if (!hasMore) break
  }

  return {
    deleted,
    batches,
    hasMore,
    unsequenced: await countUnsequencedEvents(db),
  }
}

/**
 * Forget a consumer's cursor entirely.
 *
 * **This abandons that consumer's backlog permanently** — exactly as a skip
 * does, but for all of it. A consumer re-registered afterwards restarts at
 * whatever its `startAt` says, which for anything declaring `'head'` means
 * everything currently in the log is treated as delivered.
 *
 * It exists because neither resume nor skip removes a cursor, and without it the
 * only fix for an ERP consumer on an instance that later drops the package, or a
 * webhook dispatcher on an instance that abandons webhooks, is manual SQL — while
 * that cursor pins the retention horizon forever.
 */
export async function forgetEventConsumer(
  db: DbInstance | TransactionClient,
  id: string,
): Promise<boolean> {
  const removed = await db
    .delete(eventConsumers)
    .where(inArray(eventConsumers.id, [id]))
    .returning({ id: eventConsumers.id })
  if (removed.length > 0) {
    eventLogger.warn(
      { consumer: id },
      'Event consumer cursor forgotten by admin action; its backlog is ' +
        'permanently abandoned',
    )
  }
  return removed.length > 0
}
