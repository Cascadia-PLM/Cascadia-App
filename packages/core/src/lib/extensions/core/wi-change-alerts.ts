// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { defineExtension } from '../registry'
import type { ConsumedExtension } from '../types'
import type { DesignReleasedPayload } from '@/lib/events'
import { DESIGN_RELEASED } from '@/lib/events'

export const WI_CHANGE_ALERT_EXTENSION_ID = 'core.wi-change-alerts'

export interface WiChangeAlertOptions {
  /**
   * Injectable so a test can record the submission instead of queueing it.
   * A spy on `JobService.submit` would assert a call shape; this lets the
   * test assert what was submitted, which is the thing that matters.
   */
  submit?: (payload: {
    changeOrderId: string
    changedPartIds: Array<string>
    userId: string
    /** Makes the submission idempotent under at-least-once delivery. */
    dedupeKey: string
  }) => Promise<void>
}

/**
 * Tell work instructions that a part they reference has been released.
 *
 * **This used to be a post-commit `try`/`catch` at the end of
 * `mergeBranchToMain`**, and moving it is the whole point of the stage rather
 * than a tidy-up. What it gains by becoming a `consumed` extension:
 *
 * - **Every release arm.** The old dispatch sat inside the branch-merge path,
 *   so a change order that released through the branchless or state-only arm
 *   alerted nobody — and nothing recorded that an alert was owed. It now keys
 *   on the fact, and a fact that is not emitted is not a release.
 * - **Retry and catch-up.** A broker outage used to cost the alert; now it
 *   costs latency, because the cursor stops and resumes.
 * - **A parked state an operator can see**, instead of a warning line swallowed
 *   into the log.
 *
 * It loses nothing, because it was already best-effort by contract: the old
 * block caught its own failure and logged it precisely so a release would not
 * roll back on an alert.
 *
 * Only added and modified items are alertable. A deleted item is gone from
 * main, and a work instruction referencing it has a different problem than a
 * change alert.
 */
export function createWiChangeAlertExtension(
  options: WiChangeAlertOptions = {},
): ConsumedExtension<DesignReleasedPayload> {
  const submit =
    options.submit ??
    (async (payload) => {
      const { JobService } = await import('@/lib/jobs')
      const { dedupeKey, ...jobPayload } = payload
      await JobService.submit(
        'notification.workinstruction.partchanged',
        jobPayload,
        payload.userId,
        { dedupeKey },
      )
    })

  return {
    id: WI_CHANGE_ALERT_EXTENSION_ID,
    description:
      'Alerts work instructions when a part they reference is released',
    phase: 'consumed',
    on: DESIGN_RELEASED,
    // Registered after the log shipped, so it starts at the head rather
    // than replaying every release still retained.
    startAt: 'head',
    handler: async ({ event }) => {
      // Null would mean system-caused, which a release never is. Skipping is
      // the honest response: the job's payload wants a real user id, and an
      // invented one would put a broken reference into a queue rather than
      // surface the anomaly.
      const userId = event.actorId
      if (!userId) return

      const changedPartIds = event.payload.items
        .filter(
          (item) =>
            item.changeType === 'modified' || item.changeType === 'added',
        )
        .map((item) => item.masterId)

      if (changedPartIds.length === 0) return

      await submit({
        // One alert per release, so the event alone names the work.
        dedupeKey: `${WI_CHANGE_ALERT_EXTENSION_ID}:${event.id}`,
        changeOrderId: event.payload.changeOrderId,
        changedPartIds,
        userId,
      })
    },
  }
}

/** Register the alert extension. Side-effect module — see `./register`. */
export function registerWiChangeAlertExtension(
  options: WiChangeAlertOptions = {},
): void {
  defineExtension(createWiChangeAlertExtension(options))
}
