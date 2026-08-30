// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Global Setup for Vitest
 *
 * This file runs once before all test files.
 * Use for one-time setup like database connections or environment validation.
 */

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../lib/db/schema'
import { seedDefaultLifecycles } from '../lib/items/default-lifecycles'
import { seedBuiltInRoles } from './fixtures/users'

export default async function globalSetup() {
  // A separate database from DATABASE_URL, required rather than derived.
  //
  // The suite does not only read: it truncates, it seeds lifecycles, and
  // several suites commit global config rows (item_type_configs is one row per
  // item type, shared by every test in the run). Pointed at the development
  // database — which it was, by default — a test run quietly rewrites the data
  // you were working with.
  //
  // vitest.config.ts loads .env before this runs, so an absent value means
  // there is no .env entry and nothing exported. Never fall back and never
  // guess: deriving `${dev}_test` would still be a database nobody chose, and
  // on a machine with more than one Cascadia checkout the guess lands in
  // another checkout's data.
  const databaseUrl = process.env.TEST_DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      [
        'TEST_DATABASE_URL is not set. The test suite writes — it truncates',
        'tables and commits shared config rows — so it runs against its own',
        'database and refuses to guess which one.',
        '',
        '  createdb -U postgres cascadia_test',
        '  npm run test:db:push',
        '',
        'Then add to .env:',
        '',
        '  TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia_test',
        '',
        '(Working in a git worktree? .env is gitignored — copy it in.)',
      ].join('\n'),
    )
  }

  // Set test-specific environment variables
  process.env.NODE_ENV = 'test'

  // Point the application's own db module at the test database too.
  //
  // packages/core/src/lib/db reads DATABASE_URL at import time and builds a
  // client from it. TestDatabase swaps that client out via setTestDb(), but
  // anything importing the module before a suite calls setup() — or any code
  // reaching for the global handle rather than the injected one — would still
  // hold a client pointed at the development database. globalSetup runs in the
  // main process before the workers fork, so they inherit this.
  process.env.DATABASE_URL = databaseUrl

  // Every item type has a lifecycle — services have no name-literal
  // fallbacks left, so the rows must exist before any worker runs. Seeded
  // once here (main process, before workers fork), first-writer-wins, so a
  // suite's deliberate overrides and an app-seeded database's richer rows
  // both survive.
  //
  // The built-in roles go with them, and for a sharper reason: `roles.name` is
  // unique, so every suite that inserted one inside its own rolled-back
  // transaction was queuing on that index behind every other suite doing the
  // same. Different suites want different roles in different orders, which is
  // a deadlock — and it showed as 9 to 12 failures per full run, in a
  // different set of tests each time.
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    const db = drizzle(client, { schema })
    await seedDefaultLifecycles(db)
    await seedBuiltInRoles(db)
  } finally {
    await client.end()
  }

  // Log test configuration
  console.log('\n🧪 Test Environment Configuration:')
  console.log(`   Database: ${describeDatabaseUrl(databaseUrl)}`)
  console.log(`   Node ENV: ${process.env.NODE_ENV}`)
  console.log('')
}

/** Connection target for logging, with credentials stripped. */
function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return '(unparseable TEST_DATABASE_URL)'
  }
}

export function teardown() {
  // Global cleanup if needed
  console.log('\n🧹 Test suite completed, cleaning up...\n')
}
