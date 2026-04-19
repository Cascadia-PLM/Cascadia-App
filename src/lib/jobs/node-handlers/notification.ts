import type { JobContext, JobHandler } from '../types'
import type {
  NotificationResult,
  WorkflowTransitionPayload,
} from '../definitions/notification/types'
import { jobLogger } from '@/lib/logging/logger'

/**
 * Handler for workflow transition notification jobs.
 * Sends email notifications to recipients when an item transitions state.
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
    const {
      recipients,
      itemNumber,
      itemType,
      fromState,
      toState,
      transitionName,
      actorName,
    } = payload

    await context.log.info(`Sending workflow notification for ${itemNumber}`, {
      recipientCount: recipients.length,
      transition: `${fromState} → ${toState}`,
    })

    let emailsSent = 0
    let emailsFailed = 0
    const failedRecipients: Array<{ email: string; error: string }> = []

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i]

      // Check for cancellation
      if (context.signal.aborted) {
        throw new Error('Job was cancelled')
      }

      // Update progress
      const progress = Math.round(((i + 1) / recipients.length) * 100)
      await context.updateProgress(
        progress,
        `Sending ${i + 1}/${recipients.length}`,
      )

      try {
        // TODO: Integrate with actual email service
        // For now, we just log and simulate success
        await sendEmail({
          to: recipient.email,
          subject: `[Cascadia] ${itemType} ${itemNumber} - ${transitionName}`,
          recipientName: recipient.name,
          itemNumber,
          itemType,
          fromState,
          toState,
          transitionName,
          actorName,
          comments: payload.comments,
          changeOrderNumber: payload.changeOrderNumber,
          itemUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/items/${payload.itemId}`,
        })

        emailsSent++
        await context.log.debug(`Email sent to ${recipient.email}`)
      } catch (error) {
        emailsFailed++
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error'
        failedRecipients.push({ email: recipient.email, error: errorMessage })
        await context.log.warn(`Failed to send email to ${recipient.email}`, {
          error: errorMessage,
        })
      }
    }

    await context.log.info('Notification job completed', {
      emailsSent,
      emailsFailed,
    })

    return {
      emailsSent,
      emailsFailed,
      failedRecipients,
    }
  },
}

// ============================================================================
// Email Sending (placeholder implementation)
// ============================================================================

interface EmailData {
  to: string
  subject: string
  recipientName: string
  itemNumber: string
  itemType: string
  fromState: string
  toState: string
  transitionName: string
  actorName: string
  comments?: string
  changeOrderNumber?: string
  itemUrl: string
}

/**
 * Send an email notification.
 * TODO: Replace with actual email service (e.g., nodemailer, Resend, SendGrid)
 */
async function sendEmail(data: EmailData): Promise<void> {
  // Simulate email sending delay
  await new Promise((resolve) => setTimeout(resolve, 100))

  // Log the email that would be sent
  jobLogger.info(
    { to: data.to, subject: data.subject, itemNumber: data.itemNumber },
    'Would send email',
  )

  // In production, integrate with an email service here
  // Example with nodemailer:
  // await transporter.sendMail({
  //   from: 'Cascadia PLM <noreply@cascadia.example.com>',
  //   to: data.to,
  //   subject: data.subject,
  //   html: renderEmailTemplate('workflow-transition', data),
  // })
}
