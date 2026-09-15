// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { JobContext, JobHandler } from '../types'
import type {
  NotificationResult,
  WorkflowTransitionPayload,
} from '../definitions/notification/types'

/**
 * Handler for workflow transition notification jobs.
 *
 * Email delivery is not yet integrated (no SMTP/provider is configured), so
 * this handler records every recipient as skipped rather than claiming
 * delivery. When an email service is wired in, replace the skip below with a
 * real send per recipient and count into emailsSent/emailsFailed.
 */
export const workflowTransitionHandler: JobHandler<
  WorkflowTransitionPayload,
  NotificationResult
> = {
  type: 'notification.workflow.transition',

  async execute(
    payload: WorkflowTransitionPayload,
    context: JobContext,
  ): Promise<NotificationResult> {
    const { recipients, itemNumber, fromState, toState } = payload

    await context.log.warn(
      `Email delivery is not configured — skipping ${recipients.length} notification(s) for ${itemNumber} (${fromState} → ${toState})`,
      { recipients: recipients.map((r) => r.email) },
    )

    return {
      emailsSent: 0,
      emailsFailed: 0,
      emailsSkipped: recipients.length,
      failedRecipients: [],
    }
  },
}
