// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, asc, eq, gt, inArray, lte, max, sql } from 'drizzle-orm'
import { rowToDomainEvent } from './publish'
import type { ConsumerRunResult, DomainEventConsumer } from './types'
import type { TransactionClient } from '@/lib/db'
import type { EventConsumerRow } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { domainEvents, eventConsumers } from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { describeError } from '@/lib/errors/describe'
import { eventLogger } from '@/lib/logging/logger'

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000
const BACKOFF_BASE_MS = 2_000
const BACKOFF_CAP_MS = 5 * 60_000

/**
 * How long a handler that overran its deadline is given to actually stop
 * before its run is rolled back regardless. See `runEventConsumerOnce`.
 */
const HANDLER_SETTLE_GRACE_MS = 5_000

/**
 * Namespace key ('EVNC') for the advisory lock that serialises creating a
 * consumer's cursor row. Taken in the two-key form, whose lock space is
 * separate from the single-key sequencing lock.
 */
const CURSOR_CREATE_LOCK_NAMESPACE = 0x45564e43

/**
 * Consecutive failures after which a consumer is parked (env
 * `EVENT_CONSUMER_PARK_AFTER`, default 10). Parking is the deliberate end of
 * retrying: the consumer stops, the row says why, and an admin decides —
 * resume once the cause is fixed, or skip the poison event. Never automatic
 * skipping: silently losing one event is the failure this whole log exists
 * to prevent.
 */
function parkAfter(): number {
  const raw = process.env.EVENT_CONSUMER_PARK_AFTER
  if (!raw) return 10
  const configured = Number(raw)
  return Number.isFinite(configured) && configured > 0 ? configured : 10
}

/** Exponential backoff between retries: 2 s, 4 s, 8 s … capped at 5 min. */
function backoffMs(failureCount: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failureCount - 1), BACKOFF_CAP_MS)
}

export class EventHandlerTimeoutError extends Error {
  /**
   * Settles once the timed-out handler has actually stopped, however it
   * stopped. Non-enumerable: a promise has no business in a log line, and the
   * logger copies enumerable properties.
   */
  declare readonly settled: Promise<void>

  constructor(
    consumerId: string,
    seq: number,
    timeoutMs: number,
    settled: Promise<void> = Promise.resolve(),
  ) {
    super(
      `Event consumer "${consumerId}" exceeded ${timeoutMs} ms on seq ${seq}`,
    )
    this.name = 'EventHandlerTimeoutError'
    Object.defineProperty(this, 'settled', {
      value: settled,
      enumerable: false,
    })
  }
}

/**
 * A failure the consumer cannot fix and that clears by itself — a broker that
 * is down, a network that dropped. Throw it, or let one of the recognised
 * connection errors escape, and the runtime keeps retrying with capped backoff
 * but **never parks** for it.
 *
 * Parking exists for poison: an event this consumer will fail on forever, which
 * an operator has to look at. An outage is not that. Ten failures along the
 * backoff ladder is about eighteen minutes, so before this distinction a broker
 * outage longer than that parked the RabbitMQ relay, and "a broker outage costs
 * latency, never events" became an administrator's ticket.
 */
export class TransientConsumerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TransientConsumerError'
  }
}

/** Node's network errnos: the outside world, not this event, is the problem. */
const TRANSIENT_ERRNOS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
])

/** A server shutting down or refusing connections while it restarts. */
const TRANSIENT_SQLSTATES = new Set(['57P01', '57P02', '57P03'])

/**
 * Whether a handler failure is transient: a `TransientConsumerError`, a network
 * errno, or a Postgres connection exception (class 08) or shutdown.
 *
 * Walks the chain a failure arrives through — the extension wrapper's
 * `extensionError`, then `cause` — because the dispatcher deliberately wraps
 * whatever a handler threw.
 */
export function isTransientConsumerFailure(error: unknown): boolean {
  let current: unknown = error
  for (
    let depth = 0;
    depth < 6 && typeof current === 'object' && current !== null;
    depth++
  ) {
    if (current instanceof TransientConsumerError) return true
    const code = (current as { code?: unknown }).code
    if (
      typeof code === 'string' &&
      (TRANSIENT_ERRNOS.has(code) ||
        TRANSIENT_SQLSTATES.has(code) ||
        (code.length === 5 && code.startsWith('08')))
    ) {
      return true
    }
    const next = current as { extensionError?: unknown; cause?: unknown }
    current = next.extensionError ?? next.cause
  }
  return false
}

