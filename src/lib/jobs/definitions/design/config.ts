import { cloneDesignPayloadSchema, cloneDesignResultSchema } from './types'
import type { CloneDesignPayload, CloneDesignResult } from './types'
import type { JobTypeConfig } from '../../types'

/**
 * Configuration for clone design job
 */
export const cloneDesignConfig: JobTypeConfig<
  CloneDesignPayload,
  CloneDesignResult
> = {
  type: 'design.clone',
  label: 'Clone Design',
  routingKey: 'jobs.design.clone',

  payloadSchema: cloneDesignPayloadSchema,
  resultSchema: cloneDesignResultSchema,

  timeout: 300000, // 5 minutes (large designs may have many items)
  maxAttempts: 2, // Limited retries - cloning is complex
  retryDelays: [60000, 120000], // 1min, 2min
  priority: 'high', // User is waiting for result
}
