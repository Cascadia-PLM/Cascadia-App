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

export default async function globalSetup() {
  // vitest.config.ts loads .env before this runs, so an absent DATABASE_URL
  // means there is no .env entry and nothing exported in the shell. Never
  // fall back to an implicit database: on a machine with more than one
  // Cascadia checkout, a guessed default silently reads and writes another
  // checkout's data.
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Tests connect to a real Postgres database ' +
        'and refuse to guess which one. Copy .env.example to .env and point ' +
        'DATABASE_URL at your development database, or export DATABASE_URL.',
    )
  }

  // Set test-specific environment variables
  process.env.NODE_ENV = 'test'

  // Every item type has a lifecycle — services have no name-literal
  // fallbacks left, so the rows must exist before any worker runs. Seeded
  // once here (main process, before workers fork), first-writer-wins, so a
  // suite's deliberate overrides and an app-seeded database's richer rows
  // both survive.
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    await seedDefaultLifecycles(drizzle(client, { schema }))
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
    return '(unparseable DATABASE_URL)'
  }
}

export function teardown() {
  // Global cleanup if needed
  console.log('\n🧹 Test suite completed, cleaning up...\n')
}
