// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * URL safety check and HTML-to-text extraction for link-based item enrichment.
 *
 * Dependency-free: strips scripts/styles/tags, decodes common entities, and
 * bounds the output so it is safe to feed to an LLM. `assertSafeUrl` guards
 * against SSRF by rejecting non-http(s) URLs and hosts on the local / private
 * network; `fetch-source.ts` does the network side and applies it to every
 * redirect hop as well.
 */

import { ValidationError } from '@/lib/errors'

/** Hard cap on the extracted body text handed to the model. */
const MAX_TEXT_CHARS = 8_000

export interface FetchedPage {
  title?: string
  description?: string
  text: string
}

/**
 * Validate a URL and block obvious SSRF targets (loopback / private ranges).
 * Returns the parsed URL on success; throws ValidationError otherwise.
 */
export function assertSafeUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ValidationError('That does not look like a valid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('Only http and https links are supported')
  }

  if (isBlockedHost(url.hostname.toLowerCase())) {
    throw new ValidationError(
      'Links pointing to local or private network addresses are not allowed',
    )
  }

  return url
}

function isBlockedHost(host: string): boolean {
  // Strip IPv6 brackets if present
  const bare =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  if (bare.endsWith('.local') || bare.endsWith('.internal')) return true
  if (bare === '::1' || bare === '::') return true

  // IPv4 loopback / private / link-local / unspecified ranges
  const ipv4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0 || a === 127) return true // unspecified / loopback
    if (a === 10) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 169 && b === 254) return true // link-local
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true
  if (/^fe[89ab][0-9a-f]:/i.test(bare)) return true

  return false
}

/** Title, meta description, and cleaned, bounded body text of an HTML document. */
export function extractText(html: string): FetchedPage {
  const rawTitle = matchGroup(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
  const rawDescription =
    metaContent(html, 'name', 'description') ??
    metaContent(html, 'property', 'og:description')

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')

  return {
    title: rawTitle ? clean(rawTitle) : undefined,
    description: rawDescription ? clean(rawDescription) : undefined,
    text: clean(body).slice(0, MAX_TEXT_CHARS),
  }
}

function matchGroup(html: string, regex: RegExp): string | undefined {
  const match = regex.exec(html)
  return match?.[1]
}

/** Extract the `content` attribute of a <meta> tag matched by attr=value. */
function metaContent(
  html: string,
  attr: string,
  value: string,
): string | undefined {
  const tagRegex = new RegExp(
    `<meta[^>]+${attr}=["']${escapeRegExp(value)}["'][^>]*>`,
    'i',
  )
  const tag = tagRegex.exec(html)?.[0]
  if (!tag) return undefined
  return matchGroup(tag, /content=["']([\s\S]*?)["']/i)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function clean(value: string): string {
  return decodeEntities(value).replace(/\s+/g, ' ').trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      codePoint(parseInt(hex, 16)),
    )
    .replace(/&amp;/gi, '&') // decode last to avoid double-decoding
}

function codePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}
