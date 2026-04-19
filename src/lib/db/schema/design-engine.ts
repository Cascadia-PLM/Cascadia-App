/**
 * Design Engine Schema
 *
 * Database table for collaborative design sessions that guide users through
 * description -> requirements -> BOM -> materialization.
 */

import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'
import { programs } from './programs'
import { designs } from './designs'
import { aiChatSessions } from './ai'
import type {
  DesignArtifacts,
  LlmHistoryEntry,
} from '@/lib/design-engine/types'

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
  },
  (table) => [
    index('design_sessions_user_id_idx').on(table.userId),
    index('design_sessions_program_id_idx').on(table.programId),
    index('design_sessions_status_idx').on(table.status),
  ],
)

// ============================================================================
// Relations
// ============================================================================

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
