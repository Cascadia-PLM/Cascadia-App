// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Who is this request from, and how much of that answer did the caller write?
 *
 * `X-Forwarded-For` is a header. Anyone can send one, and a proxy that appends
 * rather than replaces will faithfully carry whatever the client invented in
 * front of the address it actually saw. Reading the *leftmost* entry — which is
 * what this module replaced — therefore hands the caller their own identity:
 * they can rotate it per request to mint a fresh rate-limit bucket every time
 * (the login budget stops existing), or pin it to a neighbour's address to
 * spend someone else's, and every `auth_events.ip_address` row records a value
 * the attacker chose.
 *
 * The only address nobody can forge is the TCP peer — but `apiHandler` sees a
 * fetch `Request`, which has no socket on it. `adapt()` is the one place a Hono
 * `Context` and that `Request` exist together, so it records the peer here (see
 * `recordSocketAddress`) and `resolveClientIp` reads it back out.
 *
 * How many forwarded entries to believe is deployment configuration, not
 * something the code can infer: it is exactly the number of proxies in front of
 * this process, and only the operator knows it.
 *
 *   TRUSTED_PROXY_COUNT=0  (default) — trust no forwarded header at all; the
 *                          peer address is the answer.
 *   TRUSTED_PROXY_COUNT=N  — N proxies each appended the address they saw, so
 *                          the Nth entry counted from the right is the address
 *                          the innermost trusted proxy observed, and everything
 *                          to its left is caller-supplied noise.
 *
 * Defaulting to 0 fails closed: an unconfigured deployment behind a proxy
 * collapses onto that proxy's address — one shared bucket, so one abusive
 * client can spend the budget for everyone behind it — rather than handing out
 * a bucket per forged header. That is the safe direction, and setting the real
 * hop depth fixes it (`docs/orchestration/configuration.md`).
 */

/** Recorded when nothing trustworthy identifies the caller. */
export const UNKNOWN_CLIENT_IP = 'unknown'

/**
 * `auth_events.ip_address` and `api_key_events.ip_address` are `varchar(45)` —
 * the widest an IPv6 literal gets. A header entry longer than that is not an
 * address, and letting one through would turn an audit write into a 500.
 */
const MAX_ADDRESS_LENGTH = 45

/**
 * Peer address per in-flight request.
 *
 * Weak because the key is the request itself: the entry dies with it, and
 * nothing has to remember to clean up. Populated only by `adapt()`, so a
 * `Request` built anywhere else — a unit test, a handler invoked directly —
 * simply has no entry, and resolution falls back to `UNKNOWN_CLIENT_IP`.
 */
const socketAddresses = new WeakMap<Request, string>()

/**
 * Record the TCP peer address for a request.
 *
 * Called once per request from `adapt()`. An absent address (a runtime that
 * exposes no connection info) is a no-op rather than a stored placeholder, so
 * "we never knew" and "we knew it was nothing" stay the same state.
 */
export function recordSocketAddress(
  request: Request,
  address: string | undefined,
): void {
  if (!address) return
  socketAddresses.set(request, address)
}

/** Last `TRUSTED_PROXY_COUNT` value warned about, so a bad one warns once. */
let warnedValue: string | null = null

/**
 * How many forwarded hops this deployment vouches for.
 *
 * Anything that is not a non-negative integer is treated as 0 and warned about:
 * a typo in a deployment env must not silently widen trust, and the fail-closed
 * direction is to believe no header at all.
 */
function trustedProxyCount(): number {
  const raw = process.env.TRUSTED_PROXY_COUNT
  if (!raw) return 0

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    if (warnedValue !== raw) {
      warnedValue = raw
      console.warn(
        `[client-ip] Ignoring TRUSTED_PROXY_COUNT="${raw}" — expected a ` +
          'non-negative integer; trusting no forwarded header',
      )
    }
    return 0
  }
  return parsed
}

/**
 * Could this token be an address at all?
 *
 * Not an inet parser, and not trying to be — the job is to refuse a value that
 * is plainly not an address before it becomes a rate-limit key or an audit row,
 * so junk in a header falls back to the peer address instead of being recorded
 * as fact. Accepts IPv4, IPv6 and IPv4-mapped IPv6 forms; rejects anything with
 * a character an address cannot contain, and anything too long to store.
 */
function isAddressLike(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ADDRESS_LENGTH &&
    /^[0-9a-f.:]+$/i.test(value) &&
    (value.includes('.') || value.includes(':'))
  )
}

/**
 * The address this request came from, believing only what the deployment says
 * is believable.
 *
 * Returns `UNKNOWN_CLIENT_IP` when there is nothing trustworthy to report —
 * which is the same worst case the header-only predecessor had, and is a
 * shared bucket rather than an unbounded supply of private ones.
 */
export function resolveClientIp(request: Request): string {
  const socket = socketAddresses.get(request)
  const depth = trustedProxyCount()

  if (depth > 0) {
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) {
      const hops = forwarded
        .split(',')
        .map((hop) => hop.trim())
        .filter(Boolean)
      // Count back from the right: hops[len - 1] was written by the proxy we
      // are talking to, hops[len - 2] by the one behind it, and so on. A header
      // with fewer entries than `depth` is short of what the trusted chain
      // would have produced, so it is not usable — the negative index reads
      // undefined and we fall through to the peer address rather than to the
      // leftmost, caller-chosen entry.
      const candidate = hops[hops.length - depth]
      if (candidate !== undefined && isAddressLike(candidate)) return candidate
    }
  }

  return socket ?? UNKNOWN_CLIENT_IP
}
