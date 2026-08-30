// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Build the test database's schema.
 *
 * `db:push` against TEST_DATABASE_URL instead of DATABASE_URL. Push rather
 * than migrate on purpose: this is the dev loop, the database is disposable,
 * and CI's Unit Tests job builds its schema the same way — so what runs here
 * is what runs there.
 *
 * The test database needs no seed. Lifecycle rows are seeded by
 * `packages/core/src/__tests__/global-setup.ts` on every run, and everything
 * else a suite needs it builds itself.
 *
 *   createdb -U postgres cascadia_test
 *   npm run test:db:push
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(import.meta.dirname, '..', '.env'), quiet: true })

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl) {
  console.error(
    'TEST_DATABASE_URL is not set. Add it to .env, pointing at a database ' +
      'that exists only for tests:\n\n' +
      '  createdb -U postgres cascadia_test\n' +
      '  TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia_test\n',
  )
  process.exit(1)
}

// drizzle.mjs loads .env itself but does not overwrite a real environment
// variable, so passing DATABASE_URL through here is what redirects the push.
execFileSync('node', [resolve(import.meta.dirname, 'drizzle.mjs'), 'push'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: testUrl },
})
