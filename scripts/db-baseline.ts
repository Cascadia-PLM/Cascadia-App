// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Record the committed migrations a database already satisfies as applied —
 * without executing them.
 *
 * Every install created before v0.5 got its schema from `db:push`, which
 * writes no migration journal. Running `db:migrate` against such a database
 * would replay `0000_*.sql` from the top, try to CREATE TABLE over live
 * tables, and fail — or worse, partially apply. This script is the bridge: it
 * works out which committed migrations the live schema *already* satisfies,
 * records exactly those, and leaves the rest for `db:migrate` to apply for
 * real.
 *
 *   npm run db:baseline                       # enterprise tree
 *   CASCADIA_APP=cascadia npm run db:baseline # community tree
 *   npm run db:baseline -- --check            # report only, write nothing
 *
 * In Docker: docker exec <app-container> node_modules/.bin/tsx scripts/db-baseline.ts
 *
 * Fresh installs never need this: `db:migrate` on an empty database applies
 * the baseline itself, journal included.
 *
 * ## Why the position is measured rather than assumed
 *
 * Drizzle's migrator does not check migrations off one at a time. It reads the
 * single newest row in `drizzle.__drizzle_migrations` and applies every
 * migration whose folder timestamp is greater than it:
 *
 *     select id, hash, created_at from drizzle.__drizzle_migrations
 *       order by created_at desc limit 1
 *     ... if (!last || Number(last.created_at) < migration.folderMillis) apply
 *
 * (`drizzle-orm/pg-core/dialect.js`, `PgDialect.migrate`.) The journal is a
 * high-water mark, not a set. Recording a migration whose SQL never ran does
 * not merely mislabel one row — it moves the mark past that migration for
 * good. `db:migrate` then reports success having applied nothing, and the
 * columns and constraints it skipped surface much later as application errors
 * nobody connects back to the upgrade.
 *
 * So this script does not take the operator's word for where the database
 * sits. It compares the live schema against the snapshot drizzle commits
 * beside every migration, and records only the prefix that actually matches.
 * A database one migration short of the tree gets that one migration left
 * pending, not stamped over.
 *
 * ## What is compared
 *
 * Table names, column names and their nullability, and the names of indexes,
 * foreign keys, unique constraints and check constraints — against
 * `meta/NNNN_snapshot.json`, which is drizzle's own record of what the schema
 * looked like at that migration.
 *
 * Primary keys are excluded on purpose: drizzle names composite ones and
 * leaves single-column ones for Postgres to name, so the two sides disagree by
 * construction rather than by drift. Column types, defaults and collations are
 * not compared either. What remains is enough to tell any two committed
 * migrations apart — `db:check-baseline` proves that on every migration in the
 * tree, so a future migration that this comparison could not distinguish fails
 * CI rather than being silently mis-stamped here.
 *
 * Objects no snapshot mentions — a reporting table someone added by hand — are
 * reported and then ignored. They say nothing about which migration the
 * database is at, which is the only question being asked.
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

interface SnapshotColumn {
  name: string
  notNull?: boolean
}

interface SnapshotTable {
  name: string
  schema: string
  columns: Record<string, SnapshotColumn>
  indexes?: Record<string, unknown>
  foreignKeys?: Record<string, unknown>
  uniqueConstraints?: Record<string, unknown>
  checkConstraints?: Record<string, unknown>
}

interface SnapshotEnum {
  name: string
  schema?: string
  values: Array<string>
}

interface DrizzleSnapshot {
  tables: Record<string, SnapshotTable>
  enums?: Record<string, SnapshotEnum>
}

