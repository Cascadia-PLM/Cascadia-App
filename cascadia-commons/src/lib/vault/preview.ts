// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { DISPLAYABLE_IMAGE_EXTENSIONS } from './image-files'

/**
 * Which attached files Cascadia renders in-app, and as what.
 *
 * Shared by the server (the inline-content endpoint's allowlist) and the client
 * (deciding whether to offer a Preview action, and which viewer to mount).
 * Deliberately free of Node and database imports so client bundles can import
 * it — the same constraint `file-categories.ts` documents.
 *
 * Previewability is decided by **file extension, never by the stored
 * `mimeType`**: the mime type is whatever the browser asserted at upload time
 * and is therefore caller-controlled, while the extension has already passed
 * the vault's upload allowlist in `src/lib/vault/utils/file-utils.ts`. The
 * server sends the `contentType` recorded here rather than echoing the stored
 * one, so an `.html` payload can never be replayed as inline markup.
 *
 * Note this is orthogonal to `fileCategory`. A PDF is categorized by what it
 * contains (`specification`, `reference`, ...) and is never asserted to be a
 * `drawing`; previewability only asks what the bytes are.
 *
 * ## SVG
 *
 * SVG is the one previewable format that is also a scripting host, so it is
 * handled unlike the rest. Three things keep it safe, and all three have to
 * hold:
 *
 * 1. **The server never labels it `image/svg+xml`.** These bytes go out as
 *    `text/plain` like any other text flavour, so a browser that reaches the
 *    endpoint directly — a pasted URL, a stray `window.open` — renders source,
 *    not markup. This is the same reason `.md` is not served as `text/markdown`.
 * 2. **The viewer renders it through an `<img>`**, which the SVG spec puts in
 *    secure static mode: no script, no external references, no interactivity.
 * 3. **The viewer's `src` is a `data:` URL, not an object URL** — see
 *    `SvgViewer.tsx`, which owns that reasoning.
 *
 * Removing any one of those three re-opens same-origin script execution, which
 * is why `preview.test.ts` pins the Content-Type as an invariant.
 */

export type PreviewKind = 'pdf' | 'image' | 'text' | 'svg'

export interface PreviewFormat {
  kind: PreviewKind
  /** Content-Type the server sends when serving these bytes inline. */
  contentType: string
  /**
   * Ceiling for this format, when it is lower than `MAX_PREVIEW_BYTES`.
   * Only formats the *viewer* cannot scale to 50 MB need one.
   */
  maxBytes?: number
}

/**
 * Content-Type per renderable image extension.
 *
 * The set of extensions is `image-files.ts`'s, not a second opinion: that
 * module already owns "can a browser render this image" for thumbnails and the
 * gallery, and two lists would drift. Only the mapping to a Content-Type lives
 * here, because only this module serves the bytes.
 *
 * SVG and TIFF are absent from that list and stay absent here. TIFF has no
 * browser support at all. SVG *is* previewable — but as its own kind, under
 * `text/plain`, never as an image under `image/svg+xml`; see the SVG section
 * of this file's header for why that distinction is the whole safety argument.
 */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
}

/**
 * Ceiling for SVG, well under the global one.
 *
 * The viewer hands the markup to an `<img>` as a percent-encoded `data:` URL,
 * which is roughly twice the size of the source and has to be built as a single
 * JavaScript string. A hand- or tool-authored drawing is a few hundred KB;
 * anything past this is a traced bitmap that would render badly anyway, so it
 * is offered as a download instead of freezing the tab.
 */
export const MAX_SVG_PREVIEW_BYTES = 8 * 1024 * 1024

const PREVIEW_FORMATS: Record<string, PreviewFormat> = {
  pdf: { kind: 'pdf', contentType: 'application/pdf' },
  ...Object.fromEntries(
    DISPLAYABLE_IMAGE_EXTENSIONS.map((extension) => [
      extension.slice(1),
      {
        kind: 'image',
        // Every entry in the shared list has a mapping; the fallback exists so
        // adding one there can never silently serve bytes as octet-stream.
        contentType:
          IMAGE_CONTENT_TYPES[extension] ?? 'application/octet-stream',
      } satisfies PreviewFormat,
    ]),
  ),
  // Served as text/plain regardless of flavour so nothing is ever sniffed as
  // markup. The viewer, not the Content-Type, decides how to present it.
  txt: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  md: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  csv: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  log: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  // Text/plain for the same reason as the flavours above, and here it is load
  // bearing rather than tidy: see the SVG section of this file's header.
  svg: {
    kind: 'svg',
    contentType: 'text/plain; charset=utf-8',
    maxBytes: MAX_SVG_PREVIEW_BYTES,
  },
}

/** Every extension the viewer can render, for error messages and docs. */
export const PREVIEWABLE_EXTENSIONS = Object.keys(PREVIEW_FORMATS)

/**
 * Ceiling on what the preview endpoint will serve.
 *
 * The viewer fetches a file whole — neither the storage layer nor the API
 * speaks HTTP Range yet — so this is the point past which previewing costs more
 * than downloading. Uploads are allowed up to 100 MB, so files above this cap
 * are still perfectly valid; they just have to be downloaded to be read.
 */
export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024

/** Lowercased extension without the dot, or `null` if the name carries none. */
function extensionOf(fileName: string): string | null {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === fileName.length - 1) return null
  return fileName.slice(lastDot + 1).toLowerCase()
}

/** How to serve and render this file, or `null` if Cascadia cannot preview it. */
export function previewFormatFor(fileName: string): PreviewFormat | null {
  const extension = extensionOf(fileName)
  if (extension === null) return null
  return PREVIEW_FORMATS[extension] ?? null
}

/** Which viewer this file needs, or `null` if it has none. */
export function previewKindFor(fileName: string): PreviewKind | null {
  return previewFormatFor(fileName)?.kind ?? null
}

/** The size ceiling that applies to a format — its own, or the global one. */
export function maxPreviewBytesFor(format: PreviewFormat): number {
  return Math.min(format.maxBytes ?? MAX_PREVIEW_BYTES, MAX_PREVIEW_BYTES)
}

/**
 * Whether the Preview action should be offered for a file. Size is checked
 * here as well as server-side so the UI never opens a viewer onto a 415.
 */
export function isPreviewable(fileName: string, fileSize: number): boolean {
  const format = previewFormatFor(fileName)
  return format !== null && fileSize <= maxPreviewBytesFor(format)
}
