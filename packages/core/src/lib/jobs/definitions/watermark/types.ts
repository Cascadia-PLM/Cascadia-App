// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { WATERMARK_POSITIONS } from '@/lib/vault/pdf/watermark'

/**
 * Stamp a mark onto PDF attachments.
 *
 * Runs as a job rather than inline because an ECO release can supersede dozens
 * of documents at once, each with several attachments, and rewriting all of
 * them must not sit inside the release transaction — a stamping failure has to
 * be retried, not roll back the release.
 */
export const watermarkPdfPayloadSchema = z.object({
  /**
   * Files to stamp. Resolved by the caller rather than derived here so the job
   * has no opinion about *why* these files were chosen, and the same job type
   * serves the ECO supersede hook and a manual "stamp this file" action.
   */
  fileIds: z.array(z.string().uuid()).min(1).max(500),
  text: z.string().min(1).max(120),
  subtext: z.string().max(200).nullable().optional(),
  position: z.enum(WATERMARK_POSITIONS).default('diagonal'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#dc2626'),
  opacity: z.number().min(0.05).max(1).default(0.25),
  /** Recorded in the file history so the stamp is attributable. */
  reason: z.string().max(200).optional(),
  /** Whose name the new file version is checked in under. */
  userId: z.string().uuid(),
})

export type WatermarkPdfPayload = z.infer<typeof watermarkPdfPayloadSchema>

export const watermarkPdfResultSchema = z.object({
  filesStamped: z.number(),
  pagesStamped: z.number(),
  /** Files skipped because they are not PDFs, or already carry this mark. */
  skipped: z.array(z.object({ fileId: z.string(), reason: z.string() })),
  failed: z.array(z.object({ fileId: z.string(), error: z.string() })),
})

export type WatermarkPdfResult = z.infer<typeof watermarkPdfResultSchema>
