// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design Engine Schema
 *
 * Database table for collaborative design sessions that guide users through
 * description -> requirements -> BOM -> materialization.
 */

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
import { relations } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type {
  DesignArtifacts,
  LlmHistoryEntry,
  MaterializationJournal,
  UserMessage,
} from '@/design-engine/types'
import { users } from '@/db/schema/users'
import { programs } from '@/db/schema/programs'
import { designs } from '@/db/schema/designs'
import { aiChatSessions } from '@/db/schema/ai'

// ============================================================================
// Design Sessions Table
// ============================================================================

export const designSessions = pgTable(
  'design_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Owner
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Link to originating AI chat (optional)
    aiChatSessionId: uuid('ai_chat_session_id').references(
      () => aiChatSessions.id,
      { onDelete: 'set null' },
    ),

    // Context
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    designId: uuid('design_id').references(() => designs.id, {
      onDelete: 'set null',
    }),

    // Session metadata
    title: varchar('title', { length: 255 }),
    stage: varchar('stage', { length: 50 }).notNull().default('idle'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    description: text('description'),

    // Structured artifacts (requirements, BOM draft, etc.)
    artifacts: jsonb('artifacts').$type<DesignArtifacts>(),

    // Full LLM conversation history for context continuity
    llmHistory: jsonb('llm_history').$type<Array<LlmHistoryEntry>>(),

    // Mid-stream steering mailbox: guidance sent while a drafting stream is
    // in flight. The running stage loop drains it at tool-call boundaries.
    // Lives outside `artifacts` because that blob has two independent
    // full-object writers (stage loop + client PATCH) that would clobber it.
    pendingGuidance: jsonb('pending_guidance')
      .$type<Array<UserMessage>>()
      .default([])
      .notNull(),

    // The one live stream's claim. A session may have exactly one streaming
    // writer: every streaming action claims before its generator starts, the
    // stream heartbeats streamClaimedAt while it runs, and a second tab gets
    // a 409 instead of a second generator racing the first over `artifacts`.
    // A crashed server strands its claim only until the staleness window
    // passes (see DesignSessionService.claimStream).
    activeStreamId: uuid('active_stream_id'),
    streamClaimedAt: timestamp('stream_claimed_at', { withTimezone: true }),

    // Step journal of the running/failed materialization (DE-3). NULL when
    // none has run or the last one succeeded; a 'failed' (or stale
    // 'running') journal is what execute() resumes from. Owned exclusively
    // by MaterializationService — claimed by compare-and-set, so a second
    // concurrent materialize gets 409 instead of a duplicate item tree.
    materializationJournal: jsonb(
      'materialization_journal',
    ).$type<MaterializationJournal>(),

    // Monotonic artifacts write counter, bumped by every artifacts write and
    // by nothing else. The compare-and-set token for read-modify-write
    // updates: `updatedAt` cannot play this role because every updater
    // (stage, status, guidance) writes it at millisecond precision.
    artifactsVersion: integer('artifacts_version').notNull().default(0),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    // Materialization result
    materializedDesignId: uuid('materialized_design_id').references(
      () => designs.id,
      { onDelete: 'set null' },
    ),

    // Error tracking
    errorMessage: text('error_message'),

    // Fork lineage: the session this one was forked from (variant exploration)
    forkedFromSessionId: uuid('forked_from_session_id').references(
      (): AnyPgColumn => designSessions.id,
      { onDelete: 'set null' },
    ),
  },
  (table) => [
    index('design_sessions_user_id_idx').on(table.userId),
    index('design_sessions_program_id_idx').on(table.programId),
    index('design_sessions_status_idx').on(table.status),
  ],
)

// ============================================================================
// Design Session Snapshots Table
// ============================================================================

/**
 * Immutable snapshots of a session's artifacts, captured at every review-gate
 * confirmation. Append-only: re-confirming a stage after a reopen inserts a
 * new row; "latest seq for stage" wins for diff bases and rollback targets.
 *
 * Deliberately a separate table rather than an array inside
 * design_sessions.artifacts — the artifacts JSONB has two independent
 * full-blob writers (the stage loop and the client PATCH), so anything
 * embedded there would be clobbered, and every stage-loop write would
 * re-serialize the full history.
 */
export const designSessionSnapshots = pgTable(
  'design_session_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    sessionId: uuid('session_id')
      .notNull()
      .references(() => designSessions.id, { onDelete: 'cascade' }),

    // The review stage that was confirmed ('toolset_review', 'requirements_review', ...)
    stage: varchar('stage', { length: 50 }).notNull(),

    // Monotonic per session
    seq: integer('seq').notNull(),

    // Full DesignArtifacts at confirm time
    artifacts: jsonb('artifacts').$type<DesignArtifacts>().notNull(),

    // llmHistory length at confirm time, so rollback can truncate the
    // conversation to what the AI knew when this state was approved
    llmHistoryLength: integer('llm_history_length').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('design_session_snapshots_session_id_idx').on(table.sessionId),
    index('design_session_snapshots_session_stage_idx').on(
      table.sessionId,
      table.stage,
    ),
    // What makes "Monotonic per session" true. The seq was minted by reading
    // max(seq) and inserting seq+1 in a READ COMMITTED transaction, so two
    // concurrent confirms could mint the same number — and a tie makes
    // `getLatestForStage`, the diff base and the rollback target, pick by row
    // order. `DesignSnapshotService.create` now retries against this index.
    //
    // `copyToSession` bulk-copies seqs verbatim, which is safe: it only ever
    // writes into a freshly created fork session, which has no rows yet.
    uniqueIndex('uq_design_snapshots_session_seq').on(
      table.sessionId,
      table.seq,
    ),
  ],
)

// ============================================================================
// Relations
// ============================================================================

export const designSessionSnapshotsRelations = relations(
  designSessionSnapshots,
  ({ one }) => ({
    session: one(designSessions, {
      fields: [designSessionSnapshots.sessionId],
      references: [designSessions.id],
    }),
  }),
)

export const designSessionsRelations = relations(designSessions, ({ one }) => ({
  user: one(users, {
    fields: [designSessions.userId],
    references: [users.id],
  }),
  program: one(programs, {
    fields: [designSessions.programId],
    references: [programs.id],
  }),
  design: one(designs, {
    fields: [designSessions.designId],
    references: [designs.id],
  }),
  aiChatSession: one(aiChatSessions, {
    fields: [designSessions.aiChatSessionId],
    references: [aiChatSessions.id],
  }),
  materializedDesign: one(designs, {
    fields: [designSessions.materializedDesignId],
    references: [designs.id],
    relationName: 'materializedDesign',
  }),
}))