function die(message: string): never {
  console.error(message)
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * The committed journal
 * ------------------------------------------------------------------ */

let journal: { entries: Array<JournalEntry> }
try {
  journal = JSON.parse(
    readFileSync(resolve(drizzleDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<JournalEntry> }
} catch {
  die(
    `No migration journal at apps/${app}/drizzle/meta/_journal.json — ` +
      'nothing to stamp. Baselines are minted at release time via db:generate.',
  )
}

const entries = [...journal.entries].sort((a, b) => a.idx - b.idx)
if (entries.length === 0) die('Migration journal is empty — nothing to stamp.')

// A journal with a gap would make "the first N migrations" ambiguous, and
// every conclusion below is about a prefix of this list.
entries.forEach((entry, position) => {
  if (entry.idx !== position) {
    die(
      `REFUSING to stamp: the migration journal is not a contiguous sequence ` +
        `— entry ${position} is numbered ${entry.idx}. Regenerate it rather ` +
        'than stamping against it.',
    )
  }
})

/**
 * An identifier as Postgres will actually have stored it.
 *
 * Postgres clips identifiers to NAMEDATALEN-1 = 63 bytes, on a character
 * boundary, and says nothing about it. Drizzle's snapshots record the name the
 * schema asked for, so 17 of this tree's foreign keys — the ones whose
 * generated names run past 63 characters — are recorded under a name no
 * database ever held. Comparing the two sides without this reads every one of
 * them as a missing constraint, and no database matches any migration.
 */
const NAMEDATALEN = 63
function asStored(name: string): string {
  const bytes = Buffer.from(name, 'utf8')
  if (bytes.length <= NAMEDATALEN) return name
  let end = NAMEDATALEN
  // Never clip mid-character: back off over UTF-8 continuation bytes.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * The set of named schema objects a snapshot declares. Both sides of the
 * comparison produce one of these; equality is the whole test.
 *
 * Indexes and constraints share one namespace here rather than being kept in
 * drizzle's separate buckets, because Postgres does not keep them separate: a
 * UNIQUE constraint and its backing index carry the same name, and would count
 * twice on the live side and once on the snapshot side otherwise.
 */
function shapeOfSnapshot(snapshot: DrizzleSnapshot): Set<string> {
  const shape = new Set<string>()
  for (const table of Object.values(snapshot.tables)) {
    if (table.schema !== '' && table.schema !== 'public') continue
    const tableName = asStored(table.name)
    shape.add(`table ${tableName}`)
    for (const column of Object.values(table.columns)) {
      shape.add(
        `column ${tableName}.${asStored(column.name)}` +
          (column.notNull === true ? ' not null' : ''),
      )
    }
    for (const group of [
      table.indexes,
      table.foreignKeys,
      table.uniqueConstraints,
      table.checkConstraints,
    ]) {
      for (const name of Object.keys(group ?? {})) {
        shape.add(`relation ${tableName}.${asStored(name)}`)
      }
    }
  }
  for (const enumeration of Object.values(snapshot.enums ?? {})) {
    const schema = enumeration.schema ?? 'public'
    if (schema !== '' && schema !== 'public') continue
    shape.add(
      `enum ${asStored(enumeration.name)} (${enumeration.values.join(', ')})`,
    )
  }
  return shape
}

/* ------------------------------------------------------------------ *
 * Everything read from disk, before the database is touched
 * ------------------------------------------------------------------ */

// Hash and parse every file up front: a missing or unreadable one should abort
// having written nothing, rather than roll a write back.
const migrations = entries.map((entry) => {
  const tag = entry.tag
  const snapshotName = `${String(entry.idx).padStart(4, '0')}_snapshot.json`
  let hash: string
  try {
    hash = createHash('sha256')
      .update(readFileSync(resolve(drizzleDir, `${tag}.sql`)))
      .digest('hex')
  } catch {
    return die(`REFUSING to stamp: cannot read apps/${app}/drizzle/${tag}.sql.`)
  }
  let snapshot: DrizzleSnapshot
  try {
    snapshot = JSON.parse(
      readFileSync(resolve(drizzleDir, 'meta', snapshotName), 'utf8'),
    ) as DrizzleSnapshot
  } catch {
    return die(
      `REFUSING to stamp: cannot read apps/${app}/drizzle/meta/${snapshotName}. ` +
        'The snapshot is how this script knows what the schema looked like at ' +
        `${tag}; without it the database's position cannot be established.`,
    )
  }
  return { tag, when: entry.when, hash, shape: shapeOfSnapshot(snapshot) }
})

/* ------------------------------------------------------------------ *
 * The live schema
 * ------------------------------------------------------------------ */

// Same defensive unwrap as truncate-all.ts — the driver returns an array-like
// RowList.
function asRows<T>(result: unknown): Array<T> {
  return Array.isArray(result)
    ? (result as Array<T>)
    : ((result as { rows?: Array<T> }).rows ?? [])
}

async function shapeOfDatabase(): Promise<Set<string>> {
  const shape = new Set<string>()

  const tables = asRows<{ tableName: string }>(
    await db.execute<{ tableName: string }>(sql`
      SELECT c.relname AS "tableName"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    `),
  )
  for (const row of tables) shape.add(`table ${row.tableName}`)

  const columns = asRows<{
    tableName: string
    columnName: string
    notNull: boolean
  }>(
    await db.execute<{
      tableName: string
      columnName: string
      notNull: boolean
    }>(sql`
      SELECT c.relname AS "tableName",
             a.attname AS "columnName",
             a.attnotnull AS "notNull"
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
    `),
  )
  for (const row of columns) {
    shape.add(
      `column ${row.tableName}.${row.columnName}` +
        (row.notNull ? ' not null' : ''),
    )
  }

  // Primary keys are excluded from both sides — see the header. `indisprimary`
  // drops the index, `contype` drops the constraint, and in PostgreSQL 17+ it
  // also drops the NOT NULL constraints the catalogue started carrying, which
  // the column rows above already account for.
  const indexes = asRows<{ tableName: string; name: string }>(
    await db.execute<{ tableName: string; name: string }>(sql`
      SELECT c.relname AS "tableName", i.relname AS "name"
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT x.indisprimary
    `),
  )
  const constraints = asRows<{ tableName: string; name: string }>(
    await db.execute<{ tableName: string; name: string }>(sql`
      SELECT c.relname AS "tableName", con.conname AS "name"
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'public' AND con.contype IN ('f', 'u', 'c')
    `),
  )
  for (const row of [...indexes, ...constraints]) {
    shape.add(`relation ${row.tableName}.${row.name}`)
  }

  const enumRows = asRows<{ enumName: string; label: string }>(
    await db.execute<{ enumName: string; label: string }>(sql`
      SELECT t.typname AS "enumName", e.enumlabel AS "label"
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder
    `),
  )
  const enumValues = new Map<string, Array<string>>()
  for (const row of enumRows) {
    const values = enumValues.get(row.enumName) ?? []
    values.push(row.label)
    enumValues.set(row.enumName, values)
  }
  for (const [name, values] of enumValues) {
    shape.add(`enum ${name} (${values.join(', ')})`)
  }

  return shape
}

/* ------------------------------------------------------------------ *
 * Where does this database actually sit?
 * ------------------------------------------------------------------ */

console.log(`Target database: ${describeConnection()}  (edition: ${app})`)

const known = new Set<string>()
for (const migration of migrations) {
  for (const item of migration.shape) known.add(item)
}

const live = await shapeOfDatabase()
const liveKnown = new Set([...live].filter((item) => known.has(item)))
const foreign = [...live].filter((item) => !known.has(item))

function sameShape(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

/** A capped, readable account of how two shapes differ. */
function describeDifference(
  expected: Set<string>,
  actual: Set<string>,
): string {
  const missing = [...expected].filter((item) => !actual.has(item)).sort()
  const unexpected = [...actual].filter((item) => !expected.has(item)).sort()
  const list = (items: Array<string>, label: string) =>
    items.length === 0
      ? []
      : [
          `  ${items.length} ${label}:`,
          ...items.slice(0, 10).map((item) => `    ${item}`),
          ...(items.length > 10 ? [`    … and ${items.length - 10} more`] : []),
        ]
  return [
    ...list(missing, 'missing from the database'),
    ...list(unexpected, 'in the database but not in this migration'),
  ].join('\n')
}

const matched = migrations.findIndex((migration) =>
  sameShape(migration.shape, liveKnown),
)

if (matched === -1) {
  // Report against whichever migration is closest, which is nearly always the
  // one the operator thought they were at.
  const closest = migrations.reduce(
    (best, migration, index) => {
      const overlap = [...migration.shape].filter((item) =>
        liveKnown.has(item),
      ).length
      return overlap > best.overlap ? { index, overlap } : best
    },
    { index: 0, overlap: -1 },
  )
  const nearest = migrations[closest.index]!
  die(
    'REFUSING to stamp: the live schema does not match any committed ' +
      'migration exactly, so there is no honest point to resume from.\n\n' +
      `Closest is ${nearest.tag}:\n` +
      describeDifference(nearest.shape, liveKnown) +
      '\n\nA database that is between two migrations was changed by something ' +
      'other than this journal. Bring it to a released schema — check out that ' +
      'release and run `npm run db:push` once — and run this again. On a fresh ' +
      'database, skip the stamp entirely and run `npm run db:migrate`.',
  )
}

const satisfied = migrations.slice(0, matched + 1)
const pending = migrations.slice(matched + 1)
console.log(
  `Live schema matches ${satisfied[satisfied.length - 1]!.tag} ` +
    `(${satisfied.length} of ${migrations.length} migration(s) satisfied).`,
)
if (foreign.length > 0) {
  const tablesOnly = foreign.filter((item) => item.startsWith('table '))
  console.warn(
    `Note: ${foreign.length} schema object(s) belong to no committed ` +
      'migration and are left alone' +
      (tablesOnly.length > 0
        ? ` (including ${tablesOnly.length} table(s): ` +
          `${tablesOnly
            .slice(0, 5)
            .map((t) => t.slice(6))
            .join(', ')}` +
          `${tablesOnly.length > 5 ? ', …' : ''})`
        : '') +
      '.',
  )
}

/* ------------------------------------------------------------------ *
 * Reconcile against the journal that is already there
 * ------------------------------------------------------------------ */

const journalTable = asRows<{ tableName: string | null }>(
  await db.execute<{ tableName: string | null }>(sql`
    SELECT to_regclass('drizzle.__drizzle_migrations')::text AS "tableName"
  `),
)
let recorded: Array<{ hash: string }> = []
if ((journalTable[0]?.tableName ?? null) !== null) {
  recorded = asRows<{ hash: string }>(
    await db.execute<{ hash: string }>(sql`
      SELECT hash FROM "drizzle"."__drizzle_migrations"
      ORDER BY created_at, id
    `),
  )
}

const migrateHint =
  pending.length === 0
    ? 'Nothing is pending; the database is at the tree it was stamped from.'
    : `Run \`npm run db:migrate\` to apply the remaining ${pending.length} ` +
      `migration(s), starting with ${pending[0]!.tag}.`

if (recorded.length > migrations.length) {
  die(
    `REFUSING to stamp: drizzle.__drizzle_migrations holds ${recorded.length} ` +
      `row(s), more than the ${migrations.length} migration(s) this tree ` +
      'defines. The database has been migrated past the code checked out ' +
      'here. Check out the version it was migrated to (or a newer one) and ' +
      'upgrade from there; do not stamp.',
  )
}

if (recorded.length > satisfied.length) {
  const overreach = migrations.slice(satisfied.length, recorded.length)
  const lastGood = satisfied[satisfied.length - 1]!
  die(
    `REFUSING to stamp: the journal records ${recorded.length} migration(s), ` +
      `but the live schema only satisfies ${satisfied.length}.\n\n` +
      'Recorded without having been applied:\n' +
      overreach.map((m) => `  ${m.tag}`).join('\n') +
      '\n\nThis is the signature of a stamp that recorded the whole journal ' +
      'instead of the part the database satisfied. Because drizzle resumes ' +
      'from the newest row rather than checking each migration off, ' +
      '`db:migrate` has been treating these as done and applying nothing — ' +
      'and will keep doing so until the journal is corrected.\n\n' +
      'Back the database up, then delete the rows that never ran so the ' +
      `journal ends at ${lastGood.tag}:\n\n` +
      '  DELETE FROM "drizzle"."__drizzle_migrations"\n' +
      `   WHERE created_at > ${lastGood.when};\n\n` +
      'Then run `npm run db:migrate`, which applies them for real.',
  )
}

if (recorded.length === satisfied.length) {
  // Nothing to do — but say which of the two reasons it is, because "already
  // stamped" and "up to date" send the operator to different next steps.
  const expectedHashes = new Set(satisfied.map((m) => m.hash))
  const drifted = recorded.filter((row) => !expectedHashes.has(row.hash))
  if (drifted.length > 0) {
    console.warn(
      `Note: ${drifted.length} recorded migration(s) hash differently than ` +
        'the files in this tree. The journal is the right length, so nothing ' +
        'here needs fixing, but a committed migration has been edited since ' +
        'it was applied somewhere.',
    )
  }
  console.log(
    `\nAlready recorded through ${satisfied[satisfied.length - 1]!.tag} — ` +
      `nothing to stamp. ${migrateHint}`,
  )
  process.exit(0)
}

if (recorded.length > 0) {
  die(
    `REFUSING to stamp: the journal records ${recorded.length} migration(s) ` +
      `but the live schema satisfies ${satisfied.length}. The schema is ahead ` +
      'of the journal, which stamping cannot express — drizzle resumes from ' +
      'the newest row, so the migrations in between would be skipped rather ' +
      'than applied.\n\nThis database was changed by something other than ' +
      '`db:migrate`. Reconcile it by hand against the journal it holds.',
  )
}

/* ------------------------------------------------------------------ *
 * Stamp
 * ------------------------------------------------------------------ */

if (checkOnly) {
  console.log(
    `\n✓ Ready to stamp ${satisfied.length} migration(s), through ` +
      `${satisfied[satisfied.length - 1]!.tag}. Nothing was written.\n` +
      '  Run `npm run db:baseline` to stamp, then `npm run db:migrate`.',
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

// One transaction for the whole prefix. Half a journal is the single state
// this script must never leave behind: the guards above read a short journal
// as "the schema is ahead of the journal" and refuse, which is correct for a
// database someone else half-migrated but would be a dead end for one this
// script itself abandoned.
await db.transaction(async (tx) => {
  for (const migration of satisfied) {
    await tx.execute(sql`
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES (${migration.hash}, ${migration.when})
    `)
  }
})

for (const migration of satisfied) console.log(`  ✓ stamped ${migration.tag}`)

console.log(`\nBaseline stamped. ${migrateHint}`)
console.log(
  'This database now upgrades with `npm run db:migrate` — db:push is no longer the path for it.',
)
process.exit(0)
