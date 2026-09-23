// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { isIP, isIPv4 } from 'node:net'
import dns from 'node:dns'
import { ValidationError } from '@/lib/errors'

/**
 * Whether an address the system is about to connect to is somewhere on the
 * public internet, rather than inside the deployment's own network.
 *
 * **This is not `assertSafeUrl` and must not be replaced by it.** That function
 * (`lib/items/enrichment/html-to-text.ts`) is the repository's other egress
 * check, and it is survivable where it lives because the URL there is transient
 * and fetched once, under an operator's own nose. A webhook target is *stored*
 * and re-fetched forever, which turns any gap into a persistent
 * internal-network read primitive — so this one resolves and classifies
 * numerically instead of matching hostname text.
 *
 * **Measured, not assumed.** Running the bypass corpus through `assertSafeUrl`
 * as it stands today:
 *
 * | Target                       | `assertSafeUrl` |
 * | ---------------------------- | --------------- |
 * | `http://2130706433/`         | blocked         |
 * | `http://0x7f000001/`         | blocked         |
 * | `http://127.1/`              | blocked         |
 * | `http://0177.0.0.1/`         | blocked         |
 * | `http://[::ffff:127.0.0.1]/` | **allowed**     |
 * | `http://100.64.0.1/`         | **allowed**     |
 * | `http://198.18.0.1/`         | **allowed**     |
 *
 * The integer-literal, hex, octal and short-form addresses are caught, and not
 * by the hostname regex: `new URL()` runs first, and the WHATWG parser's IPv4
 * parser canonicalises all four to `127.0.0.1` before anything is matched. What
 * genuinely passes is the IPv4-mapped IPv6 address — which normalises to
 * `[::ffff:7f00:1]`, matching neither the dotted-quad regex nor the `::1`
 * literal — and the carrier-grade NAT and benchmarking ranges, which the
 * regex matches and the range list omits.
 *
 * **What this does not close, stated rather than implied.** DNS rebinding
 * between the lookup and the connection is open: a name that resolves to a
 * public address here can resolve to a private one when the socket is opened
 * milliseconds later. Closing it needs a custom dispatcher that connects to the
 * vetted address while preserving the Host header, which is a larger change than
 * this guard. What raises the cost meanwhile is that the delivery executor sets
 * `redirect: 'manual'` — a redirect was the cheap version of the same attack and
 * it is gone — and that a rebind has to win a race on every delivery rather than
 * being configured once. Pretending the hole is closed would be worse than
 * saying it is not.
 *
 * Also not unwrapped: 6to4 (`2002::/16`) and NAT64 (`64:ff9b::/96`) embed an
 * IPv4 address that a hostile resolver could point at a private host. NAT64 is
 * unwrapped below; 6to4 is not, because its relay infrastructure is deprecated
 * and unreachable, so an embedded private address does not route. Two more
 * embedding forms are refused outright rather than unwrapped: the deprecated
 * IPv4-compatible `::/96`, and the local-use NAT64 prefix `64:ff9b:1::/48`,
 * which an operator maps to whatever they translate, private space included.
 */

/** Longest target URL accepted. Long enough for any real endpoint. */
const MAX_URL_LENGTH = 2048

export interface EgressClassification {
  blocked: boolean
  /** Why it was refused — safe to show an operator, names no internal host. */
  reason?: string
}

/** One resolved address, in the shape `dns.lookup(..., { all: true })` returns. */
export interface ResolvedAddress {
  address: string
  family: number
}

export type HostResolver = (host: string) => Promise<Array<ResolvedAddress>>

/** How long a lookup may take before the host is treated as not resolving. */
const RESOLVE_TIMEOUT_MS = 5_000

/**
 * Every address a name resolves to, in the resolver's own order, within a
 * deadline. Without one a stalled resolver held a save — or a delivery, and the
 * pump's lease with it — for as long as the system resolver cared to wait.
 */
