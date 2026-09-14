// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

/**
 * Every field optional, and that is load-bearing rather than lax.
 *
 * The maintenance sweep submits literally `JobService.submit(type, {}, null)`,
 * so a required field would throw a validation error the sweep catches and warns
 * about — and the job would silently never run, on every tick, forever.
 */
export const eventsPrunePayloadSchema = z.object({
  /** Retain events younger than this. Non-positive means retain forever. */
  retentionDays: z.number().optional(),
  /**
   * Retain webhook deliveries younger than this. Non-positive means forever.
   * Separate from `retentionDays` because a delivery log is far larger than the
   * event log it mirrors and is usually kept for less time.
   */
  deliveryRetentionDays: z.number().optional(),
  batchSize: z.number().int().positive().optional(),
  maxBatches: z.number().int().positive().optional(),
})
export type EventsPrunePayload = z.infer<typeof eventsPrunePayloadSchema>

export const eventsPruneResultSchema = z.object({
  deleted: z.number(),
  batches: z.number(),
  /** More remained than `maxBatches` allowed — the next run continues. */
  hasMore: z.boolean(),
  /** The retention floor this run used; null means no cursor constrained it. */
  horizonSeq: z.number().nullable(),
  /** The consumers whose cursors sit at that floor — what the log waits on. */
  pinnedBy: z.array(z.string()),
  /** Cursors excluded from the floor because they were parked too long. */
  abandoned: z.array(z.string()),
  /**
   * Committed rows with no seq — undelivered and invisible to every consumer.
   * Never pruned; reported so somebody can fix the missing trigger.
   */
  unsequenced: z.number(),
  /** True when retention is switched off and this run did nothing. */
  skipped: z.boolean(),
  /**
   * The webhook delivery log's half of the same run.
   *
   * One job rather than a second maintenance type: the two horizons are
   * unrelated — the event log's floor is the minimum consumer cursor, while a
   * delivery's fate is settled the moment it stops being pending — so they are
   * two functions behind one handler rather than two jobs with two sets of
   * scheduler-suite counts.
   */
  deliveries: z.object({
    deleted: z.number(),
    batches: z.number(),
    hasMore: z.boolean(),
    /** A deleted subscription's pending rows, expired: nothing would send them. */
    expired: z.number(),
    /**
     * Pending rows older than the cutoff that a live subscription is owed.
     * Never deleted; reported.
     */
    pendingSkipped: z.number(),
    /** True when delivery retention is switched off. */
    skipped: z.boolean(),
  }),
})
export type EventsPruneResult = z.infer<typeof eventsPruneResultSchema>
