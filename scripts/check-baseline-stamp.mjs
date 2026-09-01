// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Prove that `db:baseline` puts a pre-0.5 database on the migration path
 * without losing a migration.
 *
 *   npm run db:check-baseline
 *
 * `db:baseline` records committed migrations as applied without running them,
 * against a database whose schema came from `db:push` and which therefore has
 * no journal to check the claim against. Getting that wrong is silent by
 * construction: drizzle's migrator resumes from the newest journal row rather
 * than checking each migration off (`PgDialect.migrate`), so a migration
 * stamped without having run is not retried — `db:migrate` reports success,
 * applies nothing, and the columns and constraints it skipped surface much
 * later as application errors nobody connects back to the upgrade.
 *
 * That is not a hypothetical. Until this check existed, `db:baseline` stamped
 * the *whole* journal whatever the database actually contained, and nothing in
 * CI disagreed: every migration job here starts from an empty database, where
 * baselining never happens.
 *
 * The invariant, asserted for every prefix of the journal:
 *
 *   push to migration M, then baseline, then migrate
 *     ==  migrate from empty
 *
 * Both sides are compared with `check-migration-schema.mjs --dump`, which
 * renders columns with their types and defaults, and constraints and indexes
 * with their definitions. It is a different and stricter reading of the schema
 * than the one `db:baseline` uses to place the database, so a blind spot in
 * that placement cannot hide behind the same blind spot here.
 *
 * Running it for *every* prefix is also what keeps the placement honest as
 * migrations accumulate: a new migration that `db:baseline` cannot tell apart
 * from the one before it would be identified as its predecessor, stamp one row
 * short, and fail the comparison here.
 *
 * The refusals are asserted too — an already-corrupted journal, a schema ahead
 * of its journal, an empty database — because a check that only proves the
 * happy path would let this regress into stamping whatever it was handed.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config as loadEnv } from 'dotenv'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'

import { resolveApp } from './edition.mjs'

/* ------------------------------------------------------------------ *
 * Scratch database
 * ------------------------------------------------------------------ */

loadEnv({ path: resolve(import.meta.dirname, '..', '.env'), quiet: true })

// This script drops and recreates the `public` schema once per scenario. Same
// posture as check-migration-backfills.mjs: it gets an explicitly named
// database or it does not run.
const url = process.env.BASELINE_DATABASE_URL
if (!url) {
  console.error(
    [
      'BASELINE_DATABASE_URL is not set. This check drops and recreates the',
      '`public` schema between scenarios, so it runs against its own scratch',
      'database and refuses to guess which one.',
      '',
      '  createdb -U postgres cascadia_baseline',
      '  BASELINE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia_baseline \\',
      '    npm run db:check-baseline',
    ].join('\n'),
  )
  process.exit(2)
}
for (const guard of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
  if (process.env[guard] && process.env[guard] === url) {
    console.error(
      `BASELINE_DATABASE_URL is the same database as ${guard}. This check\n` +
        'destroys the schema it runs against; point it at a scratch database.',
    )
    process.exit(2)
  }
}

/* ------------------------------------------------------------------ *
 * The journal, read the way drizzle reads it
 * ------------------------------------------------------------------ */

const repoRoot = process.cwd()
const app = resolveApp(repoRoot)
const migrationsFolder = resolve(repoRoot, 'apps', app, 'drizzle')

