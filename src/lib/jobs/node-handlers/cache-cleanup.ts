import { ThreadCacheService } from '../../services/ThreadCacheService'
import type { JobContext, JobHandler } from '../types'
import type {
  CacheCleanupPayload,
  CacheCleanupResult,
} from '../definitions/cache-cleanup/types'

/**
 * Handler for thread cache cleanup jobs.
 * Removes expired and old invalidated cache entries to free up database space.
 */
export const cacheCleanupHandler: JobHandler<
  CacheCleanupPayload,
  CacheCleanupResult
> = {
  type: 'maintenance.cache.cleanup',

  async execute(
    payload: CacheCleanupPayload,
    context: JobContext,
  ): Promise<CacheCleanupResult> {
    const { maxAgeDays = 7, maxInvalidatedAgeHours = 1 } = payload

    await context.log.info('Starting thread cache cleanup', {
      maxAgeDays,
      maxInvalidatedAgeHours,
    })

    if (context.signal.aborted) {
      throw new Error('Job was cancelled')
    }

    // Get stats before cleanup
    await context.updateProgress(10, 'Getting cache stats...')
    const statsBefore = await ThreadCacheService.getStats()

    await context.log.info('Cache stats before cleanup', {
      totalEntries: statsBefore.totalEntries,
      validEntries: statsBefore.validEntries,
      invalidatedEntries: statsBefore.invalidatedEntries,
      expiredEntries: statsBefore.expiredEntries,
    })

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- aborted may change between job steps
    if (context.signal.aborted) {
      throw new Error('Job was cancelled')
    }

    // Perform cleanup
    await context.updateProgress(30, 'Cleaning up cache entries...')
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
    const maxInvalidatedAgeMs = maxInvalidatedAgeHours * 60 * 60 * 1000

    const removed = await ThreadCacheService.cleanup(
      maxAgeMs,
      maxInvalidatedAgeMs,
    )

    await context.log.info('Removed cache entries', { removed })

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- aborted may change between job steps
    if (context.signal.aborted) {
      throw new Error('Job was cancelled')
    }

    // Get stats after cleanup
    await context.updateProgress(80, 'Getting final cache stats...')
    const statsAfter = await ThreadCacheService.getStats()

    await context.log.info('Cache stats after cleanup', {
      totalEntries: statsAfter.totalEntries,
      validEntries: statsAfter.validEntries,
      invalidatedEntries: statsAfter.invalidatedEntries,
      expiredEntries: statsAfter.expiredEntries,
    })

    await context.updateProgress(100, 'Cleanup complete')

    return {
      removed,
      statsBefore: {
        totalEntries: statsBefore.totalEntries,
        validEntries: statsBefore.validEntries,
        invalidatedEntries: statsBefore.invalidatedEntries,
        expiredEntries: statsBefore.expiredEntries,
      },
      statsAfter: {
        totalEntries: statsAfter.totalEntries,
        validEntries: statsAfter.validEntries,
        invalidatedEntries: statsAfter.invalidatedEntries,
        expiredEntries: statsAfter.expiredEntries,
      },
    }
  },
}
