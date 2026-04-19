import { SessionManager } from '../../auth/session'
import { FileService } from '../../vault/services/FileService'
import type { JobContext, JobHandler } from '../types'
import type {
  SessionCleanupPayload,
  SessionCleanupResult,
} from '../definitions/session-cleanup/types'

/**
 * Handler for expired session cleanup jobs.
 * Removes expired auth sessions and releases expired file checkout locks.
 */
export const sessionCleanupHandler: JobHandler<
  SessionCleanupPayload,
  SessionCleanupResult
> = {
  type: 'maintenance.session.cleanup',

  async execute(
    _payload: SessionCleanupPayload,
    context: JobContext,
  ): Promise<SessionCleanupResult> {
    await context.log.info('Starting expired session cleanup')

    if (context.signal.aborted) {
      throw new Error('Job was cancelled')
    }

    // Clean up expired auth sessions
    await context.updateProgress(10, 'Cleaning up expired sessions...')
    const expiredSessionsRemoved = await SessionManager.cleanupExpiredSessions()

    await context.log.info('Removed expired sessions', {
      expiredSessionsRemoved,
    })

    if (context.signal.aborted) {
      throw new Error('Job was cancelled')
    }

    // Clean up expired file checkout locks
    await context.updateProgress(60, 'Releasing expired file locks...')
    const expiredCheckoutsReleased = await FileService.cleanupExpiredCheckouts()

    await context.log.info('Released expired file checkouts', {
      expiredCheckoutsReleased,
    })

    await context.updateProgress(100, 'Cleanup complete')

    return {
      expiredSessionsRemoved,
      expiredCheckoutsReleased,
    }
  },
}