const journal = JSON.parse(
  readFileSync(resolve(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
)
const files = readMigrationFiles({ migrationsFolder })
if (files.length !== journal.entries.length) {
  console.error('The journal and the migration files disagree in length.')
  process.exit(2)
}
const migrations = files.map((file, i) => ({
  ...file,
  tag: journal.entries[i].tag,
}))

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations'

const exec = (sql, script) => sql.unsafe(script).simple()

/** A database whose schema came from `db:push`: tables, but no journal. */
async function resetDatabase(sql) {
  await exec(
    sql,
    `
      drop schema if exists public cascade;
      drop schema if exists drizzle cascade;
      create schema public;
    `,
  )
}

/** Apply one migration's SQL, without recording anything. */
async function applyMigrationSql(sql, migration) {
  await sql.begin(async (tx) => {
    for (const statement of migration.sql) {
      if (statement.trim() === '') continue
      await tx.unsafe(statement)
    }
  })
}

async function journalRows(sql) {
  const rows = await sql.unsafe(
    `select to_regclass('${MIGRATIONS_TABLE}')::text as t`,
  )
  if (!rows[0]?.t) return null
  return sql.unsafe(
    `select hash, created_at from ${MIGRATIONS_TABLE} order by created_at, id`,
  )
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32',
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

const baseline = (args = []) =>
  run('npm', ['run', 'db:baseline', ...(args.length ? ['--', ...args] : [])], {
    DATABASE_URL: url,
  })

const migrate = () => run('npm', ['run', 'db:migrate'], { DATABASE_URL: url })

/** The normalised schema rendering `check-migration-schema.mjs` produces. */
function dump() {
  return execFileSync(
    'node',
    ['scripts/check-migration-schema.mjs', '--dump', url],
    { encoding: 'utf8' },
  )
}

class Failed extends Error {}

function expect(condition, message) {
  if (!condition) throw new Failed(message)
}

function expectIncludes(haystack, needle, what) {
  expect(
    haystack.includes(needle),
    `${what}: expected the output to mention ${JSON.stringify(needle)}.\n` +
      `--- actual output ---\n${haystack.trim()}\n---`,
  )
}

/** Report the first place two dumps disagree, rather than the whole file. */
function diffDumps(actual, expected) {
  const a = actual.split('\n')
  const b = expected.split('\n')
  const onlyActual = a.filter((l) => l && !b.includes(l))
  const onlyExpected = b.filter((l) => l && !a.includes(l))
  const lines = []
  if (onlyExpected.length > 0) {
    lines.push(`  missing (${onlyExpected.length}):`)
    lines.push(...onlyExpected.slice(0, 10).map((l) => `    ${l}`))
  }
  if (onlyActual.length > 0) {
    lines.push(`  unexpected (${onlyActual.length}):`)
    lines.push(...onlyActual.slice(0, 10).map((l) => `    ${l}`))
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

const sql = postgres(url, { max: 1, onnotice: () => {} })
let failures = 0

async function scenario(name, body) {
  process.stdout.write(`  ${name} … `)
  try {
    await body()
    console.log('ok')
  } catch (error) {
    failures += 1
    console.log('FAILED')
    console.log(
      error instanceof Failed
        ? `      ${error.message.split('\n').join('\n      ')}`
        : `      ${String(error?.stack ?? error)}`,
    )
  }
}

try {
  console.log(`Edition: ${app} — ${migrations.length} committed migration(s)\n`)

  // The reference: what `db:migrate` builds from empty. Every scenario below
  // has to land here.
  console.log('Building the reference (db:migrate from empty)…')
  await resetDatabase(sql)
  const referenceMigrate = migrate()
  if (referenceMigrate.status !== 0) {
    console.error(referenceMigrate.output)
    console.error('db:migrate failed against an empty database.')
    process.exit(1)
  }
  const reference = dump()
  const referenceRows = await journalRows(sql)
  console.log(
    `Reference: ${reference.split('\n').length - 1} schema objects, ` +
      `${referenceRows?.length ?? 0} journal row(s).\n`,
  )

  console.log('Push-to-M, baseline, migrate — for every prefix:')
  for (let m = 0; m < migrations.length; m += 1) {
    const upTo = migrations.slice(0, m + 1)
    const tag = migrations[m].tag

    await scenario(`at ${tag} (${m + 1}/${migrations.length})`, async () => {
      await resetDatabase(sql)
      for (const migration of upTo) await applyMigrationSql(sql, migration)

      // --check reports the right position and writes nothing.
      const checked = baseline(['--check'])
      expect(
        checked.status === 0,
        `db:baseline --check exited ${checked.status}:\n${checked.output}`,
      )
      expectIncludes(checked.output, `Live schema matches ${tag}`, '--check')
      expect(
        (await journalRows(sql)) === null,
        '--check created the journal table; it must write nothing.',
      )

      // The stamp records exactly the prefix the database satisfies.
      const stamped = baseline()
      expect(
        stamped.status === 0,
        `db:baseline exited ${stamped.status}:\n${stamped.output}`,
      )
      const rows = await journalRows(sql)
      expect(rows !== null, 'db:baseline recorded no journal at all.')
      expect(
        rows.length === m + 1,
        `db:baseline recorded ${rows.length} row(s); the database satisfies ` +
          `${m + 1}. Stamping past what a database contains is the bug this ` +
          'check exists for.',
      )
      const wanted = upTo.map((migration) => migration.hash)
      expect(
        rows.every((row, i) => row.hash === wanted[i]),
        'db:baseline recorded the wrong migrations for this prefix.',
      )

      // Re-running is a no-op, not a second stamp.
      const again = baseline()
      expect(
        again.status === 0,
        `re-running db:baseline exited ${again.status}`,
      )
      expectIncludes(again.output, 'Already recorded through', 're-run')
      expect(
        (await journalRows(sql)).length === m + 1,
        're-running db:baseline changed the journal.',
      )

      // And the rest actually applies.
      const migrated = migrate()
      expect(
        migrated.status === 0,
        `db:migrate after the stamp exited ${migrated.status}:\n${migrated.output}`,
      )
      const after = dump()
      expect(
        after === reference,
        'baseline-then-migrate did not land on the same schema as ' +
          `migrate-from-empty:\n${diffDumps(after, reference)}`,
      )
      const finalRows = await journalRows(sql)
      expect(
        finalRows.length === migrations.length,
        `the journal holds ${finalRows.length} row(s) after db:migrate; ` +
          `expected ${migrations.length}.`,
      )
    })
  }

  // Schema objects no migration ever mentions cannot say anything about which
  // migration a database is at, so they must not be able to block a stamp.
  // An install that added a reporting table, or a column to a table Cascadia
  // owns, is still a database this script has to be able to place.
  await scenario(
    'operator-owned tables and columns are tolerated',
    async () => {
      await resetDatabase(sql)
      for (const migration of migrations)
        await applyMigrationSql(sql, migration)
      await exec(
        sql,
        `create table site_local_report (id serial primary key, note text);
       alter table "users" add column site_local_note text;`,
      )
      const result = baseline()
      expect(
        result.status === 0,
        `db:baseline refused over objects it does not own:\n${result.output}`,
      )
      expectIncludes(result.output, 'left alone', 'the stamp')
      const rows = await journalRows(sql)
      expect(
        rows.length === migrations.length,
        `recorded ${rows.length} row(s); expected ${migrations.length}.`,
      )
    },
  )

  console.log('\nRefusals:')

  await scenario('an empty database is sent to db:migrate', async () => {
    await resetDatabase(sql)
    const result = baseline()
    expect(result.status !== 0, 'db:baseline stamped an empty database.')
    expectIncludes(result.output, 'db:migrate', 'the refusal')
  })

  if (migrations.length > 1) {
    await scenario('a journal that overreaches is refused', async () => {
      await resetDatabase(sql)
      await applyMigrationSql(sql, migrations[0])
      // Exactly what the old stamp-the-whole-journal behaviour left behind.
      await exec(
        sql,
        `create schema drizzle;
         create table ${MIGRATIONS_TABLE} (
           id serial primary key, hash text not null, created_at bigint
         );`,
      )
      for (const migration of migrations) {
        await sql.unsafe(
          `insert into ${MIGRATIONS_TABLE} (hash, created_at) values ($1, $2)`,
          [migration.hash, migration.folderMillis],
        )
      }
      const result = baseline()
      expect(
        result.status !== 0,
        'db:baseline accepted an overreaching journal.',
      )
      expectIncludes(result.output, migrations[1].tag, 'the refusal')
      expectIncludes(result.output, 'DELETE FROM', 'the refusal')
    })

    await scenario('a schema ahead of its journal is refused', async () => {
      await resetDatabase(sql)
      for (const migration of migrations)
        await applyMigrationSql(sql, migration)
      await exec(
        sql,
        `create schema drizzle;
         create table ${MIGRATIONS_TABLE} (
           id serial primary key, hash text not null, created_at bigint
         );`,
      )
      await sql.unsafe(
        `insert into ${MIGRATIONS_TABLE} (hash, created_at) values ($1, $2)`,
        [migrations[0].hash, migrations[0].folderMillis],
      )
      const result = baseline()
      expect(result.status !== 0, 'db:baseline stamped over a shorter journal.')
      expectIncludes(result.output, 'ahead of the journal', 'the refusal')
    })
  }

  await scenario('a schema between two migrations is refused', async () => {
    await resetDatabase(sql)
    for (const migration of migrations) await applyMigrationSql(sql, migration)
    // One column short of any committed migration.
    const [victim] = await sql.unsafe(
      `select c.relname as t, a.attname as c
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and a.attnum > 0 and not a.attisdropped
          and not a.attnotnull
        order by c.relname, a.attname
        limit 1`,
    )
    expect(victim !== undefined, 'found no nullable column to drop')
    await sql.unsafe(
      `alter table "${victim.t}" drop column "${victim.c}" cascade`,
    )
    const result = baseline()
    expect(result.status !== 0, 'db:baseline stamped a schema it cannot place.')
    expectIncludes(result.output, 'does not match any committed', 'the refusal')
  })
} finally {
  await sql.end({ timeout: 5 })
}

if (failures > 0) {
  console.error(`\n✗ ${failures} baseline scenario(s) failed.`)
  process.exit(1)
}
console.log(
  '\n✅ db:baseline places every prefix correctly and refuses the rest.',
)
process.exit(0)
