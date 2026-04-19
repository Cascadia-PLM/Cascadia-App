import { cacheCleanupPayloadSchema, cacheCleanupResultSchema } from './types'
import type { CacheCleanupPayload, CacheCleanupResult } from './types'
import type { JobTypeConfig } from '../../types'

/**
 * Configuration for thread cache cleanup job.
 *
 * This job removes:
 * - Expired cache entries
 * - Old invalidated cache entries
 * - Entries older than the maximum age
 *
 * Recommended to run daily or hourly via a scheduler.
 */
export const cacheCleanupConfig: JobTypeConfig<
  CacheCleanupPayload,
  CacheCleanupResult
> = {
  type: 'maintenance.cache.cleanup',
  label: 'Thread Cache Cleanup',
  routingKey: 'jobs.maintenance.cache',

  payloadSchema: cacheCleanupPayloadSchema,
  resultSchema: cacheCleanupResultSchema,

  timeout: 60000, // 1 minute
  maxAttempts: 3,
  retryDelays: [30000, 60000, 120000], // 30s, 1min, 2min
  priority: 'low', // Maintenance jobs are low priority
}
