import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { designs } from './designs'
import { items } from './items'

/**
 * Thread Path Cache Table
 *
 * Caches computed digital thread responses to avoid N+1 query patterns
 * during recursive traversal across domains. For a moderately complex design
 * with 50 items and 100 relationships, this reduces query counts from 100+
 * to 1 on cache hits.
 *
 * Cache key components:
 * - root_item_id: The focal item for the thread
 * - cache_config_hash: SHA-256 hash of normalized request parameters
 * - context_type + context_id: Version context (tag, branch, commit, released)
 *
 * Invalidation strategy:
 * - Live caches (no context) are invalidated when relationships change
 * - Version-context caches (tag/commit) are immutable and never invalidated
 * - Branch-context caches are invalidated like live caches
 */
export const threadPathCache = pgTable(
  'thread_path_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Cache key components
    rootItemId: uuid('root_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),

    // SHA-256 hash of request parameters (domains, depths, etc.)
    cacheConfigHash: varchar('cache_config_hash', { length: 64 }).notNull(),

    // Version context (null = current/live)
    designId: uuid('design_id').references(() => designs.id, {
      onDelete: 'cascade',
    }),

    // Context type: 'tag', 'branch', 'commit', 'released' (null = live)
    contextType: varchar('context_type', { length: 20 }),

    // Context ID (tag ID, branch ID, or commit ID)
    contextId: uuid('context_id'),

    // Cached data - the full ThreadResponse as JSON
    threadData: jsonb('thread_data').notNull(),

    // Array of all item IDs included in this thread (for invalidation queries)
    // Uses PostgreSQL array overlap operator (&&) for efficient invalidation
    includedItemIds: uuid('included_item_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    // Freshness tracking
    computedAt: timestamp('computed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),

    // Optional expiry (null = no expiry, relies on invalidation)
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    // Soft invalidation timestamp (set when relationships change)
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),

    // Stats for monitoring and optimization
    hitCount: integer('hit_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    computationTimeMs: integer('computation_time_ms'),
  },
  (table) => [
    // Primary lookup index
    index('idx_thread_cache_root').on(table.rootItemId),

    // Expiry cleanup index
    index('idx_thread_cache_expiry').on(table.expiresAt),

    // Design-scoped queries
    index('idx_thread_cache_design').on(table.designId),

    // GIN index for array overlap queries during invalidation
    // Enables efficient: WHERE included_item_ids && ARRAY[id1, id2]::uuid[]
    index('idx_thread_cache_items').using('gin', sql`${table.includedItemIds}`),

    // Invalidated entries cleanup
    index('idx_thread_cache_invalidated').on(table.invalidatedAt),

    // Unique constraint on cache key
    // Uses COALESCE to handle null context values
    uniqueIndex('idx_thread_cache_unique_key').on(
      table.rootItemId,
      table.cacheConfigHash,
      sql`COALESCE(${table.contextType}, '')`,
      sql`COALESCE(${table.contextId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
)

// Type inference for the table
export type ThreadPathCacheSelect = typeof threadPathCache.$inferSelect
export type ThreadPathCacheInsert = typeof threadPathCache.$inferInsert
