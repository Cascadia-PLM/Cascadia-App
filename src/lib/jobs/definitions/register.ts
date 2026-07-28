/**
 * Register all job type definitions (configs + schemas).
 *
 * This file registers job type configurations used by the dispatch side
 * (main app for submission and validation). It does NOT register handler
 * implementations — those are registered by each worker independently.
 *
 * Import this file anywhere job type metadata is needed (e.g., JobService).
 */

import { JobTypeRegistry } from '../registry'

// Notification jobs
import { workflowTransitionNotificationConfig } from './notification/config'

// Design jobs
import { cloneDesignConfig } from './design/config'

// Maintenance jobs
import { cacheCleanupConfig } from './cache-cleanup/config'
import { sessionCleanupConfig } from './session-cleanup/config'

// Work instruction jobs
import { wiPartChangedConfig } from './workinstruction/config'

// CAD conversion jobs (Python worker)
import { cadConversionConfig } from './conversion/config'
import { jobLogger } from '@/lib/logging/logger'

// Register all job type definitions
JobTypeRegistry.register(workflowTransitionNotificationConfig)
JobTypeRegistry.register(cloneDesignConfig)
JobTypeRegistry.register(cacheCleanupConfig)
JobTypeRegistry.register(sessionCleanupConfig)
JobTypeRegistry.register(wiPartChangedConfig)
JobTypeRegistry.register(cadConversionConfig)

// Mark registry definitions as loaded
JobTypeRegistry.markInitialized()

jobLogger.info(
  JobTypeRegistry.getStats(),
  'Registered all job type definitions',
)
