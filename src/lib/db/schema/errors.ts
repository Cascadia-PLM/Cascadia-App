import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'

/**
 * Error logs table for tracking application errors.
 * Used for analytics, debugging, and monitoring.
 */
export const errorLogs = pgTable(
  'error_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Error identification
    code: text('code').notNull(),
    message: text('message').notNull(),

    // Classification
    severity: text('severity').notNull(), // 'silent' | 'warning' | 'error' | 'critical'
    httpStatus: integer('http_status'),
    isOperational: boolean('is_operational').default(true),

    // Context
    requestId: text('request_id'),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resource: text('resource'), // e.g., 'Part', 'Document'
    operation: text('operation'), // e.g., 'create', 'update', 'delete'

    // Request details
    method: text('method'), // HTTP method
    path: text('path'), // Request path
    userAgent: text('user_agent'),

    // Error details
    stack: text('stack'),
    context: jsonb('context').$type<Record<string, unknown>>(),
    fieldErrors:
      jsonb('field_errors').$type<Array<{ field: string; message: string }>>(),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_error_logs_code').on(table.code),
    index('idx_error_logs_created_at').on(table.createdAt),
    index('idx_error_logs_user_id').on(table.userId),
    index('idx_error_logs_severity').on(table.severity),
  ],
)

// Relations
export const errorLogsRelations = relations(errorLogs, ({ one }) => ({
  user: one(users, {
    fields: [errorLogs.userId],
    references: [users.id],
  }),
}))
