import { createHash } from 'node:crypto'
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { threadPathCache } from '../db/schema'
import type { ThreadPathCacheSelect } from '../db/schema'
import type { ThreadRequest, ThreadResponse } from './ThreadService'
import type { VersionContext } from './VersionResolver'

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  totalEntries: number
  validEntries: number
  invalidatedEntries: number
  expiredEntries: number
  totalHits: number
  avgComputationTimeMs: number | null
  oldestEntry: Date | null
  newestEntry: Date | null
}

/**
 * Cache key components for hashing
 */
interface CacheKeyComponents {
  domains: Array<string>
  upstreamDepth: number
  downstreamDepth: number
  bomDepth: number
  requirementsDepth: number
  validationDepth: number
}

/**
 * Default cache TTL: 7 days for live caches
 */
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How long to keep invalidated entries before cleanup
 */
const INVALIDATED_RETENTION_MS = 60 * 60 * 1000 // 1 hour

/**
 * Service for caching digital thread computation results.
 *
 * Uses PostgreSQL with JSONB for:
 * - Single transactional boundary with relationship changes
 * - No additional infrastructure (no Redis needed)
 * - Queryable cache entries via JSONB containment operators
 * - Efficient array-based invalidation with GIN indexes
 *
 * Caching rules by context:
 * - Live (no context): Cache with invalidation on relationship changes
 * - Tag/Commit context: Cache indefinitely (immutable snapshots)
 * - Branch context: Cache with invalidation (like live)
 */