/** Thrown out of a run's transaction to roll the whole run back after a timeout. */
class TimedOutRun extends Error {
  readonly failedSeq: number
  readonly failure: EventHandlerTimeoutError

  constructor(failedSeq: number, failure: EventHandlerTimeoutError) {
    super(failure.message)
    this.name = 'TimedOutRun'
    this.failedSeq = failedSeq
    this.failure = failure
  }
}

/**
 * Which consumers exist is not this file's question.
 *
 * There was an `EventConsumerRegistry` here. It is gone: `defineExtension`
 * with `phase: 'consumed'` is the only way to register a consumer now, the
 * extension registry holds them, and `lib/extensions/consumers.ts` projects
 * them into the shape below and drives the polling. Two registries would have
 * meant two duplicate policies, two cursor-creation paths, and an
 * introspection endpoint able to answer for only one of them.
 *
 * What stays here is the mechanics of running *one* consumer, which the layer
 * above has no opinion about: the cursor claim, the savepoint per event, the
 * deadline, the backoff and the parking.
 */
function consumerMatches(consumer: DomainEventConsumer, type: string): boolean {
  return consumer.eventTypes === '*' || consumer.eventTypes.includes(type)
}

/** The drizzle transaction methods that start a statement. */
const STATEMENT_METHODS = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'transaction',
  'with',
  '$with',
  '$count',
  'query',
  'refreshMaterializedView',
])

/**
 * The handler's view of its savepoint, which refuses to start statements once
 * the handler's deadline has passed.
 *
 * postgres.js runs a query issued through a transaction's handle on the
 * connection that transaction held, whether or not the transaction is still
 * open. A handler that ignores its abort signal and writes after its deadline
 * could therefore land a write in this run's outer transaction — to be
 * committed with the failure record — or, once that has ended, on whatever work
 * the connection moved on to. This closes the ordinary shape, `await fetch(…);
 * await tx.insert(…)`, where the statement is started after the deadline: the
 * attempt throws. A query built before the deadline and awaited after it is not
 * caught here, which is what the grace wait and the rollback in
 * `runEventConsumerOnce` are for.
 */
function fenceAfterAbort(
  tx: TransactionClient,
  signal: AbortSignal,
): TransactionClient {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (
        signal.aborted &&
        typeof property === 'string' &&
        STATEMENT_METHODS.has(property)
      ) {
        throw new Error(
          `The event handler's deadline passed; its transaction no longer starts statements (attempted ${property})`,
        )
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })
}

/** Wait for `settled`, but no longer than `ms`. */
async function settleWithin(settled: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
}

/**
 * Run one handler invocation under a deadline. The handler receives the
 * signal and is expected to honour it for anything that waits on the outside
 * world; database work on the savepoint is serialised behind the abort by
 * the connection itself, so the rollback that follows waits for it.
 */
