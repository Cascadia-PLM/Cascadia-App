// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { JobContext, JobHandler } from '../types'
import type {
  WatermarkPdfPayload,
  WatermarkPdfResult,
} from '../definitions/watermark/types'

/**
 * Stamp a mark onto PDF attachments, one new file version per file.
 *
 * Per-file failures are collected rather than thrown: one vendor PDF that
 * pdf-lib cannot parse must not stop the other forty from being marked
 * superseded, and a retry of the whole batch would re-stamp the ones that
 * already succeeded.
 */
export const watermarkPdfHandler: JobHandler<
  WatermarkPdfPayload,
  WatermarkPdfResult
> = {
  type: 'document.watermark.apply',

  async execute(
    payload: WatermarkPdfPayload,
    context: JobContext,
  ): Promise<WatermarkPdfResult> {
    // Dynamic imports keep the dispatch-side bundle free of pdf-lib and the
    // vault service, matching the other Node handlers.
    const { FileService } = await import('@/lib/vault/services/FileService')
    const { applyWatermark } = await import('@/lib/vault/pdf/watermark')
    const { previewKindFor } = await import('@/lib/vault/preview')

    await context.log.info('Starting watermark job', {
      fileCount: payload.fileIds.length,
      text: payload.text,
    })

    const skipped: WatermarkPdfResult['skipped'] = []
    const failed: WatermarkPdfResult['failed'] = []
    let filesStamped = 0
    let pagesStamped = 0

    for (const [index, fileId] of payload.fileIds.entries()) {
      if (context.signal.aborted) throw new Error('Job cancelled')

      await context.updateProgress(
        Math.round((index / payload.fileIds.length) * 100),
        `Stamping ${index + 1} of ${payload.fileIds.length}`,
      )

      try {
        const file = await FileService.getFileMetadata(fileId)

        if (!file || file.deletedAt) {
          skipped.push({ fileId, reason: 'File no longer exists' })
          continue
        }
        if (previewKindFor(file.originalFileName) !== 'pdf') {
          skipped.push({ fileId, reason: 'Not a PDF' })
          continue
        }
        if (!file.isLatestVersion) {
          skipped.push({ fileId, reason: 'Superseded file version' })
          continue
        }
        // Someone is mid-edit. Their check-in would discard our stamp, so
        // leave it alone and say so rather than racing them.
        if (file.isCheckedOut) {
          skipped.push({ fileId, reason: 'Checked out for editing' })
          continue
        }
        // Re-running a release, or a retry that got further than it reported,
        // must not stack a second identical stamp on the page.
        if (alreadyStamped(file.metadata, payload.text)) {
          skipped.push({ fileId, reason: 'Already carries this mark' })
          continue
        }

        const original = await FileService.downloadFile(
          fileId,
          payload.userId,
          'view',
        )

        const { bytes, pagesStamped: pages } = await applyWatermark(original, {
          text: payload.text,
          subtext: payload.subtext ?? null,
          position: payload.position,
          color: payload.color,
          opacity: payload.opacity,
        })

        await FileService.replaceContent({
          fileId,
          data: Buffer.from(bytes),
          userId: payload.userId,
          action: 'watermark',
          details: {
            text: payload.text,
            subtext: payload.subtext ?? null,
            position: payload.position,
            reason: payload.reason ?? null,
            pagesStamped: pages,
          },
        })

        filesStamped += 1
        pagesStamped += pages
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await context.log.warn('Failed to stamp file', { fileId, message })
        failed.push({ fileId, error: message })
      }
    }

    await context.updateProgress(100, 'Watermarking complete')
    await context.log.info('Watermark job complete', {
      filesStamped,
      pagesStamped,
      skipped: skipped.length,
      failed: failed.length,
    })

    return { filesStamped, pagesStamped, skipped, failed }
  },
}

/**
 * `replaceContent` records each machine rewrite under its action name in the
 * file's metadata, so the presence of a matching watermark entry is what makes
 * this job idempotent across retries.
 */
function alreadyStamped(metadata: unknown, text: string): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false
  const stamp = (metadata as Record<string, unknown>).watermark
  if (typeof stamp !== 'object' || stamp === null) return false
  return (stamp as Record<string, unknown>).text === text
}
