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
 */

export type PreviewKind = 'pdf' | 'image' | 'text'

export interface PreviewFormat {
  kind: PreviewKind
  /** Content-Type the server sends when serving these bytes inline. */
  contentType: string
}

/**
 * Content-Type per renderable image extension.
 *
 * The set of extensions is `image-files.ts`'s, not a second opinion: that
 * module already owns "can a browser render this image" for thumbnails and the
 * gallery, and two lists would drift. Only the mapping to a Content-Type lives
 * here, because only this module serves the bytes.
 *
 * SVG and TIFF are excluded there for the same reasons they matter here — SVG
 * is scriptable and these bytes are served inline from the app's own origin,
 * and TIFF has no browser support.
 */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
}

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

/**
 * Whether the Preview action should be offered for a file. Size is checked
 * here as well as server-side so the UI never opens a viewer onto a 415.
 */
export function isPreviewable(fileName: string, fileSize: number): boolean {
  return previewFormatFor(fileName) !== null && fileSize <= MAX_PREVIEW_BYTES
}
