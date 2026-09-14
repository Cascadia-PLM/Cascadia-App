// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

const UNPARSEABLE = '(unparseable URL)'

/**
 * A connection URL fit for a log line: its password replaced by `***`.
 *
 * Broker and database URLs carry the password inline
 * (`amqp://user:password@host/vhost`), so logging one as written copies the
 * secret into every log sink. WHATWG parsing exposes `username` and `password`
 * for non-special schemes such as `amqp:` and `postgresql:` too, so nothing here
 * is scheme-specific.
 *
 * A URL without a password comes back exactly as given. Anything else this
 * cannot account for comes back as `(unparseable URL)`, never as the raw string
 * — and that includes a URL which parses but has an `@` after its host. That is
 * what a password containing an unencoded `/`, `?` or `#` looks like:
 * `amqp://user:1234/abcd@host` reads as host `user`, port `1234`, and a path
 * holding the rest of the secret, so the parse cannot be trusted to have found
 * the password.
 */
export function redactUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw)
    if (`${url.pathname}${url.search}${url.hash}`.includes('@')) {
      return UNPARSEABLE
    }
    if (!url.password) return raw
    url.password = '***'
    return url.href
  } catch {
    return UNPARSEABLE
  }
}