export class ThreadCacheService {
  /**
   * Get a cached thread response if available and valid.
   * Returns null if not cached or invalidated.
   */
  static async getCachedThread(
    request: ThreadRequest,
    context?: VersionContext,
  ): Promise<ThreadResponse | null> {
    const cacheKey = this.buildCacheKey(request, context)

    const [cached] = await db
      .select()
      .from(threadPathCache)
      .where(
        and(
          eq(threadPathCache.rootItemId, request.itemId),
          eq(threadPathCache.cacheConfigHash, cacheKey.hash),
          cacheKey.contextType
            ? eq(threadPathCache.contextType, cacheKey.contextType)
            : isNull(threadPathCache.contextType),
          cacheKey.contextId
            ? eq(threadPathCache.contextId, cacheKey.contextId)
            : isNull(threadPathCache.contextId),
          isNull(threadPathCache.invalidatedAt),
          or(
            isNull(threadPathCache.expiresAt),
            gt(threadPathCache.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1)

    if (!cached) {
      return null
    }

    // Fire-and-forget hit tracking
    this.recordHitAsync(cached.id).catch(() => {
      // Silently ignore tracking errors
    })

    return cached.threadData as ThreadResponse
  }

  /**
   * Cache a computed thread response.
   * Overwrites any existing cache entry for the same key.
   */
  static async cacheThread(
    request: ThreadRequest,
    response: ThreadResponse,
    computationTimeMs: number,
    context?: VersionContext,
  ): Promise<void> {
    const cacheKey = this.buildCacheKey(request, context)

    // Collect all item IDs for invalidation queries
    const includedItemIds = this.collectItemIds(response)

    // Determine expiry based on context
    // Tag and commit contexts are immutable, so no expiry
    // Live and branch contexts expire to prevent stale caches
    const isImmutableContext =
      context?.type === 'tag' || context?.type === 'commit'
    const expiresAt = isImmutableContext
      ? null
      : new Date(Date.now() + DEFAULT_CACHE_TTL_MS)

    // Upsert using raw SQL because Drizzle's onConflictDoUpdate target
    // doesn't support the COALESCE expressions used in our unique index.
    const threadData = JSON.stringify(response)
    const now = new Date()
    const itemIdsArray =
      includedItemIds.length > 0
        ? sql`ARRAY[${sql.join(
            includedItemIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`
        : sql`'{}'::uuid[]`

    await db.execute(sql`
      INSERT INTO thread_path_cache (
        root_item_id, cache_config_hash, design_id, context_type, context_id,
        thread_data, included_item_ids, expires_at, computation_time_ms,
        hit_count, last_accessed_at
      ) VALUES (
        ${request.itemId}, ${cacheKey.hash}, ${response.focalItem.designId || null},
        ${cacheKey.contextType ?? null}, ${cacheKey.contextId ?? null},
        ${threadData}::jsonb, ${itemIdsArray},
        ${expiresAt}, ${computationTimeMs}, 0, ${now}
      )
      ON CONFLICT (
        root_item_id, cache_config_hash,
        COALESCE(context_type, ''),
        COALESCE(context_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
      DO UPDATE SET
        thread_data = EXCLUDED.thread_data,
        included_item_ids = EXCLUDED.included_item_ids,
        expires_at = EXCLUDED.expires_at,
        computation_time_ms = EXCLUDED.computation_time_ms,
        computed_at = NOW(),
        invalidated_at = NULL,
        hit_count = 0,
        last_accessed_at = NOW()
    `)
  }

  /**
   * Invalidate cache entries that contain the affected items.
   * Called when relationships are added or removed.
   * Returns the number of entries invalidated.
   */
  static async invalidateForRelationship(
    sourceId: string,
    targetId: string,
  ): Promise<number> {
    return this.invalidateForItems([sourceId, targetId])
  }

  /**
   * Invalidate cache entries that contain a specific item.
   * Returns the number of entries invalidated.
   */
  static async invalidateForItem(itemId: string): Promise<number> {
    return this.invalidateForItems([itemId])
  }

  /**
   * Invalidate cache entries that contain any of the specified items.
   * Uses PostgreSQL array overlap operator (&&) for efficient querying.
   * Only invalidates live and branch caches, not immutable tag/commit caches.
   */
  static async invalidateForItems(itemIds: Array<string>): Promise<number> {
    if (itemIds.length === 0) return 0

    const result = await db
      .update(threadPathCache)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          isNull(threadPathCache.invalidatedAt),
          // Only invalidate live (null context) or branch caches
          // Tag and commit caches are immutable snapshots
          or(
            isNull(threadPathCache.contextType),
            eq(threadPathCache.contextType, 'branch'),
          ),
          // Array overlap: entries containing any of the affected items
          // Use PostgreSQL array literal format {id1,id2} for proper casting
          sql`${threadPathCache.includedItemIds} && ${`{${itemIds.join(',')}}`}::uuid[]`,
        ),
      )

    // Drizzle doesn't return row count directly, we need to count affected
    // This is a workaround since PostgreSQL UPDATE doesn't return count in Drizzle
    return result.rowCount ?? 0
  }

  /**
   * Warm the cache for a set of items by pre-computing their threads.
   * Useful for batch operations or after large data imports.
   */
  static async warmCache(
    itemIds: Array<string>,
    request?: Partial<ThreadRequest>,
  ): Promise<{ warmed: number; errors: number }> {
    // Import dynamically to avoid circular dependency
    const { ThreadService } = await import('./ThreadService')

    let warmed = 0
    let errors = 0

    for (const itemId of itemIds) {
      try {
        const fullRequest: ThreadRequest = {
          itemId,
          domains: request?.domains ?? [
            'requirements',
            'engineering',
            'manufacturing',
            'validation',
          ],
          upstreamDepth: request?.upstreamDepth ?? 5,
          downstreamDepth: request?.downstreamDepth ?? 5,
          bomDepth: request?.bomDepth ?? 3,
          requirementsDepth: request?.requirementsDepth ?? 3,
          validationDepth: request?.validationDepth ?? 3,
        }

        // This will automatically cache the result via ThreadService integration
        await ThreadService.getThread(fullRequest)
        warmed++
      } catch {
        errors++
      }
    }

    return { warmed, errors }
  }

  /**
   * Get cache statistics for monitoring.
   */
  static async getStats(): Promise<CacheStats> {
    const now = new Date()

    // Get counts
    const [stats] = await db
      .select({
        totalEntries: sql<number>`count(*)::int`,
        validEntries: sql<number>`count(*) filter (where ${threadPathCache.invalidatedAt} is null and (${threadPathCache.expiresAt} is null or ${threadPathCache.expiresAt} > ${now}))::int`,
        invalidatedEntries: sql<number>`count(*) filter (where ${threadPathCache.invalidatedAt} is not null)::int`,
        expiredEntries: sql<number>`count(*) filter (where ${threadPathCache.expiresAt} is not null and ${threadPathCache.expiresAt} <= ${now})::int`,
        totalHits: sql<number>`coalesce(sum(${threadPathCache.hitCount}), 0)::int`,
        avgComputationTimeMs: sql<
          number | null
        >`avg(${threadPathCache.computationTimeMs})`,
        oldestEntry: sql<Date | null>`min(${threadPathCache.computedAt})`,
        newestEntry: sql<Date | null>`max(${threadPathCache.computedAt})`,
      })
      .from(threadPathCache)

    return {
      totalEntries: stats?.totalEntries ?? 0,
      validEntries: stats?.validEntries ?? 0,
      invalidatedEntries: stats?.invalidatedEntries ?? 0,
      expiredEntries: stats?.expiredEntries ?? 0,
      totalHits: stats?.totalHits ?? 0,
      avgComputationTimeMs: stats?.avgComputationTimeMs ?? null,
      oldestEntry: stats?.oldestEntry ?? null,
      newestEntry: stats?.newestEntry ?? null,
    }
  }

  /**
   * Clean up expired and old invalidated cache entries.
   * Returns the number of entries removed.
   */
  static async cleanup(
    maxAgeMs: number = DEFAULT_CACHE_TTL_MS,
    maxInvalidatedAgeMs: number = INVALIDATED_RETENTION_MS,
  ): Promise<number> {
    const now = new Date()
    const maxAgeDate = new Date(now.getTime() - maxAgeMs)
    const maxInvalidatedDate = new Date(now.getTime() - maxInvalidatedAgeMs)

    const result = await db.delete(threadPathCache).where(
      or(
        // Remove expired entries
        and(
          isNotNull(threadPathCache.expiresAt),
          lt(threadPathCache.expiresAt, now),
        ),
        // Remove old invalidated entries
        and(
          isNotNull(threadPathCache.invalidatedAt),
          lt(threadPathCache.invalidatedAt, maxInvalidatedDate),
        ),
        // Remove entries older than max age (regardless of status)
        lt(threadPathCache.computedAt, maxAgeDate),
      ),
    )

    return result.rowCount ?? 0
  }

  /**
   * Clear all cache entries.
   * Use with caution - mainly for testing or major schema changes.
   */
  static async clearAll(): Promise<number> {
    const result = await db.delete(threadPathCache)
    return result.rowCount ?? 0
  }

  /**
   * Get cache entry details for debugging.
   */
  static async getEntryDetails(
    request: ThreadRequest,
    context?: VersionContext,
  ): Promise<ThreadPathCacheSelect | null> {
    const cacheKey = this.buildCacheKey(request, context)

    const [entry] = await db
      .select()
      .from(threadPathCache)
      .where(
        and(
          eq(threadPathCache.rootItemId, request.itemId),
          eq(threadPathCache.cacheConfigHash, cacheKey.hash),
          cacheKey.contextType
            ? eq(threadPathCache.contextType, cacheKey.contextType)
            : isNull(threadPathCache.contextType),
          cacheKey.contextId
            ? eq(threadPathCache.contextId, cacheKey.contextId)
            : isNull(threadPathCache.contextId),
        ),
      )
      .limit(1)

    return entry || null
  }

  // Private helper methods

  /**
   * Build cache key from request parameters.
   * Returns hash of normalized parameters and context info.
   */
  private static buildCacheKey(
    request: ThreadRequest,
    context?: VersionContext,
  ): { hash: string; contextType: string | null; contextId: string | null } {
    // Normalize and sort parameters for consistent hashing
    const components: CacheKeyComponents = {
      domains: [...(request.domains ?? [])].sort(),
      upstreamDepth: request.upstreamDepth ?? 5,
      downstreamDepth: request.downstreamDepth ?? 5,
      bomDepth: request.bomDepth ?? 3,
      requirementsDepth: request.requirementsDepth ?? 3,
      validationDepth: request.validationDepth ?? 3,
    }

    const hash = createHash('sha256')
      .update(JSON.stringify(components))
      .digest('hex')

    return {
      hash,
      contextType: context?.type ?? null,
      contextId: this.getContextId(context) ?? null,
    }
  }

  /**
   * Extract the relevant ID from a version context.
   */
  private static getContextId(context?: VersionContext): string | null {
    if (!context) return null

    switch (context.type) {
      case 'tag':
        return context.tagId
      case 'branch':
        return context.branchId
      case 'commit':
        return context.commitId
      case 'released':
        return null // Released context doesn't have a specific ID
      default:
        return null
    }
  }

  /**
   * Collect all item IDs from a thread response for invalidation tracking.
   */
  private static collectItemIds(response: ThreadResponse): Array<string> {
    const ids = new Set<string>()

    // Add focal item
    ids.add(response.focalItem.id)

    // Add all domain items
    for (const node of response.domains.requirements) {
      ids.add(node.id)
    }
    for (const node of response.domains.engineering) {
      ids.add(node.id)
    }
    for (const node of response.domains.manufacturing) {
      ids.add(node.id)
    }
    for (const node of response.domains.validation) {
      ids.add(node.id)
    }

    return Array.from(ids)
  }

  /**
   * Record a cache hit asynchronously.
   * Fire-and-forget to avoid slowing down cache reads.
   */
  private static async recordHitAsync(cacheId: string): Promise<void> {
    await db
      .update(threadPathCache)
      .set({
        hitCount: sql`${threadPathCache.hitCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(threadPathCache.id, cacheId))
  }
}
