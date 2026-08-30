// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Client IP resolution — the identity every rate-limit bucket and auth-event
 * row is keyed on (API2-4).
 *
 * Security gate: the predecessor read the *leftmost* `X-Forwarded-For` entry,
 * which the caller writes. Rotating it minted a fresh login bucket per request
 * — ten attempts a minute became unlimited — and pinning it to someone else's
 * address spent their budget instead, while `auth_events.ip_address` recorded
 * whatever the attacker chose. Getting the fix wrong in the other direction is
 * just as bad: trusting one hop too few throws away a real proxy deployment's
 * only true client address.
 *
 * Invariants:
 *  - trust depth 0 (the default) ignores forwarded headers entirely, so header
 *    rotation cannot mint buckets
 *  - trust depth N reads the Nth entry from the *right* — the address the
 *    innermost trusted proxy actually saw
 *  - the recorded socket address answers when no header is trusted or usable
 *  - a short, empty or non-address header falls back to that socket address,
 *    never forward to the caller-chosen leftmost entry
 *  - a malformed TRUSTED_PROXY_COUNT fails closed to 0
 *
 * Run: npx vitest run packages/core/src/lib/api/client-ip.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UNKNOWN_CLIENT_IP,
  recordSocketAddress,
  resolveClientIp,
} from './client-ip'

const SOCKET = '198.51.100.9'
const REAL_CLIENT = '203.0.113.7'
const ATTACKER_CHOICE = '192.0.2.66'

const originalDepth = process.env.TRUSTED_PROXY_COUNT

afterEach(() => {
  if (originalDepth === undefined) {
    delete process.env.TRUSTED_PROXY_COUNT
  } else {
    process.env.TRUSTED_PROXY_COUNT = originalDepth
  }
})

function trustDepth(value: string | null): void {
  if (value === null) {
    delete process.env.TRUSTED_PROXY_COUNT
  } else {
    process.env.TRUSTED_PROXY_COUNT = value
  }
}

/**
 * A request as `adapt()` would have handed it over: peer address recorded when
 * the runtime had one, which is the only part of this a caller cannot write.
 */
function incoming(options: {
  forwarded?: string
  socket?: string | undefined
}): Request {
  const headers = new Headers()
  if (options.forwarded !== undefined) {
    headers.set('x-forwarded-for', options.forwarded)
  }
  const request = new Request('http://localhost:3000/api/v1/auth/login', {
    method: 'POST',
    headers,
  })
  recordSocketAddress(request, options.socket)
  return request
}

describe('resolveClientIp with no trusted proxies', () => {
  it('gives requests differing only in X-Forwarded-For the same key', () => {
    trustDepth(null)

    const keys = [
      'attacker-rotation-1',
      '10.0.0.1',
      `${ATTACKER_CHOICE}, ${REAL_CLIENT}`,
      '',
    ].map((forwarded) =>
      resolveClientIp(incoming({ forwarded, socket: SOCKET })),
    )

    // The whole point: one connection is one bucket, however many identities
    // its headers claim. A caller who could vary this would have no login
    // budget at all.
    expect(new Set(keys)).toEqual(new Set([SOCKET]))
  })

  it('resolves a request with a recorded socket address and no header to it', () => {
    trustDepth('0')

    expect(resolveClientIp(incoming({ socket: SOCKET }))).toBe(SOCKET)
  })

  it('ignores X-Real-IP as readily as X-Forwarded-For', () => {
    trustDepth(null)

    const request = new Request('http://localhost:3000/api/v1/auth/login', {
      headers: { 'x-real-ip': ATTACKER_CHOICE },
    })
    recordSocketAddress(request, SOCKET)

    expect(resolveClientIp(request)).toBe(SOCKET)
  })

  it('reports the shared unknown key when nothing identifies the caller', () => {
    trustDepth(null)

    // A shared bucket, not a private one — the worst case is that callers with
    // no peer address queue behind each other, never that they escape the
    // budget.
    expect(resolveClientIp(incoming({ forwarded: ATTACKER_CHOICE }))).toBe(
      UNKNOWN_CLIENT_IP,
    )
  })
})