const defaultResolver: HostResolver = (host) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('DNS lookup timed out'))
    }, RESOLVE_TIMEOUT_MS)
    void dns.promises.lookup(host, { all: true, order: 'verbatim' }).then(
      (addresses) => {
        clearTimeout(timer)
        resolve(addresses)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('DNS lookup failed'))
      },
    )
  })

/**
 * Expand an IPv6 literal to its sixteen bytes.
 *
 * Written rather than string-matched because prefix matching on an IPv6 text
 * form is exactly the class of bug this file exists to avoid: `fe80::1`,
 * `FE80:0:0:0:0:0:0:1` and `fe80:0000::0001` are one address and three
 * different strings.
 */
function ipv6ToBytes(value: string): Uint8Array | null {
  let text = value
  // A zone index (`fe80::1%eth0`) is not part of the address.
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)

  // A trailing dotted quad — the mapped and NAT64 forms — becomes two groups.
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (isIPv4(tail)) {
    const octets = tail.split('.').map(Number)
    const [a = 0, b = 0, c = 0, d = 0] = octets
    const hi = ((a << 8) | b).toString(16)
    const lo = ((c << 8) | d).toString(16)
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  const parse = (part: string): Array<number> | null => {
    if (part === '') return []
    const groups: Array<number> = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
      groups.push(parseInt(group, 16))
    }
    return groups
  }

  const head = parse(halves[0] ?? '')
  const rear = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (!head || !rear) return null

  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - rear.length).fill(0), ...rear]
      : head
  if (groups.length !== 8 || groups.some((g) => g === undefined)) return null

  const bytes = new Uint8Array(16)
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff
    bytes[index * 2 + 1] = group & 0xff
  })
  return bytes
}

/**
 * Whether an IPv4 address is outside the public internet.
 *
 * Numeric range tests, so every spelling of an address that reaches here has
 * already been reduced to four numbers and no text form can slip past.
 */
function classifyIPv4(address: string): EgressClassification {
  const [a = 0, b = 0, c = 0, d = 0] = address.split('.').map(Number)

  if (a === 0) return { blocked: true, reason: 'unspecified address' }
  if (a === 127) return { blocked: true, reason: 'loopback address' }
  if (a === 10) return { blocked: true, reason: 'private address' }
  if (a === 172 && b >= 16 && b <= 31)
    return { blocked: true, reason: 'private address' }
  if (a === 192 && b === 168)
    return { blocked: true, reason: 'private address' }
  // Carrier-grade NAT. Missing from the older guard's range list.
  if (a === 100 && b >= 64 && b <= 127)
    return { blocked: true, reason: 'carrier-grade NAT address' }
  // Link-local, which is where every cloud metadata service lives.
  if (a === 169 && b === 254)
    return { blocked: true, reason: 'link-local address' }
  // Benchmarking. Also missing from the older guard.
  if (a === 198 && (b === 18 || b === 19))
    return { blocked: true, reason: 'benchmarking address' }
  if (a === 192 && b === 0 && c === 0)
    return { blocked: true, reason: 'IETF protocol assignment' }
  if (a === 192 && b === 0 && c === 2)
    return { blocked: true, reason: 'documentation address' }
  if (a === 198 && b === 51 && c === 100)
    return { blocked: true, reason: 'documentation address' }
  if (a === 203 && b === 0 && c === 113)
    return { blocked: true, reason: 'documentation address' }
  if (a >= 224 && a <= 239)
    return { blocked: true, reason: 'multicast address' }
  if (a >= 240) return { blocked: true, reason: 'reserved address' }
  if (a === 255 && b === 255 && c === 255 && d === 255)
    return { blocked: true, reason: 'broadcast address' }

  return { blocked: false }
}

