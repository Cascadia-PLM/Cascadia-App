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
 *   npm run db:baseline -- --check            # verify without writing
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
import { sql } from 'drizzle-orm'
import { db, describeConnection } from '../packages/core/src/lib/db/index.ts'
import { resolveApp } from './edition.mjs'

// Resolved at runtime rather than imported by name — same reasoning as
// truncate-all.ts: this script serves whichever edition the tree contains.
const app = resolveApp()
const drizzleDir = resolve(import.meta.dirname, '..', 'apps', app, 'drizzle')
const checkOnly = process.argv.includes('--check')

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

interface SnapshotTable {
  name: string
  schema: string
  columns: Record<string, { name: string }>
}

interface DrizzleSnapshot {
  tables: Record<string, SnapshotTable>
}

// Same defensive unwrap as truncate-all.ts — the driver returns an
// array-like RowList.
function asRows<T>(result: unknown): Array<T> {
  return Array.isArray(result)
    ? (result as Array<T>)
    : ((result as { rows?: Array<T> }).rows ?? [])
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

const sortedEntries = [...journal.entries].sort((a, b) => a.idx - b.idx)
const baseline = sortedEntries[0]!
if (baseline.idx !== 0 || !baseline.tag.startsWith('0000_')) {
  console.error(
    'REFUSING to stamp: the first migration is not an unambiguous 0000 baseline.',
  )
  process.exit(1)
}

const baselineFile = resolve(drizzleDir, `${baseline.tag}.sql`)
const baselineSql = readFileSync(baselineFile, 'utf8')
const baselineHash = createHash('sha256').update(baselineSql).digest('hex')
const snapshotName = `${String(baseline.idx).padStart(4, '0')}_snapshot.json`
let baselineSnapshot: DrizzleSnapshot
try {
  baselineSnapshot = JSON.parse(
    readFileSync(resolve(drizzleDir, 'meta', snapshotName), 'utf8'),
  ) as DrizzleSnapshot
} catch {
  console.error(
    `REFUSING to stamp: cannot read the baseline snapshot meta/${snapshotName}.`,
  )
  process.exit(1)
}

console.log(`Target database: ${describeConnection()}  (edition: ${app})`)

// Idempotency comes before baseline-shape validation: a database that was
// already stamped and then migrated is expected to be newer than 0000.
const journalTable = asRows<{ tableName: string | null }>(
  await db.execute<{ tableName: string | null }>(sql`
    SELECT to_regclass('drizzle.__drizzle_migrations')::text AS "tableName"
  `),
)
let applied: Array<{ hash: string }> = []
if (journalTable[0]?.tableName) {
  applied = asRows<{ hash: string }>(
    await db.execute<{ hash: string }>(sql`
      SELECT hash
      FROM "drizzle"."__drizzle_migrations"
      ORDER BY created_at, id
    `),
  )
}

if (applied.some((entry) => entry.hash === baselineHash)) {
  console.log(`Baseline ${baseline.tag} is already recorded. Nothing to do.`)
  process.exit(0)
}

if (applied.length > 0) {
  console.error(
    `REFUSING to stamp: the migration journal has ${applied.length} ` +
      `${applied.length === 1 ? 'entry' : 'entries'}, but none matches ` +
      `the ${baseline.tag} baseline. Resolve the journal inconsistency manually.`,
  )
  process.exit(1)
}

// Verify against the baseline snapshot, not today's composed schema. Once
// post-baseline migrations add tables or columns, the current schema is
// intentionally newer than a database that is ready to be stamped.
const expectedTableColumns = new Map<string, Set<string>>()
for (const table of Object.values(baselineSnapshot.tables)) {
  if (table.schema && table.schema !== 'public') continue
  expectedTableColumns.set(
    table.name,
    new Set(Object.values(table.columns).map((column) => column.name)),
  )
}
const expectedTables = [...expectedTableColumns.keys()]
if (expectedTables.length === 0) {
  console.error(
    `REFUSING to stamp: meta/${snapshotName} contains no public tables.`,
  )
  process.exit(1)
}

const liveRows = asRows<{ tableName: string; columnName: string }>(
  await db.execute<{ tableName: string; columnName: string }>(sql`
    SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `),
)
const liveTableColumns = new Map<string, Set<string>>()
for (const row of liveRows) {
  const columns = liveTableColumns.get(row.tableName) ?? new Set<string>()
  columns.add(row.columnName)
  liveTableColumns.set(row.tableName, columns)
}
const liveTables = new Set(liveTableColumns.keys())

const missing = expectedTables.filter((t) => !liveTables.has(t))
if (missing.length > 0) {
  console.error(
    `REFUSING to stamp: the live schema is missing ${missing.length} table(s) ` +
      'the baseline creates:\n  ' +
      missing.join('\n  ') +
      '\n\nThis database is not at the baseline. Check out the release that ' +
      'introduced the baseline, bring the database to that exact schema, and ' +
      'then re-run db:baseline. For a fresh database, just run `npm run db:migrate`.',
  )
  process.exit(1)
}

const columnMismatches: Array<string> = []
for (const [table, expectedColumns] of expectedTableColumns) {
  const liveColumns = liveTableColumns.get(table)!
  const missingColumns = [...expectedColumns].filter(
    (column) => !liveColumns.has(column),
  )
  const extraColumns = [...liveColumns].filter(
    (column) => !expectedColumns.has(column),
  )
  if (missingColumns.length > 0) {
    columnMismatches.push(`${table}: missing ${missingColumns.join(', ')}`)
  }
  if (extraColumns.length > 0) {
    columnMismatches.push(`${table}: unexpected ${extraColumns.join(', ')}`)
  }
}
if (columnMismatches.length > 0) {
  console.error(
    'REFUSING to stamp: the live schema does not exactly match the baseline ' +
      'columns:\n  ' +
      columnMismatches.join('\n  ') +
      '\n\nDo not stamp a schema that already contains later migration changes. ' +
      'Restore or upgrade it using the migration journal that produced it.',
  )
  process.exit(1)
}

const extra = [...liveTables].filter(
  (t) => !expectedTables.includes(t) && t !== '__drizzle_migrations',
)
const laterCreatedTables = new Set(
  sortedEntries.slice(1).flatMap((entry) => {
    const migrationSql = readFileSync(
      resolve(drizzleDir, `${entry.tag}.sql`),
      'utf8',
    )
    return Array.from(
      migrationSql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"([^"]+)"/g),
      (match) => match[1]!,
    )
  }),
)
const alreadyPresentLaterTables = extra.filter((table) =>
  laterCreatedTables.has(table),
)
if (alreadyPresentLaterTables.length > 0) {
  console.error(
    'REFUSING to stamp: the live schema already contains table(s) introduced ' +
      `after the baseline (${alreadyPresentLaterTables.join(', ')}).`,
  )
  process.exit(1)
}
if (extra.length > 0) {
  console.warn(
    `Note: ${extra.length} table(s) exist that the baseline does not define ` +
      `(${extra.join(', ')}). They are left alone.`,
  )
}

if (checkOnly) {
  console.log(
    `\n✓ Database matches ${baseline.tag}. Run npm run db:baseline to stamp it, ` +
      'then npm run db:migrate.',
  )
  process.exit(0)
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

// Stamp only 0000. Every later migration must remain pending so db:migrate
// executes its SQL instead of merely believing it was already applied.
await db.execute(sql`
  INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
  VALUES (${baselineHash}, ${baseline.when})
`)
console.log(`  ✓ stamped ${baseline.tag}`)

console.log(
  '\nBaseline stamped. This database now upgrades with `npm run db:migrate` — ' +
    'db:push is no longer the path for it.',
)
process.exit(0)
