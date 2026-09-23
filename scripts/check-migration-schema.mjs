// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assert that the committed migrations build the schema the code declares.
 *
 *   npm run db:check-migrations                 # migrate vs push, this edition
 *   node scripts/check-migration-schema.mjs --dump <url>   # one side, for diffing
 *
 * `db:push` diff-applies `modules.schema.ts` directly; `db:migrate` replays the
 * committed SQL. Both are supposed to land on the same schema, and nothing
 * checked that they do — CI applied the migrations to an empty database and
 * asked only whether they threw. A migration that creates a column the schema
 * later renamed, or a hand-edited file that dropped a statement, produced a
 * database that worked in dev (pushed) and was subtly wrong on a real install
 * (migrated). This is the check that would have caught it.
 *
 * The comparison reads `information_schema` and `pg_catalog` rather than
 * shelling out to `pg_dump`: no client/server version coupling, and the output
 * is a sorted, normalised text form that diffs cleanly.
 *
 * Deliberately **not** compared: the `drizzle.__drizzle_migrations` bookkeeping
 * table, which exists only on the migrated side, and anything under a schema
 * other than `public`. One further asymmetry is expected rather than ignored —
 * see `MIGRATE_ONLY`.
 */

import { execFileSync } from 'node:child_process'
import postgres from 'postgres'

const COLUMNS = `
  select table_name, column_name, data_type, is_nullable, column_default,
         character_maximum_length, numeric_precision, numeric_scale
    from information_schema.columns
   where table_schema = 'public'
   order by table_name, column_name
`

const CONSTRAINTS = `
  select rel.relname as table_name, con.conname as name,
         pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
   order by rel.relname, con.conname
`

const INDEXES = `
  select tablename as table_name, indexname as name, indexdef as definition
    from pg_indexes
   where schemaname = 'public'
   order by tablename, indexname
`

const ENUMS = `
  select t.typname as name, e.enumlabel as label
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
   order by t.typname, e.enumsortorder
`

/**
 * Objects a migration creates that `db:push` cannot, and that are therefore
 * expected on the migrated side alone.
 *
 * drizzle-kit has no way to express a trigger, so the schema module cannot
 * declare one: the push path — dev, CI and the test database — installs it
 * from `ensureDomainEventSequencing()` at boot instead, and the migration
 * carries the same statements for `db:migrate`.
 *
 * Listed, not ignored. Each entry is asserted to be present after
 * `db:migrate`, so the failure this exists to prevent fails here rather than
 * passing silently: regenerating the domain-events migration drops its
 * `CREATE CONSTRAINT TRIGGER`, which turns commit-time sequencing back into
 * the insert-time race the whole design exists to remove — and every other
 * gate in this repository stays green while it does.
 */
const MIGRATE_ONLY = [
  'constraint domain_events.domain_events_assign_seq TRIGGER DEFERRABLE INITIALLY DEFERRED',
]

