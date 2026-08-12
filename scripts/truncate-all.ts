// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Truncate all tables to reset the database for fresh seeding.
 *
 * Covers every `pgTable()` in the edition's composed schema — core's and every
 * module's — because it reads that schema rather than restating it.
 *
 * Queries pg_tables to skip any that haven't been migrated yet,
 * so newly added schema files won't break the reset.
 */
import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { db, describeConnection } from '../packages/core/src/lib/db/index.ts'
import { resolveApp } from './edition.mjs'

// Resolved at runtime rather than imported by name: naming the enterprise app
// outright breaks a core-only tree, which is what `npm run core:standalone`
// builds. This script serves whichever edition the tree actually contains.
const app = resolveApp()
const schema = (await import(`../apps/${app}/src/modules.schema.ts`)) as Record<
  string,
  unknown
>

console.log(`Target database: ${describeConnection()}  (edition: ${app})`)

/**
 * Every table this edition owns, derived from the composed schema rather than
 * listed by hand.
 *
 * It used to be a hand-maintained array of ~110 names with a comment asking you
 * to remember. Forgetting left rows behind after `db:reset`, and silently: a
 * name missing from the list looks exactly like a table that has not been
 * migrated yet, which this script is designed to skip without complaint.
 * Reading the schema means a new table is covered the moment it exists.
 */
const ALL_TABLES = Object.values(schema)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))

// Query which of our tables actually exist in the database
// (some schema tables may not have been migrated yet)
const arrayLiteral = `ARRAY[${ALL_TABLES.map((t) => `'${t}'`).join(',')}]`
const existing = await db.execute<{ tablename: string }>(
  sql.raw(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${arrayLiteral})`,
  ),
)
const rows = Array.isArray(existing) ? existing : ((existing as any).rows ?? [])
const existingSet = new Set(rows.map((r: any) => r.tablename))
const toTruncate = ALL_TABLES.filter((t) => existingSet.has(t))
const skipped = ALL_TABLES.filter((t) => !existingSet.has(t))

if (skipped.length > 0) {
  console.log(
    `Skipping ${skipped.length} unmigrated tables: ${skipped.join(', ')}`,
  )
}

if (toTruncate.length === 0) {
  console.log('No tables to truncate')
  process.exit(0)
}

console.log(`Truncating ${toTruncate.length} tables...`)
await db.execute(sql.raw(`TRUNCATE ${toTruncate.join(', ')} CASCADE`))

console.log('✓ All tables truncated')
process.exit(0)
