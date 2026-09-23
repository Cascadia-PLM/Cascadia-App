// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Gates 2 and 3: this is the repository's only HMAC and its only constant-time
 * comparison, and every case below is one an attacker would try.
 *
 * No database. Signing is a pure function of bytes, a secret and a clock, and
 * all three are arguments.
 */

import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOLERANCE_SECONDS,
  signWebhookBody,
  signWebhookBodyWithSecrets,
  verifyWebhookSignature,
} from './signing'

const SECRET = 'cscwh_0123456789abcdef0123456789abcdef'
const OTHER_SECRET = 'cscwh_fedcba9876543210fedcba9876543210'
const BODY = '{"id":"evt-1","type":"design.released","payload":{"n":1}}'
const TIMESTAMP = 1_760_000_000

describe('signWebhookBody', () => {
  /**
   * The digest is pinned as a literal deliberately.
   *
   * Everything about the signing string is a compatibility promise to every
   * receiver that has already deployed verification code — the scheme tag, the
   * separator, the field order, and the fact that the timestamp is inside the
   * signed material rather than beside it. A refactor that changes any of them
   * still passes a round-trip test, because both halves change together. Only a
   * pinned digest fails, which is the point: this failing means a receiver
   * somewhere stops verifying, and the fix is a new scheme tag, not a new
   * expectation here.
   */
  it('produces a stable digest for known input', () => {
    expect(signWebhookBody(BODY, SECRET, TIMESTAMP)).toBe(
      't=1760000000,v1=31d628fe88013db4a9830e67649f733325aac9a938ab0905da8ab299066f2969',
    )
  })

  it('signs the timestamp, not just the body', () => {
    const early = signWebhookBody(BODY, SECRET, TIMESTAMP)
    const late = signWebhookBody(BODY, SECRET, TIMESTAMP + 1)
    expect(early).not.toBe(late)
  })

  it('round-trips through verification', () => {
    const header = signWebhookBody(BODY, SECRET, TIMESTAMP)
    expect(
      verifyWebhookSignature(BODY, header, SECRET, { nowSeconds: TIMESTAMP }),
    ).toBe(true)
  })
})

