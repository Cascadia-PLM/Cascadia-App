// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

export const approvalVotedPayloadSchema = z.object({
  voteId: z.string().uuid(),
  instanceId: z.string().uuid(),
  /** The item the lifecycle runs on (for ECOs, the change order item). */
  itemId: z.string().uuid(),
  stateId: z.string(),
  vote: z.enum(['approved', 'rejected']),
  roleId: z.string().uuid().nullable(),
  roleName: z.string().nullable(),
  comments: z.string().nullable(),
})

export type ApprovalVotedPayload = z.infer<typeof approvalVotedPayloadSchema>

/**
 * An approver voted on a lifecycle state. Emitted in the vote's own
 * transaction — the same one advanced-auditing writes its signature in — so
 * the vote, its signature and this fact commit together. `actorId` is the
 * voter.
 */
export const APPROVAL_VOTED = defineDomainEvent({
  type: 'approval.voted',
  schemaVersion: 1,
  description: 'An approver voted on a lifecycle state',
  subjectType: 'item',
  payloadSchema: approvalVotedPayloadSchema,
})
