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
 *
 * **Verification is table presence only.** The live `pg_tables` set is compared
 * against the tables the composed schema declares; columns, constraints,
 * indexes and enum values are never compared. A database that has every table
 * but is short a column the baseline adds therefore passes this check and
 * fails later, at the first migration that assumes that column. That is why
 * "check out v0.5.0 and run `db:push` once" is a *precondition* of stamping
 * rather than an optimization — nothing here stands in for it.
 *
 * Stamping itself is one transaction: either every journal entry is recorded
 * or none is. A crash mid-stamp used to leave a partial journal that the
 * already-stamped guard below then read as "done", so the operator's next
 * `db:migrate` replayed migrations the pushed schema already satisfied and
 * aborted mid-upgrade. Partial journals are now unproducible here, and one
 * left behind by an older run is detected rather than trusted.
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
      'db:baseline. For a fresh database, just run `npm run db:migrate`.' +
      '\n\nNote that passing this check is not proof the schema matches: only ' +
      'table presence is compared, never columns, constraints or indexes. ' +
      'Bringing the database to the baseline schema first — check out v0.5.0, ' +
      'run db:push once — is a precondition of stamping, not a shortcut.',
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
const expectedCount = journal.entries.length

// Three outcomes, deliberately distinguished. This guard used to read *any*
// non-zero count as "already stamped", which made a partial journal — the
// residue of a stamp that lost its connection mid-loop, back when stamping was
// not transactional — indistinguishable from a finished one.
// A journal shorter than the tree's is far more often neither: an install
// that simply has not been upgraded yet, whose answer is db:migrate.
if (appliedCount === expectedCount) {
  console.log(
    `Journal already has all ${appliedCount} entr${appliedCount === 1 ? 'y' : 'ies'} — ` +
      'this database is already stamped. Nothing to do.',
  )
  process.exit(0)
}
if (appliedCount > expectedCount) {
  console.error(
    `REFUSING to stamp: drizzle.__drizzle_migrations holds ${appliedCount} row(s), ` +
      `more than the ${expectedCount} entr${expectedCount === 1 ? 'y' : 'ies'} the ` +
      'journal in this tree defines. The database has been migrated past the ' +
      'code checked out here. Check out the version it was migrated to (or a ' +
      'newer one) and upgrade from there; do not stamp.',
  )
  process.exit(1)
}
if (appliedCount > 0) {
  const pending = expectedCount - appliedCount
  const plural = pending === 1 ? '' : 's'
  console.error(
    `Nothing to stamp: drizzle.__drizzle_migrations holds ${appliedCount} of the ` +
      `${expectedCount} entries the journal defines, so ${pending} migration${plural} ` +
      'never ran. That is the ordinary state of a database one or more ' +
      'releases behind the tree checked out here — not damage, and not ' +
      'something to stamp: db:baseline exists for a database whose journal ' +
      'is empty, and this one has a journal already.' +
      `\n\nRun \`npm run db:migrate\` — it applies the ${pending} ` +
      `migration${plural} the journal is missing. Drizzle wraps all pending ` +
      'migrations in one transaction, so a database left part-way through a ' +
      'migrate is not a state that can exist: either they all applied, or ' +
      'the journal still reads exactly as it does now.' +
      '\n\nDo NOT delete these rows to get a stamp out of this script. ' +
      'Stamping records migrations as applied without running them, so an ' +
      `emptied journal would be re-stamped in full, the ${pending} unrun ` +
      `migration${plural} would be recorded as done, db:migrate would no-op ` +
      'forever, and nothing would ever report the gap. That holds even if ' +
      'these rows are the residue of a stamp that died mid-loop, back before ' +
      'stamping was transactional: db:migrate is still the way forward, ' +
      'because it applies what the journal is missing and fails loudly — ' +
      'never silently — if the live schema already has it.',
  )
  process.exit(1)
}

// Hash every file before opening the transaction: a missing or unreadable
// .sql file should abort having written nothing, not roll a write back.
const stamps = [...journal.entries]
  .sort((a, b) => a.idx - b.idx)
  .map((entry) => ({
    tag: entry.tag,
    when: entry.when,
    hash: createHash('sha256')
      .update(readFileSync(resolve(drizzleDir, `${entry.tag}.sql`)))
      .digest('hex'),
  }))

// One transaction for the whole journal. Half a journal is the single state
// this script must never leave behind — see the guard above for what it costs.
await db.transaction(async (tx) => {
  for (const stamp of stamps) {
    await tx.execute(sql`
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES (${stamp.hash}, ${stamp.when})
    `)
  }
})

for (const stamp of stamps) {
  console.log(`  ✓ stamped ${stamp.tag}`)
}

console.log(
  '\nBaseline stamped. This database now upgrades with `npm run db:migrate` — ' +
    'db:push is no longer the path for it.',
)
process.exit(0)
