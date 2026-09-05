// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Server-side fetch of a dropped link for item enrichment.
 *
 * A link may point at a web page (a supplier listing, a spec sheet) or
 * straight at an image: a product photo dragged out of another browser tab
 * arrives as the image's own URL. Both are bounded reads, and both are
 * SSRF-guarded: the URL is checked before the first request and again at
 * every redirect, so a public hostname that bounces to an internal address
 * gets no further than `assertSafeUrl`.
 */

import { assertSafeUrl, extractText } from './html-to-text'
import {
  ENRICHMENT_IMAGE_MEDIA_TYPES,
  MAX_ENRICHMENT_IMAGE_BYTES,
} from './limits'
import type { FetchedPage } from './html-to-text'
import type { EnrichmentImage, EnrichmentImageMediaType } from './limits'
import { ValidationError } from '@/lib/errors'

/** Hard cap on the HTML we will read into memory; longer pages are truncated. */
const MAX_HTML_BYTES = 1_000_000
/** Per-hop fetch timeout — a hung page must not hang the request. */
const FETCH_TIMEOUT_MS = 8_000
/** Redirect hops followed before giving up. */
const MAX_REDIRECTS = 5

export type FetchedSource =
  | { kind: 'page'; page: FetchedPage }
  | { kind: 'image'; image: EnrichmentImage }

/**
 * Fetch a link and return either the page's extracted text or the image it
 * points at. Throws ValidationError for unreachable, blocked, oversized, or
 * unreadable targets.
 */
export async function fetchSource(rawUrl: string): Promise<FetchedSource> {
  const response = await fetchFollowingSafeRedirects(assertSafeUrl(rawUrl))

  if (!response.ok) {
    throw new ValidationError(
      `Could not fetch that link (HTTP ${response.status})`,
    )
  }

  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase()
  const declaredLength = Number(response.headers.get('content-length') ?? '0')

  const mediaType = imageMediaType(contentType)
  if (mediaType) {
    const tooLarge = 'That image is too large to read'
    if (declaredLength > MAX_ENRICHMENT_IMAGE_BYTES) {
      throw new ValidationError(tooLarge)
    }
    // A truncated image is garbage, so an over-long body is rejected rather
    // than cut — the declared length above is only what the server claimed.
    const bytes = await readBounded(response, MAX_ENRICHMENT_IMAGE_BYTES, {
      onOverflow: () => {
        throw new ValidationError(tooLarge)
      },
    })
    return {
      kind: 'image',
      image: { mediaType, data: bytes.toString('base64') },
    }
  }

  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    // A page past the cap is cut, not rejected: the useful text is near the
    // top and `extractText` bounds what reaches the model anyway.
    const bytes = await readBounded(response, MAX_HTML_BYTES, {
      onOverflow: () => undefined,
    })
    return { kind: 'page', page: extractText(bytes.toString('utf8')) }
  }

  throw new ValidationError('The link is not a web page or image we can read')
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  )
}

/**
 * `redirect: 'manual'` so each hop's target passes through `assertSafeUrl`
 * before it is fetched. With `'follow'` the runtime would chase a redirect to
 * a private address on its own — exactly the check the first request had
 * already enforced.
 */
async function fetchFollowingSafeRedirects(url: URL): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response
    try {
      response = await fetch(current, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
        headers: {
          'User-Agent': 'CascadiaPLM/1.0 (+link-enrichment)',
          Accept: 'text/html,application/xhtml+xml,image/*',
        },
      })
    } catch {
      throw new ValidationError('Could not reach that link')
    }

    const location = response.headers.get('location')
    if (!isRedirect(response.status) || !location) return response

    // The redirect body is not the answer; release it before the next hop.
    await response.body?.cancel()

    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw new ValidationError(
        'That link redirects somewhere we cannot follow',
      )
    }
    current = assertSafeUrl(next.href)
  }
  throw new ValidationError('That link redirects too many times')
}

/**
 * Read a response body up to `maxBytes`. On overflow the reader is cancelled
 * and `onOverflow` decides: throw to reject, or return to keep what was read.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
  options: { onOverflow: () => void },
): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)

  const chunks: Array<Uint8Array> = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total))
      await reader.cancel()
      options.onOverflow()
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  return Buffer.concat(chunks)
}

/** The accepted image media type for a Content-Type, or null when it is not one. */
function imageMediaType(contentType: string): EnrichmentImageMediaType | null {
  const normalized = contentType === 'image/jpg' ? 'image/jpeg' : contentType
  return (ENRICHMENT_IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(
    normalized,
  )
    ? (normalized as EnrichmentImageMediaType)
    : null
}
