// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Bounds shared by the enrichment endpoint and the create forms that call it.
 *
 * Free of server imports so the browser bundle can count and size images
 * against the same numbers the server enforces, rather than a copy of them.
 */

/**
 * Image types the extraction accepts: what the vision providers take, minus
 * SVG (scriptable) and TIFF/BMP (bulky, and the browser re-encodes a dropped
 * one before it gets here anyway).
 */
export const ENRICHMENT_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

export type EnrichmentImageMediaType =
  (typeof ENRICHMENT_IMAGE_MEDIA_TYPES)[number]

/** Images one request may carry. */
export const MAX_ENRICHMENT_IMAGES = 4

/** Decoded bytes per image. */
export const MAX_ENRICHMENT_IMAGE_BYTES = 4 * 1024 * 1024

/** Base64 length that decodes to at most `MAX_ENRICHMENT_IMAGE_BYTES`. */
export const MAX_ENRICHMENT_IMAGE_BASE64_CHARS =
  Math.ceil(MAX_ENRICHMENT_IMAGE_BYTES / 3) * 4

/** One image as the endpoint receives it. */
export interface EnrichmentImage {
  mediaType: EnrichmentImageMediaType
  /** Base64 payload with no `data:` prefix. */
  data: string
}
