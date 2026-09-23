// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { PDFDocument } from '@cantoo/pdf-lib'
import { extractFileMetadata } from '../utils/file-utils'
import { MAX_PDF_METADATA_BYTES, extractPdfMetadata } from './metadata'

/**
 * This parses caller-supplied bytes on the upload request path, so what is
 * worth pinning is not that pdf-lib counts pages (that is pdf-lib's job) but
 * that nothing a caller can send turns an upload into a failure or an unbounded
 * parse. Every case below is a hostile or malformed input except the first.
 */

async function makePdf(
  pages: number,
  info?: { title?: string; author?: string },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pages; i++) pdf.addPage()
  if (info?.title) pdf.setTitle(info.title)
  if (info?.author) pdf.setAuthor(info.author)
  return pdf.save()
}

describe('extractPdfMetadata', () => {
  it('reads page count and document properties from a real PDF', async () => {
    const bytes = await makePdf(3, { title: 'ASSY-100 Rev A', author: 'Ada' })

    const metadata = await extractPdfMetadata(bytes)

    expect(metadata).toMatchObject({
      pageCount: 3,
      title: 'ASSY-100 Rev A',
      author: 'Ada',
    })
  })

  it('resolves to null for bytes that are not a PDF, rather than throwing', async () => {
    await expect(
      extractPdfMetadata(Buffer.from('not a pdf, just some bytes')),
    ).resolves.toBeNull()
  })

  it('resolves to null for a truncated PDF, rather than throwing', async () => {
    const bytes = await makePdf(2)

    await expect(
      extractPdfMetadata(bytes.slice(0, Math.floor(bytes.length / 2))),
    ).resolves.toBeNull()
  })

  it('leaves a PDF over the size cap unparsed', async () => {
    const bytes = await makePdf(1)
    const oversized = Buffer.alloc(MAX_PDF_METADATA_BYTES + 1)
    oversized.set(bytes, 0)

    await expect(extractPdfMetadata(oversized)).resolves.toBeNull()
  })

  it('resolves to null for empty bytes', async () => {
    await expect(extractPdfMetadata(Buffer.alloc(0))).resolves.toBeNull()
  })
})

describe('extractFileMetadata with a PDF', () => {
  it('adds the PDF keys without displacing the base metadata', async () => {
    const bytes = await makePdf(2, { title: 'TDJ-25 Rev A' })

    const metadata = await extractFileMetadata(
      'TDJ-25-Rev-A.pdf',
      'application/pdf',
      Buffer.from(bytes),
    )

    expect(metadata).toMatchObject({
      extension: '.pdf',
      category: 'pdf',
      detectedCategory: 'reference',
      pageCount: 2,
      title: 'TDJ-25 Rev A',
    })
  })

  it('still returns the base metadata when the PDF cannot be parsed', async () => {
    const metadata = await extractFileMetadata(
      'TDJ-25-Rev-B.pdf',
      'application/pdf',
      Buffer.from('%PDF-1.7 and then garbage'),
    )

    expect(metadata).toMatchObject({
      extension: '.pdf',
      category: 'pdf',
      detectedCategory: 'reference',
    })
    expect(metadata.pageCount).toBeUndefined()
  })

  it('does not parse a non-PDF that claims application/pdf', async () => {
    const bytes = await makePdf(4)

    const metadata = await extractFileMetadata(
      'notes.txt',
      'application/pdf',
      Buffer.from(bytes),
    )

    expect(metadata.pageCount).toBeUndefined()
  })
})