function classifyIPv6(address: string): EgressClassification {
  const bytes = ipv6ToBytes(address)
  if (!bytes) return { blocked: true, reason: 'unparseable address' }

  const [b0 = 0, b1 = 0] = bytes

  // IPv4-mapped (::ffff:0:0/96) — the one shape that genuinely bypasses the
  // older guard. Unwrap and re-test the embedded address, or `::ffff:127.0.0.1`
  // reaches loopback through a check that only knew how to read IPv4.
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0)
  if (mapped && bytes[10] === 0xff && bytes[11] === 0xff) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`
    const inner = classifyIPv4(embedded)
    return inner.blocked
      ? { blocked: true, reason: `IPv4-mapped ${inner.reason}` }
      : { blocked: false }
  }

  // NAT64 (64:ff9b::/96) embeds IPv4 the same way and is live in real networks.
  if (
    b0 === 0x00 &&
    b1 === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`
    const inner = classifyIPv4(embedded)
    return inner.blocked
      ? { blocked: true, reason: `NAT64-embedded ${inner.reason}` }
      : { blocked: false }
  }

  // 64:ff9b:1::/48, the local-use NAT64 prefix. Unlike the well-known prefix
  // above it is not tied to public IPv4 space — an operator maps it to whatever
  // they translate, private networks included — so it is refused, not
  // unwrapped.
  if (
    b0 === 0x00 &&
    b1 === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  )
    return { blocked: true, reason: 'local-use NAT64 address' }

  if (bytes.every((byte) => byte === 0))
    return { blocked: true, reason: 'unspecified address' }
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1)
    return { blocked: true, reason: 'loopback address' }
  // ::/96, the deprecated IPv4-compatible form: `::127.0.0.1`, which a URL
  // parser writes as `[::7f00:1]`. Nothing legitimate uses it, and whether a
  // kernel routes it to the embedded IPv4 host is platform behaviour, not
  // something to rely on — so it is refused rather than unwrapped. `::` and
  // `::1` sit inside it and keep their own reasons above.
  if (bytes.slice(0, 12).every((byte) => byte === 0))
    return { blocked: true, reason: 'IPv4-compatible address' }
  // fc00::/7 — unique local.
  if ((b0 & 0xfe) === 0xfc)
    return { blocked: true, reason: 'unique-local address' }
  // fe80::/10 — link-local.
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80)
    return { blocked: true, reason: 'link-local address' }
  // ff00::/8 — multicast.
  if (b0 === 0xff) return { blocked: true, reason: 'multicast address' }

  return { blocked: false }
}

/**
 * Classify one literal address. Pure, so the whole bypass corpus is a unit test.
 */
export function classifyAddress(address: string): EgressClassification {
  const family = isIP(address)
  if (family === 4) return classifyIPv4(address)
  if (family === 6) return classifyIPv6(address)
  return { blocked: true, reason: 'not an IP address' }
}

export interface ValidateEgressUrlOptions {
  /**
   * Allow `http:`. Off by default: a webhook body carries business facts and a
   * signature over them, and plaintext gives both away. An operator delivering
   * inside their own network can opt in.
   */
  allowInsecure?: boolean
}

/**
 * Validate a target URL at **write** time, before it is stored.
 *
 * Note that `z.string().url()` is not a substitute for this on the Zod version
 * this repository uses: it accepts `file:`, `javascript:`, a loopback address
 * with a database port, and a bracketed IPv6 loopback. A schema must call this
 * rather than marking the field as a URL.
 */
export function validateEgressUrl(
  rawUrl: string,
  options: ValidateEgressUrlOptions = {},
): URL {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new ValidationError(
      `A target URL may be at most ${MAX_URL_LENGTH} characters`,
    )
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ValidationError('That is not a valid URL')
  }

  const allowed = options.allowInsecure ? ['https:', 'http:'] : ['https:']
  if (!allowed.includes(url.protocol)) {
    throw new ValidationError(
      options.allowInsecure
        ? 'A target URL must use http or https'
        : 'A target URL must use https. Plaintext delivery has to be enabled deliberately.',
    )
  }

  // Credentials in a stored URL are a credential in a table the admin API
  // reads, and they would be sent to whatever the host resolves to later.
  if (url.username !== '' || url.password !== '') {
    throw new ValidationError(
      'A target URL must not embed a username or password',
    )
  }

  // An address literal can be judged now, and saying so at write time is much
  // better than a delivery that fails forever with a generic error. A hostname
  // cannot: it is resolved at send time, by `assertPublicHost`.
  const bare =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname
  if (isIP(bare) !== 0) {
    const verdict = classifyAddress(bare)
    if (verdict.blocked) {
      throw new ValidationError(
        `A target URL may not point at a ${verdict.reason}`,
      )
    }
  } else if (isLocalName(bare)) {
    throw new ValidationError(
      'A target URL may not point at a local or internal hostname',
    )
  }

  return url
}

