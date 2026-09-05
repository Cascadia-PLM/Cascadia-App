// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Turn a dropped image file into the payload the enrichment endpoint takes.
 *
 * The file is decoded, scaled down to the vision providers' sweet spot, and
 * re-encoded as JPEG: a 12-megapixel phone photo of a nameplate is 4+ MB the
 * model would downscale anyway, and paying to upload it buys nothing. The
 * original file is untouched — it is what gets attached to the item.
 */

import type { EnrichmentImage } from '@/lib/items/enrichment/limits'
import { MAX_ENRICHMENT_IMAGE_BASE64_CHARS } from '@/lib/items/enrichment/limits'

/** Longest edge sent to the model, in pixels. */
export const AI_IMAGE_MAX_EDGE = 1568
const JPEG_QUALITY = 0.9

export async function prepareImageForAi(file: File): Promise<EnrichmentImage> {
  // `from-image` honours the EXIF rotation a phone camera writes, so a
  // nameplate photographed in portrait is not read sideways.
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  })
  try {
    const scale = Math.min(
      1,
      AI_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    )
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is unavailable')

    // JPEG has no alpha: a transparent PNG would otherwise come out black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if (data.length > MAX_ENRICHMENT_IMAGE_BASE64_CHARS) {
      throw new Error('The image is too large even after resizing')
    }
    return { mediaType: 'image/jpeg', data }
  } finally {
    bitmap.close()
  }
}
