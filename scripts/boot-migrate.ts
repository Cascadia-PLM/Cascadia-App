// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Bring the database to the committed schema at container start — or refuse to.
 *
 * The compose stack used to boot with `drizzle.mjs push --force`, which asks
 * drizzle to make the live database look like the schema by whatever DDL that
 * takes, unattended, with `--force` answering the destructive prompts. On a
 * database it has never seen that is a data-loss primitive pointed at
 * production.
 *
 * `migrate` is the honest version: it applies committed, reviewed SQL, records
 * each file in a journal, and does nothing at all once the journal is current —
 * so a restart is free. The catch is the databases created before v0.5, whose
 * schema came from `push` and which therefore have no journal. Running migrate
 * against one replays the baseline from the top and fails on its first CREATE
 * TABLE. Those are the three states this decides between:
 *
 *   journal has entries          → migrate (fresh or current, both are the same)
 *   journal empty, tables exist  → REFUSE, and say what to run
 *   journal empty, no tables     → migrate (fresh install: baseline + the rest)
 *
 * The refusal is deliberate and does not auto-stamp. Removing unattended DDL
 * decisions from boot is the point of this script, and `db-baseline.ts` checks
 * table names only — it cannot see column drift — so the stamp is a judgement
 * a person makes once, having read what their database actually contains.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { db, describeConnection } from '../packages/core/src/lib/db/index.ts'
import { classifyMigrationState } from './boot-migrate-state.ts'
import { resolveApp } from './edition.mjs'

/** Same defensive unwrap as db-baseline.ts — the driver returns a RowList. */
function asRows<T>(result: unknown): Array<T> {
  return Array.isArray(result)
    ? (result as Array<T>)
    : ((result as { rows?: Array<T> }).rows ?? [])
}

async function main(): Promise<never> {
  // Resolved at runtime, not imported by name: the image copies apps/, so an
  // enterprise image resolves cascadia-enterprise and a published community
  // image resolves cascadia.
  const app = resolveApp()
  console.log(`[boot] database: ${describeConnection()}  (edition: ${app})`)

  const schema = (await import(
    `../apps/${app}/src/modules.schema.ts`
  )) as Record<string, unknown>
  const expectedTables = Object.values(schema)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table))

  const liveTables = new Set(
    asRows<{ tablename: string }>(
      await db.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      ),
    ).map((r) => r.tablename),
  )

  // The journal table does not exist on a database migrate has never touched,
  // so its absence has to read as zero rather than as an error. Two statements
  // rather than one guarded CASE: Postgres parses the whole expression before
  // evaluating any of it, so a subquery over a missing relation fails at parse
  // time no matter which branch would have run.
  const journalExists =
    asRows<{ present: boolean }>(
      await db.execute<{ present: boolean }>(
        sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
      ),
    )[0]?.present === true

  const journalCount = journalExists
    ? Number(
        asRows<{ count: string }>(
          await db.execute<{ count: string }>(
            sql`SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
          ),
        )[0]?.count ?? '0',
      )
    : 0

  const state = classifyMigrationState(journalCount, liveTables, expectedTables)

  if (state === 'refuse') {
    console.error(
      [
        '',
        '[boot] REFUSING to start: this database has tables but no migration journal.',
        '',
        'That is what a database created before v0.5 looks like — its schema came',
        'from `db:push`, which records nothing. Running migrations against it would',
        'replay the baseline over your live tables.',
        '',
        'Stamp the baseline as already applied, once, then restart:',
        '',
        '  docker exec cascadia-app npx tsx scripts/db-baseline.ts',
        '',
        'db-baseline verifies the live schema matches the baseline before stamping,',
        'and refuses if it does not. Nothing has been changed in your database.',
        'See docs/deployment/upgrading.md.',
        '',
      ].join('\n'),
    )
    process.exit(1)
  }

  console.log(
    journalCount > 0
      ? `[boot] journal has ${journalCount} applied migration(s); applying any new ones`
      : '[boot] empty database; applying the baseline and every migration after it',
  )

  // The same command upgrading.md tells operators to run by hand, so what boots
  // and what they type are one thing.
  execFileSync(
    'node',
    [resolve(import.meta.dirname, 'drizzle.mjs'), 'migrate'],
    { stdio: 'inherit' },
  )

  console.log('[boot] database is current')
  // Exits rather than returning: this process ends here and the shell starts
  // the server, so the db module's pool goes with it.
  process.exit(0)
}

await main()
