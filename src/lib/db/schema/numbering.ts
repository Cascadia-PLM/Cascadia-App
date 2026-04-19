import {
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Tracks sequence counters for auto-generated item numbers.
 * Supports multiple scoping strategies (global, per-design, per-prefix, yearly).
 */
export const numberSequences = pgTable(
  'number_sequences',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The item type this sequence is for (Part, Document, etc.) */
    itemType: varchar('item_type', { length: 50 }).notNull(),

    /**
     * Scope key determines when the sequence resets.
     * Examples:
     *   - global: 'Part'
     *   - design: 'Part:design:uuid-here'
     *   - prefix: 'Part:prefix:FAB' or 'Part:prefix:M-AL'
     *   - yearly: 'Part:year:2024'
     *   - family: 'family:PN-000001'
     */
    scopeKey: varchar('scope_key', { length: 200 }).notNull(),

    /** Current value of the sequence (last assigned number) */
    currentValue: integer('current_value').notNull().default(0),

    /** When this sequence was last modified */
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [unique('unique_sequence').on(table.itemType, table.scopeKey)],
)

export type NumberSequence = typeof numberSequences.$inferSelect
export type NewNumberSequence = typeof numberSequences.$inferInsert
