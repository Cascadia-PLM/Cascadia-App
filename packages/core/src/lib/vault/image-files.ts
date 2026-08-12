// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which vault files a browser can render inline as an image. Shared by the
 * server (thumbnail designation) and the client (the thumbnail button and the
 * item image gallery), so the UI offers exactly what the server accepts.
 *
 * Deliberately free of Node imports so client bundles can import it —
 * `utils/file-utils.ts` pulls in `node:crypto` and `node:path` and is not a
 * safe home for anything the UI needs.
 */

/**
 * Image extensions rendered inline. SVG is excluded — it is scriptable, and
 * these files are served from the vault. TIFF is excluded — browsers do not
 * render it.
 */
export const DISPLAYABLE_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
] as const

/** Extension of a file name, lowercased, `''` when there is none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  // `dot <= 0` covers both "no extension" and dotfiles like ".png"
  return dot <= 0 ? '' : fileName.slice(dot).toLowerCase()
}

/** Whether a file can be shown in an `<img>` — gallery entry, thumbnail. */
export function isDisplayableImage(
  fileName: string,
  mimeType: string,
): boolean {
  const ext = extensionOf(fileName)
  if ((DISPLAYABLE_IMAGE_EXTENSIONS as ReadonlyArray<string>).includes(ext)) {
    return true
  }
  // Fall back to MIME type for extensionless or oddly-named uploads
  const mime = mimeType.toLowerCase()
  return (
    mime.startsWith('image/') && !mime.includes('svg') && !mime.includes('tiff')
  )
}