describe('verifyWebhookSignature', () => {
  const sign = (body = BODY, secret = SECRET, timestamp = TIMESTAMP) =>
    signWebhookBody(body, secret, timestamp)

  it('rejects a body altered by one byte', () => {
    const header = sign()
    // `{"n":1}` → `{"n":2}`: one character, same length, same key order.
    const tampered = BODY.replace('"n":1', '"n":2')
    expect(tampered).not.toBe(BODY)
    expect(
      verifyWebhookSignature(tampered, header, SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })

  it('rejects a wrong secret', () => {
    expect(
      verifyWebhookSignature(BODY, sign(), OTHER_SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })

  it('rejects a stale timestamp', () => {
    const header = sign()
    expect(
      verifyWebhookSignature(BODY, header, SECRET, {
        nowSeconds: TIMESTAMP + DEFAULT_TOLERANCE_SECONDS + 1,
      }),
    ).toBe(false)
  })

  /**
   * Both directions. A signature minted far in the future would otherwise
   * outlive every window a receiver might configure, which is a replay token
   * with no expiry.
   */
  it('rejects a timestamp too far in the future', () => {
    const header = sign()
    expect(
      verifyWebhookSignature(BODY, header, SECRET, {
        nowSeconds: TIMESTAMP - DEFAULT_TOLERANCE_SECONDS - 1,
      }),
    ).toBe(false)
  })

  it('accepts a timestamp at the edge of tolerance', () => {
    const header = sign()
    expect(
      verifyWebhookSignature(BODY, header, SECRET, {
        nowSeconds: TIMESTAMP + DEFAULT_TOLERANCE_SECONDS,
      }),
    ).toBe(true)
  })

  /**
   * `timingSafeEqual` throws on buffers of unequal length, so the length guard
   * has to come before it. A truncated signature is an attacker's probe, and
   * the answer to a probe is `false`, not a 500.
   */
  it('returns false rather than throwing on a short signature', () => {
    expect(() =>
      verifyWebhookSignature(BODY, `t=${TIMESTAMP},v1=abcd`, SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).not.toThrow()
    expect(
      verifyWebhookSignature(BODY, `t=${TIMESTAMP},v1=abcd`, SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })

  it('returns false rather than throwing on an over-long signature', () => {
    const valid = createHmac('sha256', SECRET).update('x').digest('hex')
    const header = `t=${TIMESTAMP},v1=${valid}00`
    expect(() =>
      verifyWebhookSignature(BODY, header, SECRET, { nowSeconds: TIMESTAMP }),
    ).not.toThrow()
    expect(
      verifyWebhookSignature(BODY, header, SECRET, { nowSeconds: TIMESTAMP }),
    ).toBe(false)
  })

  /**
   * A non-hex character makes `Buffer.from(v, 'hex')` stop early, producing a
   * shorter buffer than the string implies — which is how two different
   * signatures can compare equal if the length check is done on strings and the
   * comparison on buffers.
   */
  it('returns false on a non-hex signature of the right length', () => {
    const expected = signWebhookBody(BODY, SECRET, TIMESTAMP).split('v1=')[1]
    expect(expected).toBeDefined()
    const nonHex = 'z'.repeat(expected?.length ?? 64)
    expect(
      verifyWebhookSignature(BODY, `t=${TIMESTAMP},v1=${nonHex}`, SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })

  it('rejects a header with no signature', () => {
    expect(
      verifyWebhookSignature(BODY, `t=${TIMESTAMP}`, SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })

  it('rejects a header with no timestamp', () => {
    const signature = signWebhookBody(BODY, SECRET, TIMESTAMP).split(',')[1]
    expect(signature).toBeDefined()
    expect(
      verifyWebhookSignature(BODY, signature ?? '', SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })

  /**
   * A second `t=` is a malformed header, not a second candidate timestamp.
   * Accepting either would let an attacker pair a fresh timestamp with a
   * signature over a stale one.
   */
  it('rejects a header carrying two timestamps', () => {
    const header = `${signWebhookBody(BODY, SECRET, TIMESTAMP)},t=${TIMESTAMP}`
    expect(
      verifyWebhookSignature(BODY, header, SECRET, { nowSeconds: TIMESTAMP }),
    ).toBe(false)
  })

  it('rejects a non-numeric timestamp', () => {
    const signature = signWebhookBody(BODY, SECRET, TIMESTAMP).split('v1=')[1]
    expect(
      verifyWebhookSignature(BODY, `t=abc,v1=${signature}`, SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })

  it('ignores an unknown scheme tag', () => {
    const signature = signWebhookBody(BODY, SECRET, TIMESTAMP).split('v1=')[1]
    expect(
      verifyWebhookSignature(BODY, `t=${TIMESTAMP},v2=${signature}`, SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })
})

/**
 * Rotation is the reason the header carries a list. A receiver cannot swap
 * secrets atomically with us, so during an overlap window both must verify.
 */
describe('signWebhookBodyWithSecrets', () => {
  it('verifies against either secret', () => {
    const header = signWebhookBodyWithSecrets(
      BODY,
      [SECRET, OTHER_SECRET],
      TIMESTAMP,
    )
    expect(
      verifyWebhookSignature(BODY, header, SECRET, { nowSeconds: TIMESTAMP }),
    ).toBe(true)
    expect(
      verifyWebhookSignature(BODY, header, OTHER_SECRET, {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(true)
  })

  it('still rejects a third secret', () => {
    const header = signWebhookBodyWithSecrets(
      BODY,
      [SECRET, OTHER_SECRET],
      TIMESTAMP,
    )
    expect(
      verifyWebhookSignature(BODY, header, 'cscwh_deadbeef', {
        nowSeconds: TIMESTAMP,
      }),
    ).toBe(false)
  })

  it('carries one timestamp for every signature', () => {
    const header = signWebhookBodyWithSecrets(
      BODY,
      [SECRET, OTHER_SECRET],
      TIMESTAMP,
    )
    expect(header.match(/t=/g)).toHaveLength(1)
    expect(header.match(/v1=/g)).toHaveLength(2)
  })
})
