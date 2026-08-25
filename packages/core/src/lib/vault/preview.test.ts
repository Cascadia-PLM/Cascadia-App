// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  MAX_PREVIEW_BYTES,
  MAX_SVG_PREVIEW_BYTES,
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

  it('never serves SVG under a type a browser would parse as markup', () => {
    // SVG is previewable, but only because it goes out as inert text and is
    // re-labelled client-side for an `<img>`. Serving it as `image/svg+xml`
    // from this origin would make every uploaded drawing a stored XSS, so the
    // Content-Type is pinned here rather than left to review.
    expect(previewFormatFor('drawing.svg')?.contentType).toBe(
      'text/plain; charset=utf-8',
    )
    expect(previewFormatFor('DRAWING.SVG')?.contentType).toBe(
      'text/plain; charset=utf-8',
    )
  })

  it('gives SVG its own kind rather than folding it in with images', () => {
    // A shared kind would route it to the plain `<img src={objectURL}>` the
    // image case uses, which is the one rendering path that leaves a
    // same-origin document reachable.
    expect(previewKindFor('drawing.svg')).toBe('svg')
    expect(previewKindFor('photo.png')).toBe('image')
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

  it('holds a format to its own ceiling when it declares a lower one', () => {
    // SVG is capped below the global limit because the viewer expands the
    // source into a data URL; a file between the two ceilings must be refused,
    // not silently offered and then hang the tab.
    expect(isPreviewable('drawing.svg', MAX_SVG_PREVIEW_BYTES)).toBe(true)
    expect(isPreviewable('drawing.svg', MAX_SVG_PREVIEW_BYTES + 1)).toBe(false)
    expect(isPreviewable('drawing.svg', MAX_PREVIEW_BYTES)).toBe(false)
    // ...while a format without one still gets the global ceiling.
    expect(isPreviewable('spec.pdf', MAX_SVG_PREVIEW_BYTES + 1)).toBe(true)
  })
})
