// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  boolean,
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
import { programs } from './programs'
import { designs } from './designs'

// Types for AI configuration
export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'ollama'

export interface AIProviderConfig {
  provider: ProviderType
  apiKey?: string
  model: string
  baseURL?: string
  /**
   * Monthly token ceiling (input + output summed over `ai_usage_logs`) for
   * the scope this settings row governs. On a program's settings row the
   * budget bounds that program's month-to-date spend; on the global row it
   * bounds the whole instance's. Unset or 0 means unlimited — and no usage
   * query runs at all. Enforced in `loadProviderConfig`, so every AI
   * surface (chat, design engine, enrichment) passes through it.
   */
  monthlyTokenBudget?: number
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  toolCallId: string
  result: unknown
  error?: string
}

// AI Chat Sessions table
export const aiChatSessions = pgTable(
  'ai_chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // User who owns this session
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Optional program/design context
    programId: uuid('program_id').references(() => programs.id, {
      onDelete: 'set null',
    }),
    designId: uuid('design_id').references(() => designs.id, {
      onDelete: 'set null',
    }),

    // Session title (auto-generated from first message)
    title: varchar('title', { length: 255 }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('ai_chat_sessions_user_id_idx').on(table.userId),
    index('ai_chat_sessions_program_id_idx').on(table.programId),
  ],
)

// AI Chat Messages table
export const aiChatMessages = pgTable(
  'ai_chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Session this message belongs to
    sessionId: uuid('session_id')
      .notNull()
      .references(() => aiChatSessions.id, { onDelete: 'cascade' }),

    // Message role: 'system', 'user', 'assistant', 'tool'
    role: varchar('role', { length: 20 }).notNull(),

    // Message content
    content: text('content').notNull(),

    // Tool calls made by assistant (for role='assistant')
    toolCalls: jsonb('tool_calls').$type<Array<ToolCall>>(),

    // Tool response info (for role='tool')
    toolCallId: varchar('tool_call_id', { length: 100 }),
    toolName: varchar('tool_name', { length: 100 }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('ai_chat_messages_session_id_idx').on(table.sessionId),
    index('ai_chat_messages_created_at_idx').on(table.createdAt),
  ],
)

// AI Settings table - stores provider configuration
export const aiSettings = pgTable(
  'ai_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Null programId = global default settings
    programId: uuid('program_id').references(() => programs.id, {
      onDelete: 'cascade',
    }),

    // Provider configuration
    provider: varchar('provider', { length: 50 }).notNull(),
    config: jsonb('config').$type<AIProviderConfig>().notNull(),

    // Enable/disable AI for this scope
    enabled: boolean('enabled').default(true).notNull(),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('ai_settings_program_id_idx').on(table.programId)],
)

// AI Usage Logs table - audit trail for AI actions
export const aiUsageLogs = pgTable(
  'ai_usage_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Session context (optional - some logs may be standalone)
    sessionId: uuid('session_id').references(() => aiChatSessions.id, {
      onDelete: 'set null',
    }),

    // User who triggered the action
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Program the session was scoped to when the tokens were spent. This is
    // what a per-program budget (AI-2) sums over, so it lives on the log row
    // rather than being joined through the session — a session's program can
    // change, and spend must stay attributed to where it happened.
    programId: uuid('program_id').references(() => programs.id, {
      onDelete: 'set null',
    }),

    // Tool execution details
    toolName: varchar('tool_name', { length: 100 }),
    toolParams: jsonb('tool_params'),
    toolResult: jsonb('tool_result'),
    error: text('error'),

    // Token usage tracking
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),

    // Model used
    provider: varchar('provider', { length: 50 }),
    model: varchar('model', { length: 100 }),

    // Timing
    durationMs: integer('duration_ms'),

    // Timestamp
    timestamp: timestamp('timestamp', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('ai_usage_logs_session_id_idx').on(table.sessionId),
    index('ai_usage_logs_user_id_idx').on(table.userId),
    index('ai_usage_logs_timestamp_idx').on(table.timestamp),
    // The budget query shape: spend for one program over a time window
    index('ai_usage_logs_program_id_timestamp_idx').on(
      table.programId,
      table.timestamp,
    ),
  ],
)

// AI write confirmations — server-issued single-use tokens (AI-3).
//
// A write tool's preview response carries an opaque token; executing the
// write requires redeeming it. The row binds the token to the user, the
// tool, and a hash of the exact preview parameters, so the confirmed call
// must be the previewed call — a model (or a prompt-injected agent) cannot
// skip the preview or confirm something different from what was shown.
// Tokens are stored hashed (like sessions), expire quickly, and redeem
// atomically exactly once.
export const aiWriteConfirmations = pgTable(
  'ai_write_confirmations',
  {
    // sha256 hex of the raw token; the raw token never touches the database.
    tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toolName: varchar('tool_name', { length: 100 }).notNull(),
    // sha256 hex of the canonical JSON of the previewed input (minus the
    // confirmation fields themselves).
    paramsHash: varchar('params_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [
    // Opportunistic cleanup scans by expiry.
    index('ai_write_confirmations_expires_at_idx').on(table.expiresAt),
  ],
)

// Relations
export const aiChatSessionsRelations = relations(
  aiChatSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [aiChatSessions.userId],
      references: [users.id],
    }),
    program: one(programs, {
      fields: [aiChatSessions.programId],
      references: [programs.id],
    }),
    design: one(designs, {
      fields: [aiChatSessions.designId],
      references: [designs.id],
    }),
    messages: many(aiChatMessages),
    usageLogs: many(aiUsageLogs),
  }),
)

export const aiChatMessagesRelations = relations(aiChatMessages, ({ one }) => ({
  session: one(aiChatSessions, {
    fields: [aiChatMessages.sessionId],
    references: [aiChatSessions.id],
  }),
}))

export const aiSettingsRelations = relations(aiSettings, ({ one }) => ({
  program: one(programs, {
    fields: [aiSettings.programId],
    references: [programs.id],
  }),
}))

export const aiUsageLogsRelations = relations(aiUsageLogs, ({ one }) => ({
  session: one(aiChatSessions, {
    fields: [aiUsageLogs.sessionId],
    references: [aiChatSessions.id],
  }),
  user: one(users, {
    fields: [aiUsageLogs.userId],
    references: [users.id],
  }),
}))