describe('resolveClientIp behind trusted proxies', () => {
  it('takes the rightmost untrusted hop at depth 1', () => {
    trustDepth('1')

    // The proxy appended what it saw — REAL_CLIENT — after the entry the
    // caller sent ahead of it. Reading left to right is what handed the
    // caller their own identity.
    const resolved = resolveClientIp(
      incoming({
        forwarded: `${ATTACKER_CHOICE}, ${REAL_CLIENT}`,
        socket: SOCKET,
      }),
    )

    expect(resolved).toBe(REAL_CLIENT)
  })

  it('counts hops from the right at greater depths', () => {
    trustDepth('2')

    const resolved = resolveClientIp(
      incoming({
        forwarded: `${ATTACKER_CHOICE}, ${REAL_CLIENT}, 172.16.0.4`,
        socket: SOCKET,
      }),
    )

    expect(resolved).toBe(REAL_CLIENT)
  })

  it('still ignores a header the deployment has no proxies to have written', () => {
    trustDepth('0')

    expect(
      resolveClientIp(
        incoming({
          forwarded: `${ATTACKER_CHOICE}, ${REAL_CLIENT}`,
          socket: SOCKET,
        }),
      ),
    ).toBe(SOCKET)
  })

  it('reads a single-entry header at depth 1, the well-formed one-hop case', () => {
    trustDepth('1')

    expect(
      resolveClientIp(incoming({ forwarded: REAL_CLIENT, socket: SOCKET })),
    ).toBe(REAL_CLIENT)
  })

  const UNUSABLE: Array<[string, string]> = [
    ['an empty header', ''],
    ['a header of nothing but separators', ' , , '],
    ['a trusted entry that is not an address', `${ATTACKER_CHOICE}, junk`],
    [
      'a trusted entry too long to be an address',
      `${ATTACKER_CHOICE}, ${'1'.repeat(46)}`,
    ],
  ]

  for (const [label, forwarded] of UNUSABLE) {
    it(`falls back to the socket address for ${label}`, () => {
      trustDepth('1')

      const resolved = resolveClientIp(incoming({ forwarded, socket: SOCKET }))

      // Never forward to the leftmost entry: that one is the caller's to
      // choose, and choosing it is how the header gets spoofed in the first
      // place.
      expect(resolved).toBe(SOCKET)
      expect(resolved).not.toBe(ATTACKER_CHOICE)
    })
  }

  it('falls back when the header is shorter than the trusted chain', () => {
    trustDepth('2')

    // Two proxies would have appended two entries; one entry means this header
    // did not come through the chain the deployment described, so nothing in
    // it is vouched for.
    const resolved = resolveClientIp(
      incoming({ forwarded: ATTACKER_CHOICE, socket: SOCKET }),
    )

    expect(resolved).toBe(SOCKET)
    expect(resolved).not.toBe(ATTACKER_CHOICE)
  })

  it('reports unknown when neither the header nor a socket can answer', () => {
    trustDepth('3')

    expect(resolveClientIp(incoming({ forwarded: REAL_CLIENT }))).toBe(
      UNKNOWN_CLIENT_IP,
    )
  })
})

describe('resolveClientIp trust configuration', () => {
  const MALFORMED = ['abc', '-1', '1.5', 'true']

  for (const value of MALFORMED) {
    it(`treats TRUSTED_PROXY_COUNT="${value}" as trusting nothing`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      trustDepth(value)

      const resolved = resolveClientIp(
        incoming({
          forwarded: `${ATTACKER_CHOICE}, ${REAL_CLIENT}`,
          socket: SOCKET,
        }),
      )

      // A typo in a deployment env must fail closed, not silently widen trust.
      expect(resolved).toBe(SOCKET)
      expect(warn).toHaveBeenCalled()
    })
  }
})
