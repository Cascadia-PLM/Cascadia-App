// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * What a drop or paste onto a create form carries that enrichment can use:
 * an http(s) link, image files, or both. The drop handlers and the paste
 * handler read the same `DataTransfer` shape, so they share this.
 */

export interface EnrichmentSources {
  /** An http(s) link from the transfer, or null when there is none to send. */
  url: string | null
  /** The raw text the transfer carried, when it was not a usable link. */
  text: string | null
  /** Image files, in transfer order. */
  images: Array<File>
  /** Files that were not images, so the caller can say they were skipped. */
  skippedFiles: number
}

const LINK_TYPES = ['text/uri-list', 'text/plain']

/** Whether a drag carries anything enrichment could read: files, or a link/text. */
export function transferHasSources(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return (
    types.includes('Files') || LINK_TYPES.some((type) => types.includes(type))
  )
}

/**
 * Anything the browser can decode goes: the file is re-encoded before it is
 * sent, so the server's media-type list does not bind here. SVG is left out —
 * it is scriptable, and a vector drawing is rarely what a spec sheet is.
 */
function isReadableImage(file: File): boolean {
  const type = file.type.toLowerCase()
  return type.startsWith('image/') && !type.includes('svg')
}

/** Read a finished drop or paste. During a drag the file list is empty by design. */
export function readTransferSources(
  dataTransfer: DataTransfer,
): EnrichmentSources {
  const files = Array.from(dataTransfer.files)
  const images = files.filter(isReadableImage)

  // With an image in hand the link is at best that image's own address (a
  // drag out of another tab carries both): read the file and skip the fetch.
  if (images.length > 0) {
    return {
      url: null,
      text: null,
      images,
      skippedFiles: files.length - images.length,
    }
  }

  const text = extractText(dataTransfer)
  return {
    url: text && isHttpUrl(text) ? text : null,
    text,
    images: [],
    skippedFiles: files.length,
  }
}

/** The first non-comment line of a uri-list, else the plain text, else null. */
function extractText(dataTransfer: DataTransfer): string | null {
  const uriList = dataTransfer.getData('text/uri-list')
  if (uriList) {
    const firstUrl = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'))
    if (firstUrl) return firstUrl
  }
  const text = dataTransfer.getData('text/plain').trim()
  return text.length > 0 ? text : null
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
