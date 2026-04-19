import { z } from 'zod'

/**
 * Payload for workflow transition notification job
 */
export const workflowTransitionPayloadSchema = z.object({
  /** The item that transitioned */
  itemId: z.string().uuid(),
  itemNumber: z.string(),
  itemType: z.string(),

  /** Transition details */
  fromState: z.string(),
  toState: z.string(),
  transitionName: z.string(),

  /** Actor who triggered the transition */
  actorId: z.string().uuid(),
  actorName: z.string(),
  actorEmail: z.string().email(),

  /** Recipients to notify */
  recipients: z.array(
    z.object({
      userId: z.string().uuid(),
      email: z.string().email(),
      name: z.string(),
    }),
  ),

  /** Optional additional context */
  comments: z.string().optional(),
  changeOrderNumber: z.string().optional(),
})

export type WorkflowTransitionPayload = z.infer<
  typeof workflowTransitionPayloadSchema
>

/**
 * Result of workflow transition notification job
 */
export const notificationResultSchema = z.object({
  emailsSent: z.number(),
  emailsFailed: z.number(),
  failedRecipients: z.array(
    z.object({
      email: z.string(),
      error: z.string(),
    }),
  ),
})

export type NotificationResult = z.infer<typeof notificationResultSchema>
