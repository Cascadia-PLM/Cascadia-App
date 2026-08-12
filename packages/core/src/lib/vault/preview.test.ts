// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  MAX_PREVIEW_BYTES,
  isPreviewable,
  previewFormatFor,
  previewKindFor,
} from './preview'

/**
 * These are security invariants, not formatting preferences: the preview
 * endpoint serves these bytes inline from the app's own origin, and this
 * module is the only thing standing between an uploaded file and the browser
 * treating it as a document.
 */
describe('vault preview allowlist', () => {
  it('never previews a scriptable or active format', () => {
    const dangerous = [
      'payload.html',
      'payload.htm',
      'payload.svg',
      'payload.xhtml',
      'payload.xml',
      'payload.js',
      'payload.mjs',
      'payload.pdf.html',
      'payload.swf',
    ]

    for (const fileName of dangerous) {
      expect(previewFormatFor(fileName)).toBeNull()
    }
  })

  it('serves a fixed Content-Type rather than echoing the upload', () => {
    // The stored mimeType is caller-supplied; the served one never is.
    expect(previewFormatFor('drawing.pdf')?.contentType).toBe('application/pdf')
    expect(previewFormatFor('photo.JPG')?.contentType).toBe('image/jpeg')
    // Text of every flavour is served as plain text so nothing is sniffed
    // as markup.
    expect(previewFormatFor('readme.md')?.contentType).toBe(
      'text/plain; charset=utf-8',
    )
    expect(previewFormatFor('bom.csv')?.contentType).toBe(
      'text/plain; charset=utf-8',
    )
  })

  it('decides on the extension, and only on a real one', () => {
    expect(previewKindFor('spec.pdf')).toBe('pdf')
    expect(previewKindFor('SPEC.PDF')).toBe('pdf')
    // A dot that is not an extension separator must not be read as one.
    expect(previewKindFor('README')).toBeNull()
    expect(previewKindFor('.pdf')).toBeNull()
    expect(previewKindFor('archive.pdf.zip')).toBeNull()
    expect(previewKindFor('trailing.')).toBeNull()
  })

  it('refuses to preview past the size ceiling', () => {
    expect(isPreviewable('spec.pdf', MAX_PREVIEW_BYTES)).toBe(true)
    expect(isPreviewable('spec.pdf', MAX_PREVIEW_BYTES + 1)).toBe(false)
    // An allowlisted extension is necessary but not sufficient, and a
    // disallowed one stays disallowed at any size.
    expect(isPreviewable('payload.html', 1)).toBe(false)
  })
})
