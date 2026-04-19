import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'

export const settings = pgTable('settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 100 }).notNull().unique(), // Setting key (e.g., 'vault_location', 'vault_type')
  value: text('value'), // Setting value (for simple text values)
  jsonValue: jsonb('json_value'), // For complex structured values
  description: text('description'), // Human-readable description
  modifiedAt: timestamp('modified_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  modifiedBy: uuid('modified_by')
    .notNull()
    .references(() => users.id),
})

export const settingsRelations = relations(settings, ({ one }) => ({
  modifier: one(users, {
    fields: [settings.modifiedBy],
    references: [users.id],
  }),
}))
