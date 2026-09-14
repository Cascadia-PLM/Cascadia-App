// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Gate 2. This guard is the only thing standing between a stored webhook target
 * and the deployment's own network, and a webhook target is re-fetched forever —
 * so every gap is a persistent internal-network read primitive rather than a
 * one-off.
 *
 * A pure unit test with an injected resolver. The corpus below is exactly the
 * set of addresses that bypass the repository's older guard, plus the shapes
 * that make a resolver-based check different from a text-based one.
 */

import { describe, expect, it } from 'vitest'
import {
  EgressBlockedError,
  EgressResolutionError,
  assertPublicHost,
  assertTargetResolvesPublic,
  classifyAddress,
  validateEgressUrl,
} from './egress-guard'
import type { HostResolver } from './egress-guard'
import { ValidationError } from '@/lib/errors'

const resolvesTo =
  (...addresses: Array<string>): HostResolver =>
  () =>
    Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    )

describe('classifyAddress', () => {
  /**
   * The three that genuinely pass the older guard, measured rather than
   * assumed. Its integer-literal, hex, octal and short-form cases are already
   * caught there — `new URL()` runs first and the WHATWG IPv4 parser
   * canonicalises all four to `127.0.0.1` — so the real gaps are these.
   */
  describe('the shapes that bypass the older guard', () => {
    it('blocks an IPv4-mapped IPv6 loopback address', () => {
      // Normalises to `::ffff:7f00:1`, which matches neither a dotted-quad
      // regex nor the `::1` literal. It has to be unwrapped and re-tested.
      expect(classifyAddress('::ffff:127.0.0.1').blocked).toBe(true)
      expect(classifyAddress('::ffff:7f00:1').blocked).toBe(true)
    })

    it('blocks an IPv4-mapped private address', () => {
      expect(classifyAddress('::ffff:10.0.0.1').blocked).toBe(true)
      expect(classifyAddress('::ffff:192.168.1.1').blocked).toBe(true)
    })

    it('blocks carrier-grade NAT', () => {
      expect(classifyAddress('100.64.0.1').blocked).toBe(true)
      expect(classifyAddress('100.127.255.255').blocked).toBe(true)
      // 100.63 and 100.128 are outside the /10 and are ordinary public space.
      expect(classifyAddress('100.63.255.255').blocked).toBe(false)
      expect(classifyAddress('100.128.0.1').blocked).toBe(false)
    })

    it('blocks the benchmarking range', () => {
      expect(classifyAddress('198.18.0.1').blocked).toBe(true)
      expect(classifyAddress('198.19.255.255').blocked).toBe(true)
      expect(classifyAddress('198.20.0.1').blocked).toBe(false)
    })
  })

  describe('IPv4', () => {
    it.each([
      ['0.0.0.0', 'unspecified'],
      ['127.0.0.1', 'loopback'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.168.0.1', 'private'],
      ['169.254.169.254', 'link-local, the cloud metadata address'],
      ['224.0.0.1', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'broadcast'],
    ])('blocks %s (%s)', (address) => {
      expect(classifyAddress(address).blocked).toBe(true)
    })

    it.each([
      ['1.1.1.1'],
      ['8.8.8.8'],
      ['172.15.255.255'],
      ['172.32.0.1'],
      ['192.167.255.255'],
      ['192.169.0.1'],
    ])('allows the public address %s', (address) => {
      expect(classifyAddress(address).blocked).toBe(false)
    })
  })

  describe('IPv6', () => {
    /**
     * One address, three spellings. This is why the classifier parses to bytes
     * instead of matching the text form — prefix matching on IPv6 is the bug
     * class this file exists to avoid.
     */
    it('blocks a link-local address however it is spelled', () => {
      expect(classifyAddress('fe80::1').blocked).toBe(true)
      expect(classifyAddress('FE80:0:0:0:0:0:0:1').blocked).toBe(true)
      expect(
        classifyAddress('fe80:0000:0000:0000:0000:0000:0000:0001').blocked,
      ).toBe(true)
      expect(classifyAddress('fe80::1%eth0').blocked).toBe(true)
    })

    it.each([
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['fc00::1', 'unique local'],
      ['fdff::1', 'unique local, top of fc00::/7'],
      ['febf::1', 'link-local, top of fe80::/10'],
      ['ff02::1', 'multicast'],
      ['::127.0.0.1', 'IPv4-compatible, written as a dotted quad'],
      ['::7f00:1', 'IPv4-compatible, as a URL parser writes it'],
      ['::a00:1', 'IPv4-compatible, embedding a private address'],
      ['64:ff9b:1::a00:1', 'local-use NAT64'],
    ])('blocks %s (%s)', (address) => {
      expect(classifyAddress(address).blocked).toBe(true)
    })

    it.each([['2606:4700:4700::1111'], ['2001:4860:4860::8888']])(
      'allows the public address %s',
      (address) => {
        expect(classifyAddress(address).blocked).toBe(false)
      },
    )

    /**
     * NAT64 is live in real networks, so an embedded private address routes.
     * 6to4 is deliberately not unwrapped and the docstring says why — its relay
     * infrastructure is deprecated and unreachable.
     */
    it('unwraps a NAT64-embedded private address', () => {
      expect(classifyAddress('64:ff9b::10.0.0.1').blocked).toBe(true)
      expect(classifyAddress('64:ff9b::127.0.0.1').blocked).toBe(true)
    })

    it('does not mistake a public NAT64 address for a private one', () => {
      expect(classifyAddress('64:ff9b::8.8.8.8').blocked).toBe(false)
    })

    it('refuses an unparseable address rather than allowing it', () => {
      expect(classifyAddress('fe80::1::2').blocked).toBe(true)
      expect(classifyAddress('not-an-address').blocked).toBe(true)
      expect(classifyAddress('fe80::zzzz').blocked).toBe(true)
    })
  })
})

describe('validateEgressUrl', () => {
  it('accepts an ordinary https endpoint', () => {
    const url = validateEgressUrl('https://hooks.example.com/cascadia')
    expect(url.hostname).toBe('hooks.example.com')
  })

  describe('scheme', () => {
    it('refuses http unless plaintext is opted into', () => {
      expect(() => validateEgressUrl('http://hooks.example.com/x')).toThrow(
        ValidationError,
      )
      expect(
        validateEgressUrl('http://hooks.example.com/x', {
          allowInsecure: true,
        }).protocol,
      ).toBe('http:')
    })

    /**
     * `z.string().url()` accepts all of these on this repository's Zod version,
     * which is why the schema has to call this function rather than marking the
     * field as a URL.
     */
    it.each([
      ['file:///etc/passwd'],
      ['javascript:alert(1)'],
      ['data:text/plain,hello'],
      ['ftp://example.com/x'],
    ])('refuses %s even with plaintext allowed', (raw) => {
      expect(() => validateEgressUrl(raw, { allowInsecure: true })).toThrow(
        ValidationError,
      )
    })
  })

  describe('credentials', () => {
    it('refuses an embedded username or password', () => {
      expect(() =>
        validateEgressUrl('https://user:secret@hooks.example.com/x'),
      ).toThrow(ValidationError)
      expect(() =>
        validateEgressUrl('https://user@hooks.example.com/x'),
      ).toThrow(ValidationError)
    })
  })

  describe('address literals, judged at write time', () => {
    it.each([
      ['https://127.0.0.1/hook'],
      ['https://[::1]/hook'],
      ['https://[::ffff:127.0.0.1]/hook'],
      ['https://169.254.169.254/latest/meta-data/'],
      ['https://100.64.0.1/hook'],
      ['https://198.18.0.1/hook'],
      ['https://[::127.0.0.1]/hook'],
      // Canonicalised to 127.0.0.1 by the URL parser, then classified.
      ['https://2130706433/hook'],
      ['https://0x7f000001/hook'],
      ['https://127.1/hook'],
    ])('refuses %s', (raw) => {
      expect(() => validateEgressUrl(raw)).toThrow(ValidationError)
    })

    it('accepts a public address literal', () => {
      expect(validateEgressUrl('https://1.1.1.1/hook').hostname).toBe('1.1.1.1')
    })

    /**
     * A loopback port is irrelevant once the host is refused, but a database
     * port on a *public* host is not this guard's business — it is a legitimate
     * endpoint on an unusual port.
     */
    it('accepts an unusual port on a public host', () => {
      expect(validateEgressUrl('https://hooks.example.com:8443/x').port).toBe(
        '8443',
      )
    })
  })

  describe('local names', () => {
    it.each([
      ['https://localhost/hook'],
      ['https://api.localhost/hook'],
      ['https://db.local/hook'],
      ['https://vault.internal/hook'],
    ])('refuses %s', (raw) => {
      expect(() => validateEgressUrl(raw)).toThrow(ValidationError)
    })
  })

  it('refuses an over-long URL', () => {
    const raw = `https://hooks.example.com/${'x'.repeat(3000)}`
    expect(() => validateEgressUrl(raw)).toThrow(ValidationError)
  })

  it('refuses something that is not a URL at all', () => {
    expect(() => validateEgressUrl('not a url')).toThrow(ValidationError)
    expect(() => validateEgressUrl('')).toThrow(ValidationError)
  })
})

describe('assertPublicHost', () => {
  it('allows a host resolving only to public addresses', async () => {
    await expect(
      assertPublicHost('hooks.example.com', resolvesTo('93.184.216.34')),
    ).resolves.toBeUndefined()
  })

  /**
   * The case that makes this a resolver check rather than a hostname check: a
   * name whose answer mixes one public and one private address. A client that
   * tries them in order reaches the private one as soon as the public one
   * refuses a connection, so one private answer condemns the name.
   */
  it('refuses a host resolving to one public and one private address', async () => {
    await expect(
      assertPublicHost(
        'sneaky.example.com',
        resolvesTo('93.184.216.34', '10.0.0.5'),
      ),
    ).rejects.toThrow(EgressBlockedError)
  })

  it('refuses a host resolving only to a private address', async () => {
    await expect(
      assertPublicHost('internal.example.com', resolvesTo('192.168.1.10')),
    ).rejects.toThrow(EgressBlockedError)
  })

  it('refuses a host resolving to a link-local address', async () => {
    await expect(
      assertPublicHost('metadata.example.com', resolvesTo('169.254.169.254')),
    ).rejects.toThrow(EgressBlockedError)
  })

  /**
   * Refused, but not blocked. Nothing is known about the address of a name
   * that does not resolve, so this is no verdict on it: a delivery retries it,
   * where a block is final. A DNS outage must not kill every delivery it
   * touches.
   */
  it('refuses a host that resolves to nothing, as unresolved rather than blocked', async () => {
    const attempt = assertPublicHost('void.example.com', () =>
      Promise.resolve([]),
    )
    await expect(attempt).rejects.toThrow(EgressResolutionError)
    await expect(attempt).rejects.not.toThrow(EgressBlockedError)
  })

  it('refuses a host whose lookup fails, as unresolved rather than blocked', async () => {
    await expect(
      assertPublicHost('broken.example.com', () =>
        Promise.reject(new Error('ENOTFOUND')),
      ),
    ).rejects.toThrow(EgressResolutionError)
  })

  /**
   * A literal is classified without a lookup. Asking a resolver about an address
   * invites an answer, and the answer is not the thing we are about to connect
   * to.
   */
  it('classifies an address literal without resolving it', async () => {
    let asked = false
    const resolver: HostResolver = () => {
      asked = true
      return Promise.resolve([{ address: '93.184.216.34', family: 4 }])
    }

    await expect(assertPublicHost('127.0.0.1', resolver)).rejects.toThrow(
      EgressBlockedError,
    )
    expect(asked).toBe(false)
  })

  it('unwraps a bracketed IPv6 literal', async () => {
    await expect(
      assertPublicHost('[::1]', resolvesTo('93.184.216.34')),
    ).rejects.toThrow(EgressBlockedError)
  })

  /**
   * Every message an operator sees names a *category*, never the address or
   * host that was refused. A guard that echoed what it resolved would be the
   * read primitive it exists to prevent.
   */
  it('never names the address it refused', async () => {
    let message = ''
    try {
      await assertPublicHost('sneaky.example.com', resolvesTo('10.11.12.13'))
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).not.toContain('10.11.12.13')
    expect(message).not.toContain('sneaky.example.com')
    expect(message).toContain('private address')
  })
})

describe('assertTargetResolvesPublic', () => {
  it('refuses on save a target whose host resolves somewhere private', async () => {
    await expect(
      assertTargetResolvesPublic(
        new URL('https://internal.example.com/hook'),
        resolvesTo('10.0.0.5'),
      ),
    ).rejects.toThrow(ValidationError)
  })

  /**
   * Best-effort in one direction only: a receiver still being deployed has no
   * DNS record yet, and the send-time check runs on every delivery regardless.
   */
  it('accepts a target whose host does not resolve yet', async () => {
    await expect(
      assertTargetResolvesPublic(
        new URL('https://not-yet.example.com/hook'),
        () => Promise.reject(new Error('ENOTFOUND')),
      ),
    ).resolves.toBeUndefined()
  })

  it('accepts a target resolving only to public addresses', async () => {
    await expect(
      assertTargetResolvesPublic(
        new URL('https://hooks.example.com/hook'),
        resolvesTo('93.184.216.34'),
      ),
    ).resolves.toBeUndefined()
  })
})
