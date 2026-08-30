// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'
import { items } from './items'

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
  ],
)

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
