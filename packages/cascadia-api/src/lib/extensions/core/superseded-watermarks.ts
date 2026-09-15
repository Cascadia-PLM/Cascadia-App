// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { defineExtension } from '../registry'
import type { ConsumedExtension } from '../types'
import type { DesignReleasedPayload } from '@/lib/events'
import { DESIGN_RELEASED } from '@/lib/events'
import { FileService } from '@/lib/vault/services/FileService'
import { previewKindFor } from '@/lib/vault/preview'

export const SUPERSEDED_WATERMARK_EXTENSION_ID = 'core.superseded-watermarks'

export interface SupersededWatermarkOptions {
  /** Injectable so a test records the submission instead of queueing it. */
  submit?: (payload: {
    fileIds: Array<string>
    subtext: string | null
    reason: string
    userId: string
    itemId: string
    /** Makes the submission idempotent under at-least-once delivery. */
    dedupeKey: string
  }) => Promise<void>
}

/**
 * Stamp SUPERSEDED across the PDFs of every revision this release replaced.
 *
 * A superseded PDF stays downloadable forever — that is the point of a vault —
 * so the only thing stopping someone building to it is that the copy in their
 * hand says nothing about being out of date. Stamping it is what makes the
 * paper self-describing.
 *
 * **Formerly a post-commit `try`/`catch` in `mergeBranchToMain`**, with the
 * same three gains as its sibling: every release arm rather than the branch
 * merge alone, retry and catch-up instead of a lost stamp, and a parked state
 * instead of a swallowed warning.
 *
 * One job per superseded revision rather than one for the release: the stamp
 * names the revision that replaced it, which differs per item, and a per-item
 * job means a document whose attachments fail to stamp is retried without
 * re-stamping the rest.
 *
 * **Both fields this needs were added to the payload in stage 0, deliberately
 * and while the schema was still open** — `previousItemId` per item, because
 * files hang off an item *version* row so the ones to mark are exactly the ones
 * on the row being superseded; and `changeOrderLabel`, because the reason line
 * is human-facing text and reading the change order back at handling time
 * would render whatever it says *then* rather than what released.
 *
 * The file read runs on the consumer's `tx`, not the module-level connection:
 * a consumer run is a transaction, and a read outside it would be answering
 * from a different snapshot than the cursor it is about to advance.
 */
export function createSupersededWatermarkExtension(
  options: SupersededWatermarkOptions = {},
): ConsumedExtension<DesignReleasedPayload> {
  const submit =
    options.submit ??
    (async (payload) => {
      const { JobService } = await import('@/lib/jobs')
      await JobService.submit(
        'document.watermark.apply',
        {
          fileIds: payload.fileIds,
          text: 'SUPERSEDED',
          subtext: payload.subtext,
          position: 'diagonal',
          color: '#dc2626',
          opacity: 0.25,
          reason: payload.reason,
          userId: payload.userId,
        },
        payload.userId,
        { itemId: payload.itemId, dedupeKey: payload.dedupeKey },
      )
    })

  return {
    id: SUPERSEDED_WATERMARK_EXTENSION_ID,
    description:
      'Stamps SUPERSEDED on the PDFs of revisions a release replaced',
    phase: 'consumed',
    on: DESIGN_RELEASED,
    // Registered after the log shipped, so it starts at the head rather
    // than replaying every release still retained.
    startAt: 'head',
    handler: async ({ event, tx }) => {
      const userId = event.actorId
      if (!userId) return

      // A superseded revision is one this release replaced with a new row.
      // `previousItemId` is the predicate rather than the action, so the
      // branch-merge arm (action null) and the branchless `revise` arm are
      // treated identically — which is the parity the old dispatch never had.
      const superseded = event.payload.items.filter(
        (item) => item.changeType === 'modified' && item.previousItemId,
      )
      if (superseded.length === 0) return

      for (const item of superseded) {
        const previousItemId = item.previousItemId
        if (!previousItemId) continue

        const files = await FileService.listItemFiles(previousItemId, false, tx)
        const pdfIds = files
          .filter(
            (file) =>
              !file.deletedAt &&
              file.isLatestVersion &&
              !file.isCheckedOut &&
              previewKindFor(file.originalFileName) === 'pdf',
          )
          .map((file) => file.id)

        if (pdfIds.length === 0) continue

        await submit({
          // Event **and** item: one release supersedes many revisions, and two
          // jobs of one event are different work. Without the item the second
          // would deduplicate against the first and one document would go
          // unstamped — a worse failure than the duplicate this prevents.
          dedupeKey: `${SUPERSEDED_WATERMARK_EXTENSION_ID}:${event.id}:${previousItemId}`,
          fileIds: pdfIds,
          subtext: `Superseded by ${item.itemNumber} Rev ${item.newRevision}`,
          reason: `Superseded by the release of ${event.payload.changeOrderLabel}`,
          userId,
          itemId: previousItemId,
        })
      }
    },
  }
}

/** Register the watermark extension. Side-effect module — see `./register`. */
export function registerSupersededWatermarkExtension(
  options: SupersededWatermarkOptions = {},
): void {
  defineExtension(createSupersededWatermarkExtension(options))
}
