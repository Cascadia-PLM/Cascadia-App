import {
  notificationResultSchema,
  workflowTransitionPayloadSchema,
} from './types'
import type { NotificationResult, WorkflowTransitionPayload } from './types'
import type { JobTypeConfig } from '../../types'

/**
 * Configuration for workflow transition notification job
 */
export const workflowTransitionNotificationConfig: JobTypeConfig<
  WorkflowTransitionPayload,
  NotificationResult
> = {
  type: 'notification.workflow.transition',
  label: 'Workflow Transition Notification',
  routingKey: 'jobs.notification.workflow',

  payloadSchema: workflowTransitionPayloadSchema,
  resultSchema: notificationResultSchema,

  timeout: 60000, // 1 minute
  maxAttempts: 3,
  retryDelays: [30000, 60000, 120000], // 30s, 1min, 2min
  priority: 'high', // User-facing notifications are high priority
}
