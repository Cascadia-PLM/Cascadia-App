import {
  boolean,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'
import type { RuntimeItemTypeConfig } from '@/lib/items/types/runtime-config'

// Re-export for backward compatibility
export type { RuntimeItemTypeConfig } from '@/lib/items/types/runtime-config'

/**
 * Runtime configuration for item types.
 * Allows overriding code-defined defaults without redeployment.
 *
 * Code defines: schema, components, table mappings (type-safe, requires deployment)
 * Runtime defines: labels, permissions, states, relationships (business rules, no deployment)
 */
export const itemTypeConfigs = pgTable('item_type_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemType: varchar('item_type', { length: 50 }).notNull().unique(),
  config: jsonb('config').notNull().$type<RuntimeItemTypeConfig>(),
  version: integer('version').notNull().default(1),
  isActive: boolean('is_active').default(true).notNull(),
  modifiedBy: uuid('modified_by')
    .notNull()
    .references(() => users.id),
  modifiedAt: timestamp('modified_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const itemTypeConfigsRelations = relations(
  itemTypeConfigs,
  ({ one }) => ({
    modifier: one(users, {
      fields: [itemTypeConfigs.modifiedBy],
      references: [users.id],
    }),
  }),
)