async function runWithTimeout(
  run: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
  onTimeout: (settled: Promise<void>) => Error,
): Promise<void> {
  const controller = new AbortController()
  const running = run(controller.signal)
  const settled = running.then(
    () => undefined,
    () => undefined,
  )
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting: a handler that rejects on abort would
      // otherwise settle the race first and hide the timeout that caused it.
      reject(onTimeout(settled))
      controller.abort()
    }, timeoutMs)
  })
  try {
    await Promise.race([running, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** The highest committed seq; nothing that will ever commit lands at or below it. */
async function readHead(tx: TransactionClient): Promise<number> {
  const [row] = await tx
    .select({ head: max(domainEvents.seq) })
    .from(domainEvents)
  return row?.head ?? 0
}

/**
 * Claim this consumer's cursor row for the run, creating it on first use.
 *
 * The common case is one statement: the row exists, and `FOR UPDATE SKIP
 * LOCKED` either takes it or reports that another runner has it.
 *
 * The first run is where waiting used to hide. The row was created by an
 * `INSERT … ON CONFLICT DO NOTHING` ahead of the lock, and a conflicting insert
 * that has not committed makes the second insert wait — so a second process's
 * first tick blocked for the whole of the first process's first run instead of
 * reporting `locked` and moving on. An absent row is now created under a
 * transaction-scoped advisory **try**-lock on the consumer id: whoever fails to
 * take it is racing a creator, and returns at once.
 *
 * `ON CONFLICT DO NOTHING` stays load-bearing. `DO UPDATE` would re-seed a
 * lagging head-start consumer to the head on every poll and silently drop its
 * backlog, which is the exact failure the log exists to prevent.
 */
async function claimCursor(
  tx: TransactionClient,
  consumer: DomainEventConsumer,
): Promise<EventConsumerRow | null> {
  const lockRow = async (): Promise<EventConsumerRow | null> => {
    const rows = await tx
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, consumer.id))
      .for('update', { skipLocked: true })
    return rows.at(0) ?? null
  }

  const existing = await lockRow()
  if (existing) return existing

  const [lock] = await tx.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(${CURSOR_CREATE_LOCK_NAMESPACE}, hashtext(${consumer.id})) AS acquired`,
  )
  if (!lock?.acquired) return null

  // The cursor's starting position, decided in the one statement that creates
  // it.
  if (consumer.startAt === 'head') {
    await tx.execute(sql`
      INSERT INTO event_consumers (id, last_seq)
      SELECT ${consumer.id}, coalesce(max(seq), 0)
        FROM domain_events
       WHERE seq IS NOT NULL
      ON CONFLICT (id) DO NOTHING
    `)
  } else {
    await tx
      .insert(eventConsumers)
      .values({ id: consumer.id })
      .onConflictDoNothing()
  }
  return lockRow()
}

/** Commit a cursor position and clear any failure state. */
async function markProgress(
  tx: TransactionClient,
  consumerId: string,
  lastSeq: number,
): Promise<void> {
  await tx
    .update(eventConsumers)
    .set({
      lastSeq,
      failureCount: 0,
      lastError: null,
      lastErrorAt: null,
      lastErrorSeq: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(eventConsumers.id, consumerId))
}

/**
 * Record a handler failure on the cursor row: the position just before the
 * failing event, the error, and either a backoff or — past the threshold, and
 * never for a transient failure — the parked state.
 */
async function recordFailure(
  tx: TransactionClient,
  consumerId: string,
  previousFailures: number,
  failure: { seq: number; error: unknown },
  lastSeq: number,
): Promise<{ parked: boolean }> {
  const transient = isTransientConsumerFailure(failure.error)
  const failureCount = previousFailures + 1
  const parked = !transient && failureCount >= parkAfter()
  const now = new Date()
  await tx
    .update(eventConsumers)
    .set({
      lastSeq,
      failureCount,
      lastError: describeError(failure.error).slice(0, 2000),
      lastErrorAt: now,
      lastErrorSeq: failure.seq,
      nextAttemptAt: parked
        ? null
        : new Date(now.getTime() + backoffMs(failureCount)),
      parkedAt: parked ? now : null,
      updatedAt: now,
    })
    .where(eq(eventConsumers.id, consumerId))
  // Under `err`, pino's error key, the logger writes an error's message, stack
  // and inner errors; under any other name it writes only enumerable fields,
  // which for a refused connection was its `code` alone.
  const context = {
    consumer: consumerId,
    seq: failure.seq,
    failureCount,
    err: failure.error,
  }
  if (parked) {
    eventLogger.error(
      context,
      'Event consumer parked after repeated failures; an admin must resume it or skip the event',
    )
  } else if (transient) {
    eventLogger.warn(
      context,
      'Event consumer hit a transient failure; retrying from this event after backoff, and never parking for it',
    )
  } else {
    eventLogger.warn(
      context,
      'Event consumer handler failed; will retry from this event after backoff',
    )
  }
  return { parked }
}

/**
 * Record a timed-out run's failure, after its transaction was rolled back.
 *
 * In a transaction of its own, claimed with `SKIP LOCKED` like any run. If
 * another poller took the cursor in between, it meets the same event and
 * records its own outcome; if the cursor row was created by the run that just
 * rolled back, it no longer exists, and the next run creates it again and meets
 * the event afresh.
 */
async function recordTimedOutRun(
  consumer: DomainEventConsumer,
  timedOut: TimedOutRun,
): Promise<ConsumerRunResult> {
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(eventConsumers)
      .where(eq(eventConsumers.id, consumer.id))
      .for('update', { skipLocked: true })
    const parked = state
      ? (
          await recordFailure(
            tx,
            consumer.id,
            state.failureCount,
            { seq: timedOut.failedSeq, error: timedOut.failure },
            state.lastSeq,
          )
        ).parked
      : false
    return {
      status: 'failed' as const,
      processed: 0,
      advancedTo: null,
      hasMore: false,
      failedSeq: timedOut.failedSeq,
      error: timedOut.failure,
      parked,
    }
  })
}

async function runBatch(
  tx: TransactionClient,
  consumer: DomainEventConsumer,
): Promise<ConsumerRunResult> {
  const nothing = { processed: 0, advancedTo: null, hasMore: false }

  const state = await claimCursor(tx, consumer)
  if (!state) return { status: 'locked' as const, ...nothing }
  // Retention stamps abandonment only on a consumer that was parked, and
  // neither resume nor skip reopens one — but a row edited by hand is still not
  // a reason to run a consumer whose backlog may be gone.
  if (state.parkedAt || state.abandonedAt) {
    return { status: 'parked' as const, ...nothing }
  }
  if (state.nextAttemptAt && state.nextAttemptAt.getTime() > Date.now()) {
    return { status: 'waiting' as const, ...nothing }
  }

  const batchSize = consumer.batchSize ?? DEFAULT_BATCH_SIZE
  // The type filter goes in the SELECT for anything but a wildcard.
  //
  // Filtering in JavaScript afterwards was right for the single core consumer
  // that existed when this was written, and wrong the moment every `consumed`
  // extension owns a cursor: N extensions became N independent walks of the
  // whole log, each advancing its cursor past every event it does not want.
  // The `(type, seq)` index already exists. The wildcard path is unchanged,
  // because a wildcard consumer genuinely does want every row.
  //
  // A filtered scan reads the head of the log **first** and never looks past
  // it, which is what lets a short batch move the cursor to the head instead of
  // leaving it on the last event the consumer wanted. Every seq at or below a
  // head this statement could see belongs to a transaction that had already
  // committed — the sequencing lock is released only once a commit is visible
  // — so no event this consumer wants can later appear at or below it. Reading
  // the head *after* the scan would not be safe; the order is load-bearing.
  const head = consumer.eventTypes === '*' ? null : await readHead(tx)
  const rows = await tx
    .select()
    .from(domainEvents)
    .where(
      consumer.eventTypes === '*'
        ? gt(domainEvents.seq, state.lastSeq)
        : and(
            gt(domainEvents.seq, state.lastSeq),
            lte(domainEvents.seq, head ?? state.lastSeq),
            inArray(domainEvents.type, [...consumer.eventTypes]),
          ),
    )
    .orderBy(asc(domainEvents.seq))
    .limit(batchSize)

  if (rows.length === 0) {
    // Nothing wanted up to the head is still progress: every event there is
    // one this consumer does not want.
    if (head !== null && head > state.lastSeq) {
      await markProgress(tx, consumer.id, head)
      return {
        status: 'processed' as const,
        processed: 0,
        advancedTo: head,
        hasMore: false,
      }
    }
    return { status: 'idle' as const, ...nothing }
  }

  const timeoutMs = consumer.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS
  let lastSeq = state.lastSeq
  let processed = 0
  let failure: { seq: number; error: unknown } | null = null

  for (const row of rows) {
    const event = rowToDomainEvent(row)
    if (consumerMatches(consumer, event.type)) {
      try {
        // Savepoint per event: a throwing handler rolls back only its own
        // writes, not the batch's cursor progress.
        await tx.transaction(async (handlerTx) => {
          await runWithTimeout(
            (signal) =>
              consumer.handler(event, {
                tx: fenceAfterAbort(handlerTx, signal),
                signal,
              }),
            timeoutMs,
            (settled) =>
              new EventHandlerTimeoutError(
                consumer.id,
                event.seq,
                timeoutMs,
                settled,
              ),
          )
        })
        processed++
      } catch (error) {
        if (error instanceof EventHandlerTimeoutError) {
          // Give the handler a moment to actually stop, then roll the whole run
          // back — see the timeout note on `runEventConsumerOnce`.
          await settleWithin(error.settled, HANDLER_SETTLE_GRACE_MS)
          throw new TimedOutRun(event.seq, error)
        }
        failure = { seq: event.seq, error }
        break
      }
    }
    lastSeq = event.seq
  }

  if (failure) {
    const { parked } = await recordFailure(
      tx,
      consumer.id,
      state.failureCount,
      failure,
      lastSeq,
    )
    return {
      status: 'failed' as const,
      processed,
      advancedTo: lastSeq > state.lastSeq ? lastSeq : null,
      hasMore: false,
      failedSeq: failure.seq,
      error: failure.error,
      parked,
    }
  }

  // A short batch has seen every wanted event up to the head, so the cursor can
  // move to the head rather than stop on the last event it handled.
  const advancedTo =
    head !== null && rows.length < batchSize ? Math.max(lastSeq, head) : lastSeq
  await markProgress(tx, consumer.id, advancedTo)

  return {
    status: 'processed' as const,
    processed,
    advancedTo,
    hasMore: rows.length === batchSize,
  }
}

/**
 * Run one batch for one consumer: claim its cursor row, process events past
 * the cursor in seq order, advance the cursor, commit.
 *
 * The scan is a plain `seq > cursor`, and that is safe because seq is
 * assigned at commit (see `sequencing.ts`): every committed event with a
 * lower seq is already visible, so nothing can appear behind the cursor
 * later. No fence, and no waiting on in-flight publishers.
 *
 * Delivery contract:
 * - **At-least-once, in order.** The cursor advances in the same transaction
 *   the handlers ran in; a crash before commit redelivers the whole batch, so
 *   handlers must be idempotent.
 * - **Partial progress on failure.** Each handler runs in a savepoint under a
 *   deadline. When one throws, its own writes roll back, the cursor commits
 *   just *before* the failing event, and the error lands on the consumer row
 *   with a backoff. The next eligible run retries the failed event first — a
 *   poison event stalls only its consumer, visibly.
 * - **A timeout rolls the whole run back.** A handler that overran its
 *   deadline may still be running, and a statement it issues late would land
 *   in this run's transaction — committed with the failure record — or, once
 *   that transaction has ended, on whatever its connection went on to serve.
 *   So its handle refuses new statements after the deadline, it is given a
 *   short grace to stop, and then the run rolls back entirely and the failure
 *   is recorded in a transaction of its own. The batch's earlier events are
 *   redelivered, which at-least-once already allows.
 * - **Parking, never skipping.** After `EVENT_CONSUMER_PARK_AFTER`
 *   consecutive failures the consumer is parked: every poller skips it until
 *   an admin resumes it or skips the event (`resumeEventConsumer`,
 *   `skipPoisonEvent`). A **transient** failure — a broker or network that is
 *   down — retries with capped backoff and never parks: parking is for poison,
 *   and an outage is not.
 * - **Single active runner per consumer.** The cursor row is claimed with
 *   `FOR UPDATE SKIP LOCKED`; a second process polling the same consumer gets
 *   `locked` and moves on — on its first tick as on every other.
 *
 * A filtered consumer is never shown events of types it does not want, and its
 * cursor still moves past them: to the head of the log whenever a batch comes
 * back short. A cursor that stopped on the last event it wanted would pin the
 * retention horizon there and read as lag forever.
 */
export async function runEventConsumerOnce(
  consumer: DomainEventConsumer,
): Promise<ConsumerRunResult> {
  // Before the transaction, deliberately: a disabled consumer should not cost
  // one on every tick. And before the cursor row is created, which is what
  // gives the two behaviours that matter — a never-enabled consumer leaves no
  // cursor, so its first enable starts wherever `startAt` says, while an
  // enabled-then-unconfigured one keeps its cursor and lags visibly.
  if (consumer.enabled && !(await consumer.enabled())) {
    return {
      status: 'disabled' as const,
      processed: 0,
      advancedTo: null,
      hasMore: false,
    }
  }

  try {
    return await db.transaction((tx) => runBatch(tx, consumer))
  } catch (error) {
    if (error instanceof TimedOutRun) return recordTimedOutRun(consumer, error)
    throw error
  }
}

/**
 * An abandoned consumer cannot be resumed or skipped — only forgotten.
 *
 * Retention stopped counting its cursor when it abandoned it, so the events
 * behind that cursor may already be gone. Resuming would run it from a position
 * whose backlog has holes nobody can see: its `seq > cursor` scan simply never
 * meets the pruned rows. That is silent loss by way of the action the operator
 * page calls safe. Forgetting the cursor and letting the consumer re-register
 * at its declared start is the honest recovery, and the only one offered.
 */
function refuseIfAbandoned(row: EventConsumerRow, operation: string): void {
  if (!row.abandonedAt) return
  throw new ConflictError(
    `Event consumer "${row.id}" was abandoned by retention on ${row.abandonedAt.toISOString()}, and its backlog may already be pruned. Forget its cursor so it re-registers, rather than reopening it.`,
    { operation, consumerId: row.id },
  )
}

/**
 * Clear a consumer's failure state so the next poll runs it again. The
 * admin's answer to "the cause is fixed, try again".
 */
export async function resumeEventConsumer(
  id: string,
): Promise<EventConsumerRow> {
  return db.transaction(async (tx) => {
    const current = (
      await tx
        .select()
        .from(eventConsumers)
        .where(eq(eventConsumers.id, id))
        .for('update')
    ).at(0)
    if (!current) throw new NotFoundError('Event consumer', id)
    refuseIfAbandoned(current, 'resume')
    const rows = await tx
      .update(eventConsumers)
      .set({
        failureCount: 0,
        nextAttemptAt: null,
        parkedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(eventConsumers.id, id))
      .returning()
    const row = rows.at(0)
    if (!row) throw new NotFoundError('Event consumer', id)
    eventLogger.info({ consumer: id }, 'Event consumer resumed')
    return row
  })
}

/**
 * Move a consumer's cursor past the event whose handler keeps failing, and
 * clear its failure state. The admin's answer to "this event will never
 * succeed and the rest must flow" — deliberate, logged, and impossible to do
 * by accident: it refuses unless a failure is on record.
 */
export async function skipPoisonEvent(id: string): Promise<EventConsumerRow> {
  return db.transaction(async (tx) => {
    const current = (
      await tx
        .select()
        .from(eventConsumers)
        .where(eq(eventConsumers.id, id))
        .for('update')
    ).at(0)
    if (!current) throw new NotFoundError('Event consumer', id)
    refuseIfAbandoned(current, 'skip')
    if (current.lastErrorSeq === null) {
      throw new ValidationError(
        `Event consumer "${id}" has no failed event to skip`,
      )
    }
    const rows = await tx
      .update(eventConsumers)
      .set({
        lastSeq: Math.max(current.lastSeq, current.lastErrorSeq),
        failureCount: 0,
        lastError: null,
        lastErrorAt: null,
        lastErrorSeq: null,
        nextAttemptAt: null,
        parkedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(eventConsumers.id, id))
      .returning()
    const row = rows.at(0)
    if (!row) throw new NotFoundError('Event consumer', id)
    eventLogger.warn(
      { consumer: id, skippedSeq: current.lastErrorSeq },
      'Event consumer skipped a poison event by admin action',
    )
    return row
  })
}

/**
 * Drain one consumer: run batches until it reports no more full batches.
 * `maxBatches` bounds a single drain so one busy consumer cannot starve the
 * others in a polling round.
 */
export async function drainEventConsumer(
  consumer: DomainEventConsumer,
  maxBatches = 10,
): Promise<ConsumerRunResult> {
  let result = await runEventConsumerOnce(consumer)
  let batches = 1
  while (result.hasMore && batches < maxBatches) {
    result = await runEventConsumerOnce(consumer)
    batches++
  }
  return result
}
