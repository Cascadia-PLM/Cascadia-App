// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC-SHA256 signing for outbound webhook deliveries.
 *
 * This is the repository's first HMAC and its first constant-time comparison,
 * so there is no in-house pattern to copy. Three decisions are load-bearing and
 * none of them is a formatting preference:
 *
 * **The signature is over the raw request bytes, not a canonicalised object.**
 * Over HTTP the bytes are the artefact — a receiver has to be able to verify
 * what it received without re-serialising it, and re-serialising is exactly
 * where key order, number formatting and unicode escaping start to disagree.
 * Canonical JSON is the right tool when the *object* is the artefact, which is
 * why the auditing package has one and this does not.
 *
 * **The timestamp is inside the signed material, not merely alongside it.**
 * At-least-once redelivery is a designed property of the log, so a receiver
 * cannot tell a legitimate redelivery from an attacker's replay by novelty
 * alone. Signing the timestamp gives it a freshness window; deduping on the
 * event id gives it idempotence. It needs both, and a timestamp that is only a
 * header is neither.
 *
 * **The header format admits a list of signatures, not one.** Every delivery
 * carries exactly one today: rotation replaces the secret immediately, and a
 * receiver bridges it by verifying against both of its own secrets until it
 * has switched. The list is what would let an overlap window — or a second
 * scheme — be offered from this side later without changing the format, which
 * is why receivers are told to accept any matching value.
 *
 * There is no trusted timestamping authority here, the way the auditing
 * package's anchoring notes: the timestamp is ours, and it proves freshness
 * relative to a clock the receiver also has to trust. It is a replay window,
 * not proof of when something happened.
 */

/** Header carrying the timestamp and one or more signatures. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-cascadia-signature'

/** Header carrying the event id, so a receiver can dedupe redeliveries. */
export const WEBHOOK_EVENT_ID_HEADER = 'x-cascadia-event-id'

/** Header carrying the event type, so a receiver can route without parsing. */
export const WEBHOOK_EVENT_TYPE_HEADER = 'x-cascadia-event-type'

/** Signature scheme identifier, so the format can change without ambiguity. */
const SCHEME = 'v1'

/** How far a delivery's timestamp may be from the receiver's clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300

/**
 * Build the string that gets signed: scheme, timestamp and body, joined by a
 * character that cannot appear in the first two fields.
 *
 * Including the scheme means a future `v2` over different material can never
 * collide with a `v1` signature over the same bytes.
 */
function signingString(timestamp: number, body: string): string {
  return `${SCHEME}.${timestamp}.${body}`
}

/**
 * Sign a delivery body, returning the header value.
 *
 * `timestamp` is seconds since the epoch, taken by the caller so a test can
 * pin it.
 */
export function signWebhookBody(
  body: string,
  secret: string,
  timestamp: number,
): string {
  const signature = createHmac('sha256', secret)
    .update(signingString(timestamp, body), 'utf8')
    .digest('hex')
  return `t=${timestamp},${SCHEME}=${signature}`
}

/**
 * Build a header presenting one signature per secret.
 *
 * Nothing sends more than one today — rotation is immediate — but receivers are
 * verified against the list form, so an overlap can be offered without a
 * format change.
 *
 * All signatures share one timestamp, because the timestamp is signed: a
 * per-secret timestamp would need a per-secret `t=` and the header format
 * deliberately has one.
 */
export function signWebhookBodyWithSecrets(
  body: string,
  secrets: ReadonlyArray<string>,
  timestamp: number,
): string {
  const signatures = secrets.map(
    (secret) =>
      `${SCHEME}=${createHmac('sha256', secret)
        .update(signingString(timestamp, body), 'utf8')
        .digest('hex')}`,
  )
  return [`t=${timestamp}`, ...signatures].join(',')
}

/** The parts of a signature header, once parsed. */
interface ParsedSignatureHeader {
  timestamp: number
  signatures: Array<string>
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null
  const signatures: Array<string> = []

  for (const part of header.split(',')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()

    if (key === 't') {
      // A second `t=` is a malformed header, not a second candidate.
      if (timestamp !== null) return null
      if (!/^\d+$/.test(value)) return null
      timestamp = Number(value)
    } else if (key === SCHEME) {
      signatures.push(value)
    }
  }

  if (timestamp === null || signatures.length === 0) return null
  return { timestamp, signatures }
}

/**
 * Constant-time hex comparison that tolerates a wrong length.
 *
 * `timingSafeEqual` **throws** on buffers of unequal length, so the length
 * guard has to come first or a truncated signature is an exception rather than
 * a `false`. Comparing lengths in the clear leaks nothing an attacker cannot
 * already see: the digest length is fixed and public.
 */
function secureEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  // A non-hex character would make the buffers shorter than the strings and
  // could make two different values compare equal, so reject up front.
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

export interface VerifyWebhookOptions {
  /** Seconds of clock skew to allow in either direction. */
  toleranceSeconds?: number
  /** Current time in seconds since the epoch; injectable for tests. */
  nowSeconds?: number
}

/**
 * Verify a delivery the way a receiver should — shipped so the tests and the
 * documentation's worked example use the same code a customer would.
 *
 * Returns a boolean rather than throwing, because every failure mode here is
 * "this request is not ours" and a receiver's only correct response to all of
 * them is the same.
 */
export function verifyWebhookSignature(
  body: string,
  header: string,
  secret: string,
  options: VerifyWebhookOptions = {},
): boolean {
  const parsed = parseSignatureHeader(header)
  if (!parsed) return false

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  // Both directions: a timestamp far in the future is as suspect as a stale
  // one, and rejecting only the past accepts a signature minted to outlive
  // every window a receiver might configure.
  if (Math.abs(now - parsed.timestamp) > tolerance) return false

  const expected = createHmac('sha256', secret)
    .update(signingString(parsed.timestamp, body), 'utf8')
    .digest('hex')

  // Every candidate is compared, and the result is accumulated rather than
  // returned early, so the number of comparisons does not depend on which one
  // matched.
  let matched = false
  for (const candidate of parsed.signatures) {
    if (secureEqualHex(candidate, expected)) matched = true
  }
  return matched
}