/** A sorted, normalised text rendering of everything `public` contains. */
async function dump(url) {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const lines = []
    for (const row of await sql.unsafe(ENUMS)) {
      lines.push(`enum ${row.name} ${row.label}`)
    }
    for (const row of await sql.unsafe(COLUMNS)) {
      lines.push(
        `column ${row.table_name}.${row.column_name} ${row.data_type}` +
          ` null=${row.is_nullable}` +
          ` default=${row.column_default ?? '-'}` +
          ` len=${row.character_maximum_length ?? '-'}` +
          ` prec=${row.numeric_precision ?? '-'},${row.numeric_scale ?? '-'}`,
      )
    }
    for (const row of await sql.unsafe(CONSTRAINTS)) {
      lines.push(`constraint ${row.table_name}.${row.name} ${row.definition}`)
    }
    for (const row of await sql.unsafe(INDEXES)) {
      lines.push(`index ${row.table_name}.${row.name} ${row.definition}`)
    }
    return lines.sort().join('\n') + '\n'
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function reportDifference(migrated, pushed) {
  const a = migrated.split('\n')
  const b = pushed.split('\n')
  const onlyMigrated = a.filter(
    (l) => l && !b.includes(l) && !MIGRATE_ONLY.includes(l),
  )
  const onlyPushed = b.filter((l) => l && !a.includes(l))

  console.error(
    '\n✗ The migrations do not build the schema the code declares.\n',
  )
  if (onlyMigrated.length > 0) {
    console.error(
      `   Present after db:migrate, absent after db:push (${onlyMigrated.length}):`,
    )
    for (const l of onlyMigrated.slice(0, 40)) console.error(`      ${l}`)
    if (onlyMigrated.length > 40)
      console.error(`      … ${onlyMigrated.length - 40} more`)
    console.error('')
  }
  if (onlyPushed.length > 0) {
    console.error(
      `   Present after db:push, absent after db:migrate (${onlyPushed.length}):`,
    )
    for (const l of onlyPushed.slice(0, 40)) console.error(`      ${l}`)
    if (onlyPushed.length > 40)
      console.error(`      … ${onlyPushed.length - 40} more`)
    console.error('')
  }
  console.error(
    'A schema change ships with migrations for both editions — run\n' +
      '`npm run db:generate` and `CASCADIA_APP=cascadia npm run db:generate`,\n' +
      'and commit what appears under cascadia-app*/drizzle/. If they are already\n' +
      'committed, one of them does not do what the schema says.',
  )
}

const args = process.argv.slice(2)
const dumpAt = args.indexOf('--dump')

/** `process.stdout.write`, resolved once the bytes have actually left. */
function write(text) {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()))
  })
}

if (dumpAt !== -1) {
  const url = args[dumpAt + 1]
  if (!url) {
    console.error('--dump needs a database URL')
    process.exit(2)
  }
  // Waiting for the flush is the whole point. `process.stdout.write` to a pipe
  // is asynchronous on Linux, so a dump this size (~200KB against a 64KB pipe
  // buffer) is handed to Node's internal queue and only partly written when
  // `write` returns — and `process.exit` discards whatever is still queued.
  // The caller then compares a schema dump that stops mid-line against a whole
  // one and reports hundreds of objects missing, which is what
  // `db:check-baseline` did on CI while passing on Windows, where writes to a
  // pipe are synchronous and nothing is ever queued.
  await write(await dump(url))
  process.exit(0)
}

const migratedUrl = process.env.MIGRATED_DATABASE_URL
const pushedUrl = process.env.PUSHED_DATABASE_URL
if (!migratedUrl || !pushedUrl) {
  console.error(
    'Set MIGRATED_DATABASE_URL and PUSHED_DATABASE_URL to two databases this\n' +
      'script may write to. It applies `db:migrate` to the first and `db:push`\n' +
      'to the second, then compares them.',
  )
  process.exit(2)
}

const run = (script, url) =>
  execFileSync('npm', ['run', script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: url },
  })

console.log('Applying committed migrations…')
run('db:migrate', migratedUrl)
console.log('Pushing the declared schema…')
run('db:push', pushedUrl)

const [migrated, pushed] = await Promise.all([
  dump(migratedUrl),
  dump(pushedUrl),
])

// The push path cannot build these, so their absence there is the contract.
// Their absence on the *migrated* side is the defect, and this is the only
// place in the repository that would notice it.
const migratedLines = migrated.split('\n')
const missing = MIGRATE_ONLY.filter((l) => !migratedLines.includes(l))
if (missing.length > 0) {
  console.error(
    [
      '',
      '✗ A migration no longer creates what it is required to create:',
      '',
      ...missing.map((l) => `      ${l}`),
      '',
      '   `db:push` cannot express these, so nothing else checks them. If',
      '   the migration was regenerated, drizzle-kit dropped the statements',
      '   — re-append them by hand rather than regenerating again.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

const comparable = (dumped) =>
  dumped
    .split('\n')
    .filter((l) => !MIGRATE_ONLY.includes(l))
    .join('\n')

if (comparable(migrated) === comparable(pushed)) {
  const rows = migrated.split('\n').length - 1
  console.log(
    `\n✅ Migrated and declared schemas are identical (${rows} objects,` +
      ` ${MIGRATE_ONLY.length} migrate-only).`,
  )
  process.exit(0)
}

reportDifference(migrated, pushed)
process.exit(1)
