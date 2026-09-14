// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { describeDatabaseUrl } from '@test/global-setup'
import { describeConnection } from './index'

const SECRET = 's3cr3t-hunter2'

// Both describers print which database is about to be touched — the container
// boot log, the seed and reset scripts, the test suite's banner. Whatever URL
// they are handed, no piece of its password may come back. Pieces, because a
// malformed URL splits a password across the port and the path, and printing
// either half is a leak.
const DESCRIBERS = [
  { name: 'describeConnection', describeUrl: describeConnection },
  { name: 'describeDatabaseUrl', describeUrl: describeDatabaseUrl },
]

const CASES = [
  {
    name: 'a well-formed URL',
    password: SECRET,
    url: `postgresql://postgres:${SECRET}@db:5432/app`,
  },
  {
    name: 'a percent-encoded password',
    password: `8642/${SECRET}?#@`,
    url: `postgresql://postgres:${encodeURIComponent(`8642/${SECRET}?#@`)}@db:5432/app`,
  },
  {
    name: 'an unencoded /',
    password: `8642/${SECRET}`,
    url: `postgresql://postgres:8642/${SECRET}@db:5432/app`,
  },
  {
    name: 'a password starting with /',
    password: `/${SECRET}`,
    url: `postgresql://postgres:/${SECRET}@db:5432/app`,
  },
  {
    name: 'an unencoded ?',
    password: `8642?${SECRET}`,
    url: `postgresql://postgres:8642?${SECRET}@db:5432/app`,
  },
  {
    name: 'an unencoded #',
    password: `8642#${SECRET}`,
    url: `postgresql://postgres:8642#${SECRET}@db:5432/app`,
  },
  {
    name: 'an unencoded @',
    password: `${SECRET}@${SECRET}`,
    url: `postgresql://postgres:${SECRET}@${SECRET}@db:5432/app`,
  },
  {
    name: 'an unparseable port',
    password: `${SECRET}/${SECRET}`,
    url: `postgresql://postgres:${SECRET}/${SECRET}@db:5432/app`,
  },
  {
    name: 'no // after the scheme',
    password: SECRET,
    url: `postgresql:postgres:${SECRET}@db:5432/app`,
  },
]

describe.each(DESCRIBERS)('$name', ({ describeUrl }) => {
  it.each(CASES)('never prints the password: $name', ({ password, url }) => {
    const described = describeUrl(url)
    for (const piece of password.split(/[/?#@]/).filter(Boolean)) {
      expect(described).not.toContain(piece)
    }
  })

  it('still names the target of a well-formed URL', () => {
    expect(describeUrl(`postgresql://postgres:${SECRET}@db:5432/app`)).toBe(
      'db:5432/app',
    )
  })
})
