// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  bigint,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * The sequence behind `domain_events.seq`.
 *
 * Declared here so drizzle-kit owns it, but it is deliberately *not* the
 * column's default. `seq` is assigned when the inserting transaction commits,
 * by the `domain_events_assign_seq` constraint trigger
 * (`lib/events/sequencing.ts`), which is what makes seq order equal commit
 * order.
 */
export const domainEventsSequence = pgSequence('domain_events_sequence')

/**
 * The domain event log — the durable record of business facts.
 *
 * Rows are written by `publishDomainEvent()` inside the same transaction as
 * the domain mutation they describe (transactional outbox), so an event
 * exists if and only if the change it records committed. The table is
 * append-only: rows are never updated after commit, and are deleted only by
 * a retention sweep.
 *
 * Deliberately no foreign keys. A fact log must outlive its subjects — an
 * event about an item stays true after the item is hard-deleted, and a
 * cascade or restrict from a referent would either destroy history or block
 * legitimate deletes. Referential integrity at write time is already
 * guaranteed by the emitting transaction.
 *
 * `seq` is the consumption cursor, and it is null until the row's
 * transaction commits. A sequence default would assign it at insert time,
 * but transactions commit in any order — a transaction holding seq 5 can
 * commit after one holding seq 6, and a reader past 6 would lose 5 forever.
 * A deferred constraint trigger assigns it inside COMMIT instead, under an
 * exclusive advisory lock held only for that commit tail, so for any two
 * committed events seq order is commit order and a cursor can never skip an
 * event that becomes visible later. Only the emitting transaction itself
 * ever sees a row with a null seq. `occurredAt` is `now()`, i.e. the
 * emitting transaction's start time — every event of one transaction
 * carries the same timestamp, which is correct for an atomic fact.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Commit-order position; null until the emitting transaction commits. */
    seq: bigint('seq', { mode: 'number' }),
    type: varchar('type', { length: 100 }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** User who caused the event; null means the system itself. */
    actorId: uuid('actor_id'),
    subjectType: varchar('subject_type', { length: 50 }),
    subjectId: uuid('subject_id'),
    /** Stable identity for versioned subjects (items), across revisions. */
    subjectMasterId: uuid('subject_master_id'),
    programId: uuid('program_id'),
    designId: uuid('design_id'),
    branchId: uuid('branch_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Groups events of one logical operation across services. */
    correlationId: uuid('correlation_id'),
    /** The event id that directly caused this one, if any. */
    causationId: uuid('causation_id'),
  },
  (table) => [
    unique('domain_events_seq_unique').on(table.seq),
    index('idx_domain_events_type_seq').on(table.type, table.seq),
    index('idx_domain_events_subject_master').on(table.subjectMasterId),
    index('idx_domain_events_design').on(table.designId),
  ],
)

/**
 * One row per event consumer, holding its cursor into `domain_events`.
 *
 * A consumer processes events with `seq > lastSeq` in seq order and advances
 * the cursor in the same transaction — at-least-once delivery with ordering,
 * on Postgres alone. The row is claimed with `FOR UPDATE SKIP LOCKED`, so any
 * number of processes can poll the same consumer safely; exactly one wins
 * each round.
 */
export const eventConsumers = pgTable('event_consumers', {
  id: varchar('id', { length: 100 }).primaryKey(),
  /** Highest domain_events.seq this consumer has fully processed. */
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
  /** Consecutive failed runs; reset to 0 on the next successful run. */
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  /** The seq of the event whose handler last failed — what an admin skip moves past. */
  lastErrorSeq: bigint('last_error_seq', { mode: 'number' }),
  /** Earliest time the next run may retry after a failure (exponential backoff). */
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  /**
   * Set when consecutive failures reached the park threshold. A parked
   * consumer is skipped by every poller until an admin resumes it — the
   * visible, deliberate alternative to retrying a poison event forever.
   */
  parkedAt: timestamp('parked_at', { withTimezone: true }),
  /**
   * Set when a parked consumer has been parked long enough that retention gave
   * up waiting for it.
   *
   * A parked cursor participates in the retention floor exactly like a healthy
   * one, which is correct — it is still owed its backlog — and which means one
   * extension that parks and is never fixed pins the prune horizon forever while
   * the prune reports success on every run. Past the give-up horizon the cursor
   * is excluded from the floor and stamped here: catch-up becomes impossible and
   * the consumer must be re-registered at the head. Separate from `parkedAt` so
   * the state is an announced one an operator can see, not an inference.
   */
  abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export type DomainEventRow = typeof domainEvents.$inferSelect
export type EventConsumerRow = typeof eventConsumers.$inferSelect
