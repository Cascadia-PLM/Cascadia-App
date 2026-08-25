// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `SvgViewer` source-labelling tests.
 *
 * An SVG is the only previewable format that can carry script, and three
 * things keep that harmless: the server serves it as `text/plain`
 * (`preview.test.ts` pins that), the viewer renders it through an `<img>`, and
 * the `<img>`'s source is a `data:` URL rather than an object URL.
 *
 * This file pins the third. It reads like a rendering detail and is not one:
 * `URL.createObjectURL` mints a `blob:` URL carrying this app's origin, so
 * "simplifying" this viewer to match the plain-image case would put a live
 * same-origin document one "open image in new tab" away from every uploaded
 * drawing. The `<img>` boundary is pinned alongside it, since inlining the
 * markup instead would execute the script outright.
 *
 * Run: npx vitest run packages/core/src/components/vault/SvgViewer.test.tsx
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SvgViewer } from './SvgViewer'

/** An SVG that reports whether it was ever given a scripting context. */
const HOSTILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <script>globalThis.__pwned = true</script>
  <text x="0" y="5">héllo · 世界</text>
</svg>`

function renderViewer(source = HOSTILE_SVG) {
  render(<SvgViewer source={source} fileName="drawing.svg" />)
  const image = screen.getByRole('img')
  return { image, src: image.getAttribute('src') ?? '' }
}

describe('SvgViewer source labelling', () => {
  it('renders through an <img> and never inlines the markup', () => {
    const { image } = renderViewer()

    expect(image.tagName).toBe('IMG')
    // None of the drawing's own markup is parsed into the tree — `<svg>` in
    // the document is live, `<svg>` behind an `<img>` is secure static mode.
    // Matched by shape rather than by tag: the toolbar's icons are `<svg>`
    // elements too, so a bare `querySelector('svg')` proves nothing.
    expect(document.querySelector('svg[viewBox="0 0 10 10"]')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('text')).toBeNull()
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined()
  })

  it('sources the image from a data: URL, never an object URL', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')

    const { src } = renderViewer()

    expect(src.startsWith('data:image/svg+xml')).toBe(true)
    expect(src.startsWith('blob:')).toBe(false)
    expect(createObjectURL).not.toHaveBeenCalled()

    createObjectURL.mockRestore()
  })

  it('survives source outside Latin-1, which base64 encoding would not', () => {
    // `btoa` throws on any code point above U+00FF, and a drawing with an
    // accented or CJK <text> element is entirely ordinary.
    const { src } = renderViewer()

    expect(decodeURIComponent(src.split(',')[1] ?? '')).toContain(
      'héllo · 世界',
    )
  })
})
