import {
  sessionCleanupPayloadSchema,
  sessionCleanupResultSchema,
} from './types'
import type { SessionCleanupPayload, SessionCleanupResult } from './types'
import type { JobTypeConfig } from '../../types'

/**
 * Configuration for expired session cleanup job.
 *
 * This job removes:
 * - Expired authentication sessions from the sessions table
 * - Expired file checkout locks (beyond MAX_FILE_CHECKOUT_HOURS)
 *
 * Recommended to run daily via a scheduler.
 */
export const sessionCleanupConfig: JobTypeConfig<
  SessionCleanupPayload,
  SessionCleanupResult
> = {
  type: 'maintenance.session.cleanup',
  label: 'Expired Session Cleanup',
  routingKey: 'jobs.maintenance.session',

  payloadSchema: sessionCleanupPayloadSchema,
  resultSchema: sessionCleanupResultSchema,

  timeout: 60000, // 1 minute
  maxAttempts: 3,
  retryDelays: [30000, 60000, 120000], // 30s, 1min, 2min
  priority: 'low',
}
