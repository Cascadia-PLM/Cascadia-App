// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { redactUrlCredentials } from './redact-url'

const SECRET = 's3cr3t-hunter2'

describe('redactUrlCredentials', () => {
  it('replaces the password and keeps the rest of the URL', () => {
    expect(
      redactUrlCredentials(`amqp://cascadia:${SECRET}@localhost:5673/cascadia`),
    ).toBe('amqp://cascadia:***@localhost:5673/cascadia')
  })

  it('returns a URL without a password exactly as given', () => {
    for (const url of [
      'amqp://localhost:5672',
      'amqp://guest@broker:5672/vhost',
      'https://example.com',
    ]) {
      expect(redactUrlCredentials(url)).toBe(url)
    }
  })

  // The invariant the helper exists for: whatever it is handed, the password is
  // not in what comes back — least of all when the input is malformed.
  it.each([
    {
      name: 'a percent-encoded password',
      url: `postgresql://u:${encodeURIComponent(`${SECRET}/#?`)}@db:5432/app`,
    },
    {
      name: 'an unencoded @ in the password',
      url: `amqp://u:${SECRET}@x@host`,
    },
    {
      name: 'an unencoded / in the password',
      url: `amqp://u:1/${SECRET}@host`,
    },
    { name: 'an unparseable URL', url: `amqp://u:${SECRET}@host:no-port` },
    { name: 'no // after the scheme', url: `amqp:u:${SECRET}@host` },
  ])('never returns the password: $name', ({ url }) => {
    expect(redactUrlCredentials(url)).not.toContain(SECRET)
  })
})
