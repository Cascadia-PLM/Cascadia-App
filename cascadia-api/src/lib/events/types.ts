// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { z } from 'zod'
import type { TransactionClient } from '@/lib/db'

/**
 * A committed business fact, as consumers see it.
 *
 * `seq` is the consumption cursor: for any two committed events, `seq`
 * order equals commit order (see `sequencing.ts`), so a scan past a cursor
 * never skips an event that becomes visible later. `payload` was validated
 * against the emitting definition's schema at publish time.
 */
export interface DomainEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string
  seq: number
  type: string
  schemaVersion: number
  occurredAt: Date
  /** User who caused the event; null means the system itself. */
  actorId: string | null
  subject: {
    type: string | null
    id: string | null
    /** Stable identity for versioned subjects (items), across revisions. */
    masterId: string | null
  }
  context: {
    programId: string | null
    designId: string | null
    branchId: string | null
  }
  payload: TPayload
  correlationId: string | null
  causationId: string | null
}

/**
 * A declared event type: its wire name, payload contract, and doc string.
 * Create with `defineDomainEvent()` so the catalog registers itself.
 */
export interface DomainEventDefinition<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Wire name, `<entity>.<past_tense_fact>` — e.g. `change_order.released`. */
  type: string
  /** Bump when the payload shape changes incompatibly. */
  schemaVersion: number
  description: string
  payloadSchema: z.ZodType<TPayload>
  /** Default `subject.type` for events of this definition. */
  subjectType?: string
}

/**
 * What `publishDomainEvent` hands back: the envelope minus `seq`, which is
 * assigned only when the emitting transaction commits.
 */
export type PendingDomainEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Omit<DomainEvent<TPayload>, 'seq'>

export interface PublishDomainEventInput<
  TPayload extends Record<string, unknown>,
> {
  payload: TPayload
  /** Omit or pass null for system-caused events. */
  actorId?: string | null
  subject?: { type?: string; id?: string; masterId?: string }
  context?: { programId?: string; designId?: string; branchId?: string }
  correlationId?: string
  causationId?: string
}

export interface EventConsumerContext {
  /**
   * The consumer run's transaction. DB writes made through it are wrapped in
   * a per-event savepoint: if the handler throws, its writes roll back while
   * the cursor still advances past the events that succeeded before it.
   * Handlers must be idempotent — delivery is at-least-once.
   */
  tx: TransactionClient
  /**
   * Aborted when the handler exceeds its timeout. Anything that waits on the
   * outside world — an HTTP delivery, a broker publish — should honour it;
   * database work on `tx` is serialised behind the abort regardless.
   */
  signal: AbortSignal
}

/**
 * A named, durable subscriber to the event log. Each consumer owns a cursor
 * row in `event_consumers` and receives matching events in seq order.
 */
export interface DomainEventConsumer {
  /** Stable identity, `<area>.<purpose>` — e.g. `relay.rabbitmq`. Renaming it means starting over from seq 0. */
  id: string
  description?: string
  /** Event type names to handle, or '*' for everything. Non-matching events are skipped but still advance the cursor. */
  eventTypes: ReadonlyArray<string> | '*'
  /**
   * Where the cursor starts **the first time this consumer's row is created**,
   * and never consulted again.
   *
   * `'origin'` (the default, so this field is purely additive) means the oldest
   * event *still retained* — not the beginning of time, because retention
   * prunes. `'head'` means everything that already happened is considered
   * delivered.
   *
   * Declare `'head'` for anything registered after the log shipped. Without it
   * a newly registered consumer replays the entire retained log on its first
   * run: invisible on a fresh install where the log is empty, and a flood on
   * any database that has been logging for a while.
   *
   * `'head'` is safe rather than merely convenient. The sequencing trigger
   * holds the commit-tail advisory lock through COMMIT, so every seq at or
   * below an observed maximum belongs to a transaction that has fully
   * committed and is visible, and no in-flight publisher can later land at or
   * below it.
   */
  startAt?: 'origin' | 'head'
  /**
   * Whether this consumer should run at all — licence, or configuration it
   * cannot work without. Read on **every** run, never captured, so it reflects
   * the environment the process is actually running with.
   *
   * Gating here rather than inside the handler, and the difference is not
   * stylistic. A hook's early return costs nothing; a consumer's early return
   * *consumes* the event and advances the cursor, so an unconfigured instance
   * would silently eat its whole backlog and the day the credential arrives
   * there would be nothing left to sync.
   *
   * Checked before the transaction opens (so a disabled consumer costs no
   * transaction per tick) and before the cursor row is created (so a
   * never-enabled consumer leaves no cursor, and its first enable starts
   * wherever `startAt` says).
   *
   * One asymmetry worth knowing: `PackageRegistry` caches its parse of
   * `CASCADIA_PACKAGES` in a static field, so a predicate built on
   * `isEnabled` reflects boot-time licensing, while one reading `process.env`
   * directly does re-read.
   *
   * Async is permitted, and deliberately so: the plan's signature is sync, but
   * the one enablement source this codebase actually has is a settings row, and
   * a sync-only predicate would force that lookup back inside the handler —
   * which is the precise failure this field exists to prevent. It is awaited
   * before the transaction opens, so the cost is one read per tick per
   * consumer, cached.
   */
  enabled?: () => boolean | Promise<boolean>
  /** Events fetched per run; a full batch signals `hasMore`. Default 100. */
  batchSize?: number
  /**
   * How long one handler invocation may run before it is aborted and counted
   * as a failure. Default 30 s. A handler that hangs would otherwise hold the
   * consumer's cursor row, and with it every later event, forever.
   */
  handlerTimeoutMs?: number
  handler: (event: DomainEvent, ctx: EventConsumerContext) => Promise<void>
}

export interface ConsumerRunResult {
  /**
   * `processed`: the cursor moved — past events handled, or past events of
   * types this consumer does not want, when `processed` is 0.
   * `idle`: nothing new. `locked`: another process holds this consumer.
   * `waiting`: a recent failure's backoff has not elapsed. `parked`: the
   * consumer reached its failure threshold and needs an admin resume — or
   * retention abandoned it, and only forgetting its cursor brings it back.
   * `failed`: a handler threw or timed out; the cursor stopped just before
   * `failedSeq` (after a timeout, the whole batch rolled back).
   * `disabled`: its `enabled()` predicate said no — no transaction was opened
   * and no cursor row was created.
   */
  status:
    | 'processed'
    | 'idle'
    | 'locked'
    | 'waiting'
    | 'parked'
    | 'failed'
    | 'disabled'
  /** Events whose handler ran successfully this round (matching types only). */
  processed: number
  /** Cursor position after this run, when it moved. */
  advancedTo: number | null
  /** A full batch was consumed — run again to keep draining. */
  hasMore: boolean
  failedSeq?: number
  error?: unknown
  /** On `failed`: this failure crossed the threshold and parked the consumer. */
  parked?: boolean
}