/**
 * Names that resolve inside the deployment by convention rather than by address.
 *
 * Kept as a small write-time courtesy, not a security boundary — the boundary is
 * the numeric check at send time, which catches these whatever they resolve to.
 */
function isLocalName(host: string): boolean {
  const lower = host.toLowerCase()
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  )
}

export class EgressBlockedError extends Error {
  /** The category refused — an operator-safe phrase, never an address. */
  readonly reason: string

  constructor(reason: string) {
    super(`Delivery target resolves to a ${reason}`)
    this.name = 'EgressBlockedError'
    this.reason = reason
  }
}

/**
 * The host could not be resolved at all: no answer, an empty answer, or no
 * answer in time.
 *
 * Deliberately not an `EgressBlockedError`. Nothing is known about the address,
 * so this is no verdict on it — the name may well resolve on the next attempt,
 * and a DNS outage that killed every delivery it touched would turn a
 * minutes-long incident into hours of dead deliveries. A delivery retries it;
 * it refuses only an address it has actually classified.
 */
export class EgressResolutionError extends Error {
  constructor(reason: string) {
    super(`Delivery target is a ${reason}`)
    this.name = 'EgressResolutionError'
  }
}

/**
 * Resolve a host at **send** time and refuse it if *any* returned address is
 * non-public. A host that does not resolve is refused too, as an
 * `EgressResolutionError` rather than a block: see that class.
 *
 * Any, not the first. A hostile name can return one public address and one
 * private one, and a client that tries them in order reaches the private one
 * the moment the public one refuses a connection — so a single private answer
 * condemns the name.
 */
export async function assertPublicHost(
  hostname: string,
  resolver: HostResolver = defaultResolver,
): Promise<void> {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname

  // A literal needs no lookup, and asking DNS about one invites a resolver that
  // answers for addresses.
  if (isIP(bare) !== 0) {
    const verdict = classifyAddress(bare)
    if (verdict.blocked)
      throw new EgressBlockedError(verdict.reason ?? 'blocked address')
    return
  }

  let addresses: Array<ResolvedAddress>
  try {
    addresses = await resolver(bare)
  } catch {
    throw new EgressResolutionError('host that does not resolve')
  }

  if (addresses.length === 0) {
    throw new EgressResolutionError('host that resolves to no address')
  }

  for (const { address } of addresses) {
    const verdict = classifyAddress(address)
    if (verdict.blocked) {
      throw new EgressBlockedError(verdict.reason ?? 'blocked address')
    }
  }
}

/**
 * The write-time half of the send-time check, best-effort: refuse a target
 * whose host resolves to a non-public address *now*, so an operator hears it
 * when saving rather than from a dead delivery later.
 *
 * Best-effort in one direction only. A host that does not resolve yet — a
 * receiver still being deployed, or a DNS hiccup — is accepted, because the
 * send-time check runs on every delivery regardless and is the real boundary;
 * refusing a save over a transient lookup failure would only teach operators to
 * retry until it went through.
 */
export async function assertTargetResolvesPublic(
  url: URL,
  resolver: HostResolver = defaultResolver,
): Promise<void> {
  try {
    await assertPublicHost(url.hostname, resolver)
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      throw new ValidationError(
        `A target URL's host resolves to a ${error.reason}`,
      )
    }
    if (error instanceof EgressResolutionError) return
    throw error
  }
}
