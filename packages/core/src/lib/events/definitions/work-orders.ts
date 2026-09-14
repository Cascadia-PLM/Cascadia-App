// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

/**
 * Which work order, which traveler line, which run.
 *
 * The work order's master id rides along for the same reason both ends of a
 * structure edge carry one: the item row is a version, and a consumer tracking
 * a work order across its life needs the identity rather than the revision.
 */
const runIdentity = {
  workOrderId: z.string().uuid(),
  workOrderMasterId: z.string().uuid(),
  workOrderNumber: z.string(),
  /** The traveler line — a frozen snapshot of one work instruction. */
  lineId: z.string().uuid(),
  executionId: z.string().uuid(),
}

export const workOrderRunCompletedPayloadSchema = z
  .object({
    ...runIdentity,
    /**
     * Whether this run counts toward the line's required tally.
     *
     * A **flag, not the status string**. Completion routes to a
     * pending-approval state or a complete state purely by the work order's
     * sign-off requirement, and a consumer keying on the enum would have to know
     * which of six literals are countable — and would silently break the day a
     * seventh is added. The execution status union is closed in code today; this
     * is what keeps a consumer correct when it grows.
     */
    countsTowardRequired: z.boolean(),
    /** Whether the run now awaits a sign-off rather than being finished. */
    requiresSignOff: z.boolean(),
    /**
     * When the run started, and how long it took in seconds. Carried so the
     * event is self-sufficient for cycle time — which is also why run *start*
     * is not its own event type.
     */
    startedAt: z.string(),
    durationSeconds: z.number().int(),
  })
  .strict()

export type WorkOrderRunCompletedPayload = z.infer<
  typeof workOrderRunCompletedPayloadSchema
>

/**
 * A traveler run finished.
 *
 * One of two work-order facts, not four, and the pair was chosen by what
 * changes what the system will allow next: a line's tally against its required
 * count, and the work-order completion gate.
 *
 * **Run start is deliberately absent.** The start method has a resume path and
 * a race-winner path that both return an existing row, so "started" is not a
 * fact that site can state unambiguously without new bookkeeping — and carrying
 * the start time and duration here makes this event self-sufficient for cycle
 * time anyway.
 *
 * **Abandonment is deliberately absent too**: an incomplete record is telemetry
 * nothing acts on, and the work-order identity is not even in scope at that
 * site.
 */
export const WORK_ORDER_RUN_COMPLETED = defineDomainEvent({
  type: 'work_order.run_completed',
  schemaVersion: 1,
  description: 'A traveler run finished, countable or awaiting sign-off',
  subjectType: 'item',
  payloadSchema: workOrderRunCompletedPayloadSchema,
})

export const workOrderSignOffSubmittedPayloadSchema = z
  .object({
    ...runIdentity,
    /** Approved or rejected — the reviewer's decision, not a derived status. */
    decision: z.enum(['approved', 'rejected']),
    reviewerId: z.string().uuid(),
    comments: z.string().nullable(),
    /** Whether the run now counts toward the line's required tally. */
    countsTowardRequired: z.boolean(),
  })
  .strict()

export type WorkOrderSignOffSubmittedPayload = z.infer<
  typeof workOrderSignOffSubmittedPayloadSchema
>

/**
 * A reviewer signed off on a traveler run, or rejected it.
 *
 * Emitted in the transaction that writes both the sign-off row and the run's
 * new status, so the decision and its consequence commit together.
 */
export const WORK_ORDER_SIGN_OFF_SUBMITTED = defineDomainEvent({
  type: 'work_order.sign_off_submitted',
  schemaVersion: 1,
  description: 'A traveler run was approved or rejected by a reviewer',
  subjectType: 'item',
  payloadSchema: workOrderSignOffSubmittedPayloadSchema,
})
