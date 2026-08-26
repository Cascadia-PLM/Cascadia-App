// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Stamp the committed migration baseline as already applied — without
 * executing it.
 *
 * Every install created before v0.5 got its schema from `db:push`, which
 * writes no migration journal. Running `db:migrate` against such a database
 * would replay `0000_*.sql` from the top, try to CREATE TABLE over live
 * tables, and fail — or worse, partially apply. This script is the bridge:
 * it verifies the live schema already *is* the baseline's schema, then
 * records the baseline in drizzle's journal so `db:migrate` starts from the
 * first post-baseline migration.
 *
 * Run once per pre-0.5 database, then use `db:migrate` forever after:
 *
 *   npm run db:baseline                       # enterprise tree
 *   CASCADIA_APP=cascadia npm run db:baseline # community tree
 *
 * In Docker: docker exec <app-container> node_modules/.bin/tsx scripts/db-baseline.ts
 *
 * Refuses loudly when the live schema is missing tables the baseline
 * creates — that means the database is not actually at the baseline and
 * stamping would only defer the failure to the first real migration.
 * Fresh installs never need this: `db:migrate` on an empty database applies
 * the baseline itself, journal included.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { db, describeConnection } from '../packages/core/src/lib/db/index.ts'
import { resolveApp } from './edition.mjs'

// Resolved at runtime rather than imported by name — same reasoning as
// truncate-all.ts: this script serves whichever edition the tree contains.
const app = resolveApp()
const drizzleDir = resolve(import.meta.dirname, '..', 'apps', app, 'drizzle')

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

let journal: { entries: Array<JournalEntry> }
try {
  journal = JSON.parse(
    readFileSync(resolve(drizzleDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<JournalEntry> }
} catch {
  console.error(
    `No migration journal at apps/${app}/drizzle/meta/_journal.json — ` +
      'nothing to stamp. Baselines are minted at release time via db:generate.',
  )
  process.exit(1)
}

if (journal.entries.length === 0) {
  console.error('Migration journal is empty — nothing to stamp.')
  process.exit(1)
}

console.log(`Target database: ${describeConnection()}  (edition: ${app})`)

// The composed schema is the authority on what the baseline creates —
// reading it (rather than parsing SQL) is the same choice truncate-all.ts
// makes, and for the same reason: it cannot drift from the code.
const schema = (await import(`../apps/${app}/src/modules.schema.ts`)) as Record<
  string,
  unknown
>
const expectedTables = Object.values(schema)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))

// Same defensive unwrap as truncate-all.ts — the driver returns an
// array-like RowList.
function asRows<T>(result: unknown): Array<T> {
  return Array.isArray(result)
    ? (result as Array<T>)
    : ((result as { rows?: Array<T> }).rows ?? [])
}

const liveRows = asRows<{ tablename: string }>(
  await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  ),
)
const liveTables = new Set(liveRows.map((r) => r.tablename))

const missing = expectedTables.filter((t) => !liveTables.has(t))
if (missing.length > 0) {
  console.error(
    `REFUSING to stamp: the live schema is missing ${missing.length} table(s) ` +
      'the baseline creates:\n  ' +
      missing.join('\n  ') +
      '\n\nThis database is not at the baseline. For a database kept current ' +
      'with db:push, run `npm run db:push` once to catch it up, then re-run ' +
      'db:baseline. For a fresh database, just run `npm run db:migrate`.',
  )
  process.exit(1)
}

const extra = [...liveTables].filter(
  (t) => !expectedTables.includes(t) && t !== '__drizzle_migrations',
)
if (extra.length > 0) {
  console.warn(
    `Note: ${extra.length} table(s) exist that the schema does not define ` +
      `(${extra.join(', ')}). They are left alone.`,
  )
}

// The exact DDL drizzle's migrator uses, so a stamped database is
// indistinguishable from one migrated from scratch.
await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`)
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )
`)

const applied = asRows<{ count: string }>(
  await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
  ),
)
const appliedCount = Number(applied[0]?.count ?? '0')
if (appliedCount > 0) {
  console.log(
    `Journal already has ${appliedCount} entr${appliedCount === 1 ? 'y' : 'ies'} — ` +
      'this database is already stamped. Nothing to do.',
  )
  process.exit(0)
}

for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
  const file = resolve(drizzleDir, `${entry.tag}.sql`)
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  await db.execute(sql`
    INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
    VALUES (${hash}, ${entry.when})
  `)
  console.log(`  ✓ stamped ${entry.tag}`)
}

console.log(
  '\nBaseline stamped. This database now upgrades with `npm run db:migrate` — ' +
    'db:push is no longer the path for it.',
)
process.exit(0)
