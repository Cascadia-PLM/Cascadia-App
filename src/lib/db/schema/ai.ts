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
