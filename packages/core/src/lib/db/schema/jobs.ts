// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { users } from './users'
import { items } from './items'
import type { SQL } from 'drizzle-orm'

/**
 * The statuses in which a job has released its dedupe key, as SQL text.
 *
 * Text rather than bound parameters because the partial unique index needs a
 * literal predicate — DDL cannot carry a parameter — and the same text is what
 * `dedupeKeyHeld` restates for ON CONFLICT inference.
 */
const DEDUPE_KEY_RELEASING_STATUSES_SQL = `'failed', 'cancelled'`

// Job status and priority types
export type JobStatus =
  'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type JobPriority = 'low' | 'normal' | 'high' | 'critical'

/**
 * Background jobs table
 * Stores job state while RabbitMQ handles dispatch
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: varchar('type', { length: 100 }).notNull(),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('pending')
      .$type<JobStatus>(),
    priority: varchar('priority', { length: 20 })
      .notNull()
      .default('normal')
      .$type<JobPriority>(),

    // Payload and results (typed JSONB)
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),

    // Progress tracking
    progress: integer('progress').default(0),
    progressMessage: text('progress_message'),

    /**
     * Caller-supplied natural key making a submission idempotent.
     *
     * Null for almost every job: a submission is normally a fresh request and
     * two of them are two jobs. It is set by a caller that may be asked to
     * submit the same work twice and must not produce two — above all a
     * `consumed` extension, because event delivery is at-least-once.
     *
     * **This is why it lives here rather than on the caller.** A handler runs
     * in a savepoint while `JobService.submit` writes through the module-level
     * connection, so every way a duplicate arises — the handler throwing after
     * the submit, or the run transaction failing at COMMIT — rolls back the
     * handler's own bookkeeping and leaves the job behind. A dedupe row inside
     * the handler therefore cannot see the job it is trying to deduplicate.
     * This column can, because it is on the row that survived.
     *
     * Uniqueness is enforced by a **partial** index over non-null values, so
     * the null majority costs nothing and cannot collide with itself.
     *
     * **A key is held only by live or finished work.** A job that is pending,
     * queued, running or completed holds its key; one that failed — its broker
     * publish failed, or it exhausted its attempts — or was cancelled has
     * released it, and the same work can be submitted again. Without that, a
     * failed publish wedged its key for good: every later submission under it
     * was answered with the dead job and nothing was ever queued, while the
     * caller recorded success. The partial index below enforces this, so it
     * holds for every writer of `status` — the Python workers included.
     *
     * One bound worth knowing: the key lives exactly as long as its job row, so
     * it deduplicates against history that still exists. A redelivery arriving
     * after the job has been pruned submits again — which needs a cursor rewound
     * past the job retention window, and is not a case this is trying to cover.
     */
    dedupeKey: varchar('dedupe_key', { length: 200 }),

    // Relationships
    itemId: uuid('item_id').references(() => items.id, {
      onDelete: 'set null',
    }),
    // Nullable: NULL means the system submitted the job (the scheduler's
    // maintenance sweep) — released installs have no seeded system user to
    // attribute it to, and inventing one via migration would fight the auth
    // schema.
    createdBy: uuid('created_by').references(() => users.id),

    // Timing
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    // Retry handling
    attempts: integer('attempts').default(0),
    maxAttempts: integer('max_attempts').default(3),
    // The backoff schedule snapshotted from the type's JobTypeConfig at
    // submit time, in **milliseconds** (the TS convention every config
    // already uses). Carried on the row for the same reason `maxAttempts`
    // is: the Python workers cannot read the TypeScript registry, so both
    // `markFailed` implementations read this one value instead of each
    // keeping its own table of numbers. NULL means a pre-migration row (or
    // a type that declares no delays) and the executor falls back to its own
    // default — deliberately not backfilled, since a backfill would need the
    // registry inside a SQL migration.
    retryDelays: jsonb('retry_delays').$type<Array<number>>(),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_jobs_status').on(table.status),
    index('idx_jobs_type').on(table.type),
    index('idx_jobs_item').on(table.itemId),
    index('idx_jobs_created_by').on(table.createdBy),
    index('idx_jobs_created_at').on(table.createdAt),
    index('idx_jobs_next_retry').on(table.nextRetryAt),
    index('idx_jobs_status_priority').on(table.status, table.priority),
    // Partial twice over. Over non-null keys, so the null majority neither
    // pays for the index nor collides with itself; and over jobs that still
    // hold their key, so a failed or cancelled job releases it (see
    // `dedupeKey`). `JobService.submit` restates this predicate for ON CONFLICT
    // inference, which Postgres performs only when it can prove they match.
    uniqueIndex('uq_jobs_dedupe_key')
      .on(table.dedupeKey)
      .where(
        sql`${table.dedupeKey} IS NOT NULL AND ${table.status} NOT IN (${sql.raw(DEDUPE_KEY_RELEASING_STATUSES_SQL)})`,
      ),
  ],
)

/**
 * A job row that still holds its dedupe key: the predicate of the partial
 * unique index `uq_jobs_dedupe_key`, restated for queries. ON CONFLICT infers
 * a partial index only when its `where` provably implies the index predicate,
 * and a holder lookup must not return a job that has already released the key.
 */
export const dedupeKeyHeld: SQL = sql`${jobs.dedupeKey} IS NOT NULL AND ${jobs.status} NOT IN (${sql.raw(DEDUPE_KEY_RELEASING_STATUSES_SQL)})`

/**
 * Job logs for debugging and audit trail
 */
export const jobLogs = pgTable(
  'job_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    level: varchar('level', { length: 10 }).notNull(), // 'debug', 'info', 'warn', 'error'
    message: text('message').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_job_logs_job').on(table.jobId),
    index('idx_job_logs_created_at').on(table.createdAt),
  ],
)

// Relations
export const jobsRelations = relations(jobs, ({ one, many }) => ({
  creator: one(users, {
    fields: [jobs.createdBy],
    references: [users.id],
    relationName: 'jobCreator',
  }),
  item: one(items, {
    fields: [jobs.itemId],
    references: [items.id],
  }),
  logs: many(jobLogs),
}))

export const jobLogsRelations = relations(jobLogs, ({ one }) => ({
  job: one(jobs, {
    fields: [jobLogs.jobId],
    references: [jobs.id],
  }),
}))
