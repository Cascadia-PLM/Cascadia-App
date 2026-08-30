// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { PDFDocument } from '@cantoo/pdf-lib'

/**
 * Reading the document properties out of a PDF attachment.
 *
 * Uses `@cantoo/pdf-lib`, already a dependency and already parsing PDFs inside
 * core for `./watermark.ts`. Nothing new is taken on for this: the alternatives
 * the original TODO named (`pdf-parse`) would be a second PDF stack, and core
 * is the published AGPL package — a dependency added here is one every
 * community-edition install carries.
 *
 * This runs on the upload request path against bytes a caller chose, so it is
 * shaped defensively rather than thoroughly:
 *
 * - **Bounded.** Uploads are accepted to 100 MB (`FileService.uploadFile`), and
 *   pdf-lib parses the whole document in memory on the event loop. Anything
 *   over {@link MAX_PDF_METADATA_BYTES} is left unread rather than parsed.
 * - **Silent on failure.** A PDF pdf-lib cannot read is still a legitimate
 *   attachment. Every parse error resolves to `null`, so the file lands with
 *   the metadata it would have had before this existed.
 * - **Trimmed.** Info-dictionary strings come from whoever produced the file
 *   and are stored in an untyped JSONB column, so they are capped before they
 *   get there.
 */

/**
 * Largest PDF this will open. Well past a normal drawing set or specification;
 * short of the 100 MB upload ceiling, where a synchronous parse would be felt.
 */
export const MAX_PDF_METADATA_BYTES = 32 * 1024 * 1024

/** Info-dictionary strings are producer-controlled; cap what reaches JSONB. */
const MAX_STRING_LENGTH = 200

export interface PdfMetadata {
  pageCount?: number
  title?: string
  author?: string
  pdfProducer?: string
}

/**
 * Read page count and document properties from PDF bytes.
 *
 * Returns `null` — never throws — when the bytes are too large to parse, are
 * not a PDF, or are a PDF pdf-lib cannot make sense of.
 */
export async function extractPdfMetadata(
  bytes: Uint8Array,
): Promise<PdfMetadata | null> {
  if (bytes.length === 0 || bytes.length > MAX_PDF_METADATA_BYTES) return null

  try {
    const pdf = await PDFDocument.load(bytes, {
      // Same reasoning as watermark.ts: vendor exports routinely carry an owner
      // password with no user password. They open in any reader, and reading
      // their page count is not a circumvention of anything.
      ignoreEncryption: true,
      updateMetadata: false,
    })

    const metadata: PdfMetadata = { pageCount: pdf.getPageCount() }

    const title = clean(pdf.getTitle())
    if (title) metadata.title = title

    const author = clean(pdf.getAuthor())
    if (author) metadata.author = author

    const producer = clean(pdf.getProducer())
    if (producer) metadata.pdfProducer = producer

    return metadata
  } catch {
    return null
  }
}

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_STRING_LENGTH) : undefined
}
