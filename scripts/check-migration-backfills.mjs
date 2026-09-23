// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Replay the committed migrations against a database that already holds rows.
 *
 *   npm run db:check-backfills
 *
 * `db:migrate` in CI applies every migration to an *empty* database, so a
 * backfill `UPDATE` matches nothing, a dedup `DELETE` removes nothing, and a
 * guard that is supposed to abort on corrupt history has nothing to abort on.
 * Every data-dependent statement we ship has therefore been green in CI while
 * never having executed. That is the gap this closes: each scenario below
 * stages the journal to the tag before the one under test, seeds the exact
 * shape of data the statement exists to handle, and then applies that one
 * migration and asserts what it did.
 *
 * Three design choices worth knowing:
 *
 * 1. **Drizzle's own reader.** `readMigrationFiles` from `drizzle-orm/migrator`
 *    is the function `drizzle-kit migrate` itself calls, so the statement split,
 *    the ordering and the hashes are production's by construction rather than
 *    by imitation. Hand-rolling the `--> statement-breakpoint` split would make
 *    this fixture's fidelity a claim instead of a fact.
 *
 * 2. **One transaction per migration, not one for the run.** Drizzle wraps
 *    *all* pending migrations in a single transaction
 *    (`drizzle-orm/pg-core/dialect.js`, `PgDialect.migrate`). Staging and
 *    committing up to tag N-1 and then applying tag N alone is both what an
 *    install sitting at a released tag actually does on its next upgrade, and
 *    the only shape in which an abort assertion means anything — otherwise a
 *    deliberate abort in the last file would roll back the tags before it too.
 *
 * 3. **A migration with no DDL is applied twice.** `db:baseline` places a
 *    pre-0.5 database by its schema, which such a migration leaves exactly as
 *    it found it, so the stamp stops before it and `db:migrate` applies it —
 *    to a database that may already carry its effect. Applying it a second
 *    time and asking the scenario's questions again is the proof that this is
 *    safe. `isDataOnly` in `migration-row-dependence.mjs` decides which
 *    migrations that is.
 *
 *    A scenario can also ask for the second pass itself with `applyTwice`,
 *    and that is what carries the proof across a fold. Consolidating a wave
 *    of row-only migrations together with a schema change makes the file no
 *    longer data-only, so the classifier stops asking — but the statements
 *    are still the guarded ones, and a database that carries their effect
 *    without the schema mark still re-runs them. Losing the proof silently as
 *    a side effect of a fold is the failure this whole file exists to
 *    prevent; the flag can only ever make the check stricter, since a guard
 *    that stops holding fails the second pass.
 *
 * The ratchet at the end is the half that keeps this honest. A new migration
 * whose outcome depends on rows already present, and which registers no
 * scenario, fails the check — so this hole cannot quietly reopen the next time
 * someone writes a backfill.
 *
 * "Depends on rows" is two families, not one: the writes, and the DDL Postgres
 * validates against every existing row before it will commit — the statements
 * that *abort* an upgrade rather than silently doing nothing. An empty database
 * judges the second no better than it judges a backfill. Both are classified by
 * `migration-row-dependence.mjs`, which has a test of its own.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config as loadEnv } from 'dotenv'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'

import { appDir, resolveApp } from './edition.mjs'
import {
  isDataOnly,
  rowDependentStatements,
} from './migration-row-dependence.mjs'

/* ------------------------------------------------------------------ *
 * Scratch database
 * ------------------------------------------------------------------ */

// Load the root `.env` before the guard below reads it. A real environment
// variable still wins — dotenv does not overwrite — which is what lets CI pass
// a scratch database with no file on disk. The point of loading it at all is
// that the guard can only refuse to run against the development or test
// database if it can see what those are named.
loadEnv({ path: resolve(import.meta.dirname, '..', '.env'), quiet: true })

// This script DROPs and recreates the `public` schema once per scenario. It
// gets an explicitly named database or it does not run — the same posture, and
// for the same reason, as cascadia-api/src/__tests__/global-setup.ts. Deriving
// a name would land in a database nobody chose.
const url = process.env.BACKFILL_DATABASE_URL
if (!url) {
  console.error(
    [
      'BACKFILL_DATABASE_URL is not set. This check drops and recreates the',
      '`public` schema between scenarios, so it runs against its own scratch',
      'database and refuses to guess which one.',
      '',
      '  createdb -U postgres cascadia_migrate_backfills',
      '  BACKFILL_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia_migrate_backfills \\',
      '    npm run db:check-backfills',
    ].join('\n'),
  )
  process.exit(2)
}
for (const guard of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
  if (process.env[guard] && process.env[guard] === url) {
    console.error(
      `BACKFILL_DATABASE_URL is the same database as ${guard}. This check\n` +
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
const dir = appDir(app)
const migrationsFolder = resolve(repoRoot, dir, 'drizzle')

const journal = JSON.parse(
  readFileSync(resolve(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
)
const files = readMigrationFiles({ migrationsFolder })
if (files.length !== journal.entries.length) {
  console.error('The journal and the migration files disagree in length.')
  process.exit(2)
}
// `readMigrationFiles` walks `journal.entries` in order and drops the tag on
// the floor; zip it back on so scenarios can name a migration by tag.
const migrations = files.map((file, i) => ({
  ...file,
  tag: journal.entries[i].tag,
}))

/* ------------------------------------------------------------------ *
 * Applying migrations
 * ------------------------------------------------------------------ */

const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations'

/**
 * Run a script of several statements. postgres.js sends one statement per round
 * trip over the extended protocol unless asked for the simple one, and every
 * seed here is a script.
 */
const exec = (sql, script) => sql.unsafe(script).simple()

async function resetDatabase(sql) {
  await exec(
    sql,
    `
      drop schema if exists public cascade;
      drop schema if exists drizzle cascade;
      create schema public;
      create schema drizzle;
      create table ${MIGRATIONS_TABLE} (
        id serial primary key,
        hash text not null,
        created_at bigint
      );
    `,
  )
}

/**
 * Apply one migration in one transaction, bookkeeping row included — the body
 * of `PgDialect.migrate`'s loop, lifted out of its all-or-nothing wrapper.
 */
/** One migration's statements, the way drizzle runs them, inside `tx`. */
async function runStatements(tx, migration) {
  for (const statement of migration.sql) {
    // Drizzle executes every chunk, including a whitespace-only trailing one
    // that a file ending in a breakpoint would produce. An empty statement is
    // a no-op there and an error over the extended protocol here, so it is
    // the one thing skipped.
    if (statement.trim() === '') continue
    await tx.unsafe(statement)
  }
}

async function applyMigration(sql, migration) {
  await sql.begin(async (tx) => {
    await runStatements(tx, migration)
    await tx.unsafe(
      `insert into ${MIGRATIONS_TABLE} ("hash", "created_at") values ($1, $2)`,
      [migration.hash, migration.folderMillis],
    )
  })
}

/**
 * Apply a migration the journal already records, again — what `db:migrate`
 * does to a data-only migration on a database `db:baseline` placed (design
 * choice 3 above). The journal is left alone: the question is what the
 * statements do the second time, not what drizzle writes down.
 */
async function reapplyMigration(sql, migration) {
  await sql.begin((tx) => runStatements(tx, migration))
}

async function appliedCount(sql) {
  const [row] = await sql.unsafe(
    `select count(*)::int as n from ${MIGRATIONS_TABLE}`,
  )
  return row.n
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

class Failed extends Error {}

function expect(condition, message) {
  if (!condition) throw new Failed(message)
}

function expectEqual(actual, wanted, what) {
  expect(
    actual === wanted,
    `${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
  )
}

/**
 * One line for a failure. A Postgres error's SQLSTATE and constraint name are
 * the load-bearing part — the JavaScript stack is all inside this file.
 */
function describe(error) {
  if (error instanceof Failed) return error.message
  if (error && typeof error.code === 'string') {
    const where = error.constraint_name ? ` (${error.constraint_name})` : ''
    return `SQLSTATE ${error.code}${where}: ${error.message}`
  }
  return String(error?.stack ?? error)
}

async function one(sql, text) {
  const rows = await sql.unsafe(text)
  expect(rows.length === 1, `expected exactly one row from: ${text.trim()}`)
  return rows[0]
}

async function relationExists(sql, name) {
  const [row] = await sql.unsafe(
    `select count(*)::int as n from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = '${name}'`,
  )
  return row.n === 1
}

async function constraintExists(sql, name) {
  const [row] = await sql.unsafe(
    `select count(*)::int as n from pg_constraint c
       join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public' and c.conname = '${name}'`,
  )
  return row.n === 1
}

/**
 * A foreign key's ON DELETE action, as the one-letter code pg_constraint
 * stores: 'a' no action, 'r' restrict, 'c' cascade, 'n' set null, 'd' set
 * default. A migration that re-adds a constraint under the same name changes
 * nothing `constraintExists` can see, so the action is what has to be read.
 */
async function foreignKeyOnDelete(sql, name) {
  const [row] = await sql.unsafe(
    `select c.confdeltype from pg_constraint c
       join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public' and c.conname = '${name}' and c.contype = 'f'`,
  )
  return row?.confdeltype ?? null
}

/** Run a statement that must be refused, and return the error it raised. */
async function refused(sql, text) {
  try {
    await sql.unsafe(text)
  } catch (error) {
    return error
  }
  throw new Failed(
    `expected this to be refused, and it was not: ${text.trim()}`,
  )
}

/* ------------------------------------------------------------------ *
 * Fixed ids, so seeds and assertions read as the same story
 * ------------------------------------------------------------------ */

/** A deterministic uuid for a row this fixture creates. */
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
/** A uuid that deliberately names nothing — the dangling pointer under test. */
const gone = (n) => `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`

const U1 = id(1)
const U2 = id(2)

const USERS = `
  insert into users (id, email, name) values
    ('${U1}', 'one@fixture.invalid', 'User One'),
    ('${U2}', 'two@fixture.invalid', 'User Two');
`

// Two programs for the work-order backfill, so "the value that was already
// there" and "the value the derivation would produce" are distinguishable — a
// single program cannot tell a kept row from an overwritten one.
const PROGRAM_A = id(120)
const PROGRAM_B = id(121)

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

const SCENARIOS = [
  {
    tag: DOMAIN_EVENTS_TAG(),
    name: 'the jobs dedupe index is created over a populated jobs table, and every existing row survives it',
    async seed(sql) {
      // Jobs that predate the column. Every one of them will have a NULL
      // dedupe_key when the index is built, which is the whole reason the
      // index is partial: were it a plain unique index, these would collide
      // with each other on NULL under some engines and, more to the point,
      // an operator would have no way to upgrade a busy instance.
      await exec(
        sql,
        `
        insert into jobs (id, type, status, payload)
        values
          ('${id(70)}', 'maintenance.cache.cleanup', 'completed', '{}'::jsonb),
          ('${id(71)}', 'maintenance.cache.cleanup', 'pending',   '{}'::jsonb),
          ('${id(72)}', 'design.clone',              'failed',    '{"a":1}'::jsonb);
      `,
      )
    },
    async assert(sql) {
      expect(
        await relationExists(sql, 'uq_jobs_dedupe_key'),
        'uq_jobs_dedupe_key should exist after the migration',
      )

      const survivors = await one(
        sql,
        `select count(*)::int as n from jobs where id in ('${id(70)}', '${id(71)}', '${id(72)}')`,
      )
      expectEqual(survivors.n, 3, 'every pre-existing job survives the upgrade')

      const keyed = await one(
        sql,
        `select count(*)::int as n from jobs where dedupe_key is not null`,
      )
      expectEqual(keyed.n, 0, 'no existing job is given a dedupe key')

      // The partial predicate is the part worth proving: many NULLs coexist,
      // which a plain unique index over a nullable column would not guarantee
      // across engines and which the ON CONFLICT target depends on matching.
      const indexDef = await one(
        sql,
        `select indexdef from pg_indexes where indexname = 'uq_jobs_dedupe_key'`,
      )
      expect(
        /where .*dedupe_key is not null/i.test(indexDef.indexdef),
        'the index must be partial, or ON CONFLICT cannot infer it as a target',
      )
      // And partial over the jobs that still hold their key: a failed or
      // cancelled job releases it, or one failed broker publish wedges that
      // key for good.
      expect(
        /failed/i.test(indexDef.indexdef) &&
          /cancelled/i.test(indexDef.indexdef),
        'the index must exclude failed and cancelled jobs, which release their key',
      )
    },
  },
  {
    tag: '0001_remediation',
    name: 'duplicate live votes: newest stays live, the rest are superseded',
    async seed(sql) {
      await exec(
        sql,
        `
        ${USERS}
        insert into workflow_instances (id) values ('${id(10)}');
        insert into workflow_approval_votes
          (id, workflow_instance_id, state_id, user_id, vote, voted_at)
        values
          ('${id(11)}', '${id(10)}', 'Review', '${U1}', 'approved', '2024-01-01T00:00:00Z'),
          ('${id(12)}', '${id(10)}', 'Review', '${U1}', 'rejected', '2024-06-01T00:00:00Z'),
          ('${id(13)}', '${id(10)}', 'Review', '${U2}', 'approved', '2024-01-01T00:00:00Z');
      `,
      )
    },
    async assert(sql) {
      const older = await one(
        sql,
        `select superseded_at from workflow_approval_votes where id = '${id(11)}'`,
      )
      const newer = await one(
        sql,
        `select superseded_at from workflow_approval_votes where id = '${id(12)}'`,
      )
      const other = await one(
        sql,
        `select superseded_at from workflow_approval_votes where id = '${id(13)}'`,
      )
      expect(
        older.superseded_at !== null,
        'the older vote should be superseded',
      )
      expectEqual(newer.superseded_at, null, 'the newest vote stays live')
      expectEqual(other.superseded_at, null, "another user's vote is untouched")
      expect(
        await relationExists(sql, 'uq_wf_votes_active'),
        'uq_wf_votes_active should exist once the duplicates are resolved',
      )
    },
  },

  {
    tag: '0001_remediation',
    name: 'duplicate user_roles rows collapse to one before the primary key',
    async seed(sql) {
      await exec(
        sql,
        `
        ${USERS}
        insert into roles (id, name) values
          ('${id(20)}', 'Fixture Role A'),
          ('${id(21)}', 'Fixture Role B');
        insert into user_roles (user_id, role_id) values
          ('${U1}', '${id(20)}'),
          ('${U1}', '${id(20)}'),
          ('${U1}', '${id(21)}'),
          ('${U2}', '${id(20)}');
      `,
      )
    },
    async assert(sql) {
      const [dupes] = await sql.unsafe(`
        select count(*)::int as n from (
          select user_id, role_id from user_roles
          group by user_id, role_id having count(*) > 1
        ) d
      `)
      expectEqual(dupes.n, 0, 'no (user, role) pair may appear twice')
      const [total] = await sql.unsafe(
        'select count(*)::int as n from user_roles',
      )
      expectEqual(total.n, 3, 'the three distinct pairs all survive')
      expect(
        await constraintExists(sql, 'user_roles_user_id_role_id_pk'),
        'the composite primary key should exist',
      )
    },
  },

  {
    tag: '0001_remediation',
    name: 'dangling design pointers are nulled, live ones are kept',
    async seed(sql) {
      await exec(
        sql,
        `
        ${USERS}
        insert into designs (id, name, code, created_by) values
          ('${id(30)}', 'Live Design', 'FIX-LIVE', '${U1}');
        insert into designs
          (id, name, code, created_by, parent_design_id, clone_source_design_id,
           source_design_id, source_tag_id, source_commit_id, default_branch_id)
        values
          ('${id(31)}', 'Dangling Design', 'FIX-DANGLE', '${U1}',
           '${gone(30)}', '${gone(31)}', '${gone(32)}',
           '${gone(33)}', '${gone(34)}', '${gone(35)}');
        insert into designs (id, name, code, created_by, parent_design_id) values
          ('${id(32)}', 'Child Design', 'FIX-CHILD', '${U1}', '${id(30)}');
      `,
      )
    },
    async assert(sql) {
      const dangling = await one(
        sql,
        `select parent_design_id, clone_source_design_id, source_design_id,
                source_tag_id, source_commit_id, default_branch_id
           from designs where id = '${id(31)}'`,
      )
      for (const [column, value] of Object.entries(dangling)) {
        expectEqual(value, null, `designs.${column} should be nulled`)
      }
      const child = await one(
        sql,
        `select parent_design_id from designs where id = '${id(32)}'`,
      )
      expectEqual(
        child.parent_design_id,
        id(30),
        'a pointer that resolves is left alone',
      )
      for (const fk of [
        'designs_parent_design_id_designs_id_fk',
        'designs_clone_source_design_id_designs_id_fk',
        'designs_source_design_id_designs_id_fk',
        'designs_source_tag_id_tags_id_fk',
        'designs_source_commit_id_commits_id_fk',
        'designs_default_branch_id_branches_id_fk',
      ]) {
        expect(await constraintExists(sql, fk), `${fk} should exist`)
      }
    },
  },

  {
    tag: '0001_remediation',
    name: 'archived-branch residue is deleted and inert orphans are resolved',
    async seed(sql) {
      await exec(
        sql,
        `
        ${USERS}
        insert into designs (id, name, code, created_by)
          values ('${id(40)}', 'Graph Design', 'FIX-GRAPH', '${U1}');
        insert into branches (id, design_id, name, branch_type, is_archived) values
          ('${id(41)}', '${id(40)}', 'archived-eco', 'eco', true),
          ('${id(42)}', '${id(40)}', 'main', 'main', false);
        insert into commits (id, design_id, branch_id, message, created_by)
          values ('${id(43)}', '${id(40)}', '${id(42)}', 'root', '${U1}');
        insert into items
          (id, master_id, item_number, revision, item_type, state, created_by, modified_by)
        values
          ('${id(44)}', '${id(45)}', 'FIX-ITEM-1', 'A', 'Part', 'Preliminary', '${U1}', '${U1}'),
          ('${id(46)}', '${id(47)}', 'FIX-ECO-1', 'A', 'ChangeOrder', 'Preliminary', '${U1}', '${U1}');

        -- Residue deleteWorkspaceBranch used to leave behind: a tracking row on
        -- an ARCHIVED branch naming an item that was deleted with it.
        insert into branch_items (id, branch_id, item_master_id, current_item_id)
          values ('${id(48)}', '${id(41)}', '${id(49)}', '${gone(48)}');
        -- Inert danglers on a LIVE branch: nulled, not deleted.
        insert into branch_items (id, branch_id, item_master_id, base_item_id)
          values ('${id(50)}', '${id(42)}', '${id(51)}', '${gone(50)}');
        update branches set change_order_item_id = '${gone(52)}',
                            source_tag_id = '${gone(53)}'
          where id = '${id(42)}';

        insert into item_versions (id, commit_id, item_id, change_type) values
          ('${id(54)}', '${id(43)}', '${gone(54)}', 'modified'),
          ('${id(55)}', '${id(43)}', '${id(44)}', 'modified');
        update item_versions set previous_item_id = '${gone(55)}'
          where id = '${id(55)}';

        insert into conflict_reviews
          (id, change_order_id, item_master_id, conflict_type, conflict_signature, reviewed_by)
        values
          ('${id(56)}', '${gone(56)}', '${id(45)}', 'content', 'aaa', '${U1}'),
          ('${id(57)}', '${id(46)}', '${id(45)}', 'content', 'bbb', '${U1}');
        update conflict_reviews set their_eco_id = '${gone(57)}' where id = '${id(57)}';
      `,
      )
    },
    async assert(sql) {
      const [residue] = await sql.unsafe(
        `select count(*)::int as n from branch_items where id = '${id(48)}'`,
      )
      expectEqual(residue.n, 0, 'archived-branch residue should be deleted')

      const live = await one(
        sql,
        `select base_item_id from branch_items where id = '${id(50)}'`,
      )
      expectEqual(
        live.base_item_id,
        null,
        'an inert dangling base_item_id is nulled, the row kept',
      )

      const branch = await one(
        sql,
        `select change_order_item_id, source_tag_id from branches where id = '${id(42)}'`,
      )
      expectEqual(
        branch.change_order_item_id,
        null,
        'branches.change_order_item_id',
      )
      expectEqual(branch.source_tag_id, null, 'branches.source_tag_id')

      const [orphanVersion] = await sql.unsafe(
        `select count(*)::int as n from item_versions where id = '${id(54)}'`,
      )
      expectEqual(
        orphanVersion.n,
        0,
        'an item_versions row with no item is deleted',
      )
      const version = await one(
        sql,
        `select previous_item_id from item_versions where id = '${id(55)}'`,
      )
      expectEqual(
        version.previous_item_id,
        null,
        'item_versions.previous_item_id',
      )

      const [orphanReview] = await sql.unsafe(
        `select count(*)::int as n from conflict_reviews where id = '${id(56)}'`,
      )
      expectEqual(
        orphanReview.n,
        0,
        'a conflict_reviews row with no ECO is deleted',
      )
      const review = await one(
        sql,
        `select their_eco_id from conflict_reviews where id = '${id(57)}'`,
      )
      expectEqual(review.their_eco_id, null, 'conflict_reviews.their_eco_id')

      for (const fk of [
        'branch_items_current_item_id_items_id_fk',
        'branch_items_base_item_id_items_id_fk',
        'branches_change_order_item_id_items_id_fk',
        'item_versions_item_id_items_id_fk',
        'conflict_reviews_change_order_id_items_id_fk',
      ]) {
        expect(await constraintExists(sql, fk), `${fk} should exist`)
      }
    },
  },

  {
    tag: '0001_remediation',
    // The fail-loud half of the same pre-cleanup: a dangling pointer on a
    // branch that is still live is history corruption, not residue, and there
    // is no correct automatic answer for it. It must abort.
    name: 'a dangling pointer on a LIVE branch aborts the upgrade',
    expectAbort: { code: '23503' },
    async seed(sql) {
      await exec(
        sql,
        `
        ${USERS}
        insert into designs (id, name, code, created_by)
          values ('${id(60)}', 'Corrupt Design', 'FIX-CORRUPT', '${U1}');
        insert into branches (id, design_id, name, branch_type, is_archived)
          values ('${id(61)}', '${id(60)}', 'main', 'main', false);
        insert into branch_items (id, branch_id, item_master_id, current_item_id)
          values ('${id(62)}', '${id(61)}', '${id(63)}', '${gone(62)}');
      `,
      )
    },
    async assertRollback(sql) {
      const row = await one(
        sql,
        `select current_item_id from branch_items where id = '${id(62)}'`,
      )
      expectEqual(
        row.current_item_id,
        gone(62),
        'the dangling row is left exactly as it was for a human to resolve',
      )
      expect(
        !(await constraintExists(
          sql,
          'branch_items_current_item_id_items_id_fk',
        )),
        'no constraint from the aborted migration may survive',
      )
    },
  },

  {
    tag: '0001_remediation',
    name: 'an illegal vote value aborts rather than being guessed at',
    expectAbort: { code: '23514', constraint: 'ck_wf_votes_value' },
    async seed(sql) {
      await exec(
        sql,
        `
        ${USERS}
        insert into workflow_instances (id) values ('${id(70)}');
        insert into workflow_approval_votes
          (id, workflow_instance_id, state_id, user_id, vote)
        values ('${id(71)}', '${id(70)}', 'Review', '${U1}', 'maybe');
      `,
      )
    },
    async assertRollback(sql) {
      const row = await one(
        sql,
        `select vote from workflow_approval_votes where id = '${id(71)}'`,
      )
      expectEqual(row.vote, 'maybe', 'the unreadable row is left for a human')
      expect(
        !(await constraintExists(sql, 'ck_wf_votes_value')),
        'no constraint from the aborted migration may survive',
      )
    },
  },

  {
    tag: TRAVELER_TAG(),
    name: 'duplicate open traveler runs: newest stays open, the rest go Incomplete',
    async seed(sql) {
      await exec(sql, travelerSeed())
      await sql.unsafe(`
        insert into instruction_executions
          (id, work_order_instruction_id, executed_by, unit_label, status, started_at)
        values
          -- Same line, same technician, same unit: only the newest may stay open.
          ('${id(101)}', '${id(93)}', '${U1}', 'SN-1', 'In Progress', '2024-01-01T00:00:00Z'),
          ('${id(102)}', '${id(93)}', '${U1}', 'SN-1', 'In Progress', '2024-06-01T00:00:00Z'),
          -- The COALESCE half of the index key: a NULL unit label is one group.
          ('${id(103)}', '${id(93)}', '${U2}', null, 'In Progress', '2024-01-01T00:00:00Z'),
          ('${id(104)}', '${id(93)}', '${U2}', null, 'In Progress', '2024-06-01T00:00:00Z'),
          -- Controls: a different line, and a run that is already closed.
          ('${id(105)}', '${id(94)}', '${U1}', 'SN-1', 'In Progress', '2024-01-01T00:00:00Z'),
          ('${id(106)}', '${id(93)}', '${U1}', 'SN-2', 'Complete', '2024-01-01T00:00:00Z');
      `)
    },
    async assert(sql) {
      const expected = {
        [id(101)]: 'Incomplete',
        [id(102)]: 'In Progress',
        [id(103)]: 'Incomplete',
        [id(104)]: 'In Progress',
        [id(105)]: 'In Progress',
        [id(106)]: 'Complete',
      }
      for (const [row, status] of Object.entries(expected)) {
        const found = await one(
          sql,
          `select status, completed_at from instruction_executions where id = '${row}'`,
        )
        expectEqual(found.status, status, `instruction_executions ${row}`)
        if (status === 'Incomplete') {
          expect(
            found.completed_at !== null,
            `an abandoned run should be stamped completed_at (${row})`,
          )
        }
      }
      const [open] = await sql.unsafe(`
        select count(*)::int as n from (
          select work_order_instruction_id, executed_by, coalesce(unit_label, '')
            from instruction_executions where status = 'In Progress'
           group by 1, 2, 3 having count(*) > 1
        ) d
      `)
      expectEqual(
        open.n,
        0,
        'at most one open run per (line, technician, unit)',
      )
      expect(
        await relationExists(sql, 'uq_instr_exec_open_run'),
        'uq_instr_exec_open_run should exist once the duplicates are resolved',
      )
    },
  },

  {
    tag: TRAVELER_TAG(),
    name: 'an illegal execution status aborts rather than being guessed at',
    expectAbort: { code: '23514', constraint: 'ck_instr_exec_status' },
    async seed(sql) {
      await exec(sql, travelerSeed())
      await sql.unsafe(`
        insert into instruction_executions
          (id, work_order_instruction_id, executed_by, status)
        values ('${id(110)}', '${id(93)}', '${U1}', 'Bogus');
      `)
    },
    async assertRollback(sql) {
      const row = await one(
        sql,
        `select status from instruction_executions where id = '${id(110)}'`,
      )
      expectEqual(row.status, 'Bogus', 'the unreadable row is left for a human')
      expect(
        !(await constraintExists(sql, 'ck_instr_exec_status')),
        'no constraint from the aborted migration may survive',
      )
    },
  },

  {
    // Named outright rather than sniffed for like TRAVELER_TAG: this file was
    // minted with an explicit `generate --custom --name=…`, so both editions
    // carry the same tag.
    tag: WORK_ORDER_PROGRAM_TAG(),
    name: 'work order programs are derived where the chain resolves, and only there',
    async seed(sql) {
      await exec(sql, workOrderProgramSeed())
    },
    async assert(sql) {
      // The whole rule in one table. A row that is not filled stays NULL and
      // therefore stays reachable by `programs:manage` alone — the fail-closed
      // outcome the program gate ships, which is the correct answer wherever the
      // derivation has no unambiguous one.
      const expected = {
        [id(130)]: {
          program: PROGRAM_A,
          why: 'part sits in a design that names a program — derived',
        },
        [id(131)]: {
          program: null,
          why: 'no part to derive from — stays NULL',
        },
        [id(132)]: {
          program: null,
          why: 'part sits in no design — stays NULL',
        },
        [id(133)]: {
          program: null,
          why: 'Standard Library design names no program — stays NULL',
        },
        [id(134)]: {
          program: PROGRAM_A,
          why: 'already had a program — kept, not overwritten with PROGRAM_B',
        },
      }
      for (const [row, { program, why }] of Object.entries(expected)) {
        const found = await one(
          sql,
          `select program_id from work_orders where item_id = '${row}'`,
        )
        expectEqual(found.program_id, program, `work_orders ${row}: ${why}`)
      }

      // The no-overwrite case is the one an off-by-one in the WHERE clause
      // would quietly break, so say it a second time as its own claim: the
      // derivation for that row yields PROGRAM_B and must not have won.
      const kept = await one(
        sql,
        `select program_id from work_orders where item_id = '${id(134)}'`,
      )
      expect(
        kept.program_id !== PROGRAM_B,
        'an existing program_id must never be replaced by the derived one',
      )

      // Nothing outside work_orders.program_id may move: this migration is
      // additive and reversible, and a stray write to either side of the join
      // would make it neither.
      const [parts] = await sql.unsafe(
        `select count(*)::int as n from items where design_id is null and id = '${id(126)}'`,
      )
      expectEqual(parts.n, 1, 'the part with no design is left as it was')
      const [library] = await sql.unsafe(
        `select count(*)::int as n from designs where id = '${id(123)}' and program_id is null`,
      )
      expectEqual(library.n, 1, 'the Standard Library design is left as it was')
    },
  },

  {
    // Same reasoning as the tag above: minted with `generate --custom
    // --name=…`, so both editions carry it verbatim.
    tag: ISSUE_PROGRAM_TAG(),
    name: 'issue programs are derived only where the hand-picked designs agree on one',
    async seed(sql) {
      await exec(sql, issueProgramSeed())
    },
    async assert(sql) {
      // The whole rule in one table. Unlike the work-order chain, the join is
      // many-to-many, so "resolves" means "resolves to exactly one" — every row
      // it does not is a row with no non-arbitrary answer, and stays NULL.
      const expected = {
        [id(170)]: {
          program: PROGRAM_A,
          why: 'one linked design, and it names a program — derived',
        },
        [id(171)]: {
          program: null,
          why: 'no linked design at all — stays NULL',
        },
        [id(172)]: {
          program: null,
          why: 'its only link is the Standard Library, which names no program',
        },
        [id(173)]: {
          program: null,
          why: 'links span two programs — no single answer, stays NULL',
        },
        [id(174)]: {
          program: PROGRAM_A,
          why: 'already had a program — kept, not overwritten with PROGRAM_B',
        },
        [id(175)]: {
          program: PROGRAM_A,
          why: 'a program-less link is skipped, not read as disagreement',
        },
      }
      for (const [row, { program, why }] of Object.entries(expected)) {
        const found = await one(
          sql,
          `select program_id from issues where item_id = '${row}'`,
        )
        expectEqual(found.program_id, program, `issues ${row}: ${why}`)
      }

      // Two claims restated on their own, because each is what a loosened
      // narrowing quietly breaks and neither is legible in the table above: the
      // kept row's own links derive PROGRAM_B, and the spanning row's links
      // really do reach two programs rather than none.
      const kept = await one(
        sql,
        `select program_id from issues where item_id = '${id(174)}'`,
      )
      expect(
        kept.program_id !== PROGRAM_B,
        'an existing program_id must never be replaced by the derived one',
      )
      const spanning = await one(
        sql,
        `select count(distinct d.program_id)::int as n
           from issue_designs ln join designs d on d.id = ln.design_id
          where ln.issue_item_id = '${id(173)}'`,
      )
      expectEqual(
        spanning.n,
        2,
        'the spanning row must genuinely reach two programs, or it proves nothing',
      )

      // Nothing outside issues.program_id may move: this migration is additive
      // and reversible, and a stray write to either side of the join would make
      // it neither.
      const [links] = await sql.unsafe(
        'select count(*)::int as n from issue_designs',
      )
      expectEqual(links.n, 7, 'every design link survives untouched')
      const [library] = await sql.unsafe(
        `select count(*)::int as n from designs where id = '${id(161)}' and program_id is null`,
      )
      expectEqual(library.n, 1, 'the Standard Library design is left as it was')
    },
  },

  {
    tag: AFFECTED_ITEMS_TAG(),
    name: 'duplicate scope rows collapse to one, by a rule that never ties',
    async seed(sql) {
      await exec(sql, affectedItemsSeed())
    },
    async assert(sql) {
      // One line per branch of the keep-rule, plus the two rows it must not
      // reach at all. A survivor chosen by anything other than the documented
      // order — table order, the planner, whichever row the delete visited
      // first — shows up here as the wrong id surviving, not as a count that
      // still happens to be right.
      const expected = {
        [id(220)]: false,
        [id(221)]: true,
        [id(222)]: false,
        [id(223)]: true,
        [id(224)]: false,
        [id(225)]: true,
        [id(226)]: false,
        [id(227)]: true,
        [id(228)]: true,
        [id(229)]: true,
      }
      const why = {
        [id(221)]: 'the row carrying a working copy wins its group outright',
        [id(223)]: 'with no working copy anywhere, the oldest row wins',
        [id(225)]: 'a created_at tie is broken on the lower id',
        [id(227)]: 'a row with no master is outside the index and is kept',
        [id(228)]: 'so is the second one, on the same change order',
        [id(229)]: 'the same master on another change order is a different key',
      }
      for (const [row, survives] of Object.entries(expected)) {
        const [found] = await sql.unsafe(
          `select count(*)::int as n from change_order_affected_items where id = '${row}'`,
        )
        expectEqual(
          found.n,
          survives ? 1 : 0,
          survives ? `${row} survives: ${why[row]}` : `${row} is deleted`,
        )
      }

      const [dupes] = await sql.unsafe(`
        select count(*)::int as n from (
          select change_order_id, affected_item_master_id
            from change_order_affected_items
           where affected_item_master_id is not null
           group by 1, 2 having count(*) > 1
        ) d
      `)
      expectEqual(dupes.n, 0, 'no (change order, master) pair may appear twice')
      expect(
        await relationExists(sql, 'uq_coai_change_order_master'),
        'uq_coai_change_order_master should exist once the duplicates are resolved',
      )
    },
  },

  {
    tag: COMMIT_ECO_TAG(),
    name: 'a commit pointing at a deleted ECO is nulled, a live one is kept',
    async seed(sql) {
      await exec(sql, commitEcoSeed())
    },
    async assert(sql) {
      const stale = await one(
        sql,
        `select change_order_item_id from commits where id = '${id(243)}'`,
      )
      expectEqual(
        stale.change_order_item_id,
        null,
        'a commit whose ECO was hard-deleted has its pointer nulled, the ' +
          'commit kept — it is history',
      )
      const live = await one(
        sql,
        `select change_order_item_id from commits where id = '${id(244)}'`,
      )
      expectEqual(
        live.change_order_item_id,
        id(246),
        'a pointer that resolves is left alone',
      )
      const [kept] = await sql.unsafe(
        `select count(*)::int as n from commits where id in ('${id(242)}', '${id(243)}', '${id(244)}')`,
      )
      expectEqual(kept.n, 3, 'no commit is deleted by the pre-cleanup')

      expect(
        await constraintExists(sql, 'commits_change_order_item_id_items_id_fk'),
        'commits_change_order_item_id_items_id_fk should exist once the stale pointers are nulled',
      )
      expect(
        await relationExists(sql, 'idx_commit_eco'),
        'idx_commit_eco should back the constraint',
      )
    },
  },

  {
    tag: APPROVERS_TAG(),
    name: 'duplicate approvers collapse to the row gating was already using',
    async seed(sql) {
      await exec(sql, approversSeed())
    },
    async assert(sql) {
      // The survivor per group, and the rows the DELETE must not reach. A
      // survivor chosen by anything but the documented order shows up here as
      // the wrong id, not as a count that still happens to be right.
      const expected = {
        [id(250)]: false,
        [id(251)]: true,
        [id(252)]: false,
        [id(253)]: true,
        [id(254)]: true,
        [id(255)]: false,
        [id(256)]: true,
        [id(257)]: true,
        [id(258)]: true,
      }
      const why = {
        [id(251)]: 'the required row wins its group even though it is newer',
        [id(253)]: 'with both rows required, the oldest wins',
        [id(254)]: 'a created_at tie is broken on the lower id',
        [id(256)]: 'another state on the same definition is a different key',
        [id(257)]: 'another definition is a different key',
        [id(258)]: 'the same uuid as a role approver is a different key',
      }
      for (const [row, survives] of Object.entries(expected)) {
        const [found] = await sql.unsafe(
          `select count(*)::int as n from workflow_state_approvers where id = '${row}'`,
        )
        expectEqual(
          found.n,
          survives ? 1 : 0,
          survives ? `${row} survives: ${why[row]}` : `${row} is deleted`,
        )
      }

      // The instance table is the same rule on the same shape of duplicate,
      // so one group is enough to prove its DELETE runs at all.
      const instance = {
        [id(260)]: false,
        [id(261)]: true,
        [id(262)]: true,
        [id(263)]: true,
      }
      for (const [row, survives] of Object.entries(instance)) {
        const [found] = await sql.unsafe(
          `select count(*)::int as n from workflow_instance_approvers where id = '${row}'`,
        )
        expectEqual(
          found.n,
          survives ? 1 : 0,
          `${row} ${survives ? 'survives' : 'is deleted'} on the instance table`,
        )
      }

      // The survivor keeps the required flag, because that is the flag
      // `mergeApproverLists` produced for the pair — collapsing the duplicate
      // must not demote an approver from required to optional.
      const kept = await one(
        sql,
        `select is_required from workflow_state_approvers where id = '${id(251)}'`,
      )
      expectEqual(
        kept.is_required,
        true,
        'the required flag survives the group',
      )

      for (const table of [
        'workflow_state_approvers',
        'workflow_instance_approvers',
      ]) {
        const key =
          table === 'workflow_state_approvers'
            ? 'workflow_definition_id'
            : 'workflow_instance_id'
        const [dupes] = await sql.unsafe(`
          select count(*)::int as n from (
            select ${key}, state_id, approver_type, approver_id
              from ${table} group by 1, 2, 3, 4 having count(*) > 1
          ) d
        `)
        expectEqual(dupes.n, 0, `no approver may appear twice in ${table}`)
      }

      expect(
        await constraintExists(sql, 'uq_wf_state_approvers'),
        'uq_wf_state_approvers should exist once the duplicates are resolved',
      )
      expect(
        await constraintExists(sql, 'uq_wf_instance_approvers'),
        'uq_wf_instance_approvers should exist once the duplicates are resolved',
      )
    },
  },

  {
    tag: VAULT_THUMBNAIL_TAG(),
    name: 'dangling vault thumbnail pointers are nulled, live ones are kept',
    async seed(sql) {
      await exec(sql, vaultThumbnailPointerSeed())
    },
    async assert(sql) {
      const untouched = await one(
        sql,
        `select thumbnail_file_id from vault_files where id = '${id(300)}'`,
      )
      expectEqual(
        untouched.thumbnail_file_id,
        null,
        'a pointer that was already NULL is not residue',
      )
      const dangling = await one(
        sql,
        `select thumbnail_file_id from vault_files where id = '${id(301)}'`,
      )
      expectEqual(
        dangling.thumbnail_file_id,
        null,
        'a pointer at a hard-deleted file is nulled',
      )
      const live = await one(
        sql,
        `select thumbnail_file_id from vault_files where id = '${id(302)}'`,
      )
      expectEqual(
        live.thumbnail_file_id,
        id(300),
        'a pointer that resolves is left alone',
      )
      expect(
        await constraintExists(
          sql,
          'vault_files_thumbnail_file_id_vault_files_id_fk',
        ),
        'the self-FK should exist once the danglers are nulled',
      )
    },
  },

  {
    tag: VAULT_THUMBNAIL_TAG(),
    name: 'duplicate item thumbnails collapse to the newest designation',
    async seed(sql) {
      await exec(sql, vaultThumbnailFlagSeed())
    },
    async assert(sql) {
      const expected = {
        // Item A: three flagged rows, so the newest upload wins.
        [id(310)]: false,
        [id(311)]: true,
        [id(312)]: false,
        // Item B: the only flagged row on its item, and an unflagged sibling.
        [id(313)]: true,
        [id(314)]: false,
        // Item C: uploaded at the same instant, so only the id decides.
        [id(315)]: false,
        [id(316)]: true,
      }
      const why = {
        [id(311)]: 'the newest upload is the designation a person last made',
        [id(313)]: 'a lone flagged row on another item is untouched',
        [id(314)]: 'an unflagged row stays unflagged',
        [id(316)]: 'an uploaded_at tie is broken on the higher id',
      }
      for (const [row, flagged] of Object.entries(expected)) {
        const found = await one(
          sql,
          `select is_item_thumbnail from vault_files where id = '${row}'`,
        )
        expectEqual(
          found.is_item_thumbnail,
          flagged,
          why[row] ?? `${row} is cleared`,
        )
      }

      const [dupes] = await sql.unsafe(`
        select count(*)::int as n from (
          select item_id from vault_files
           where is_item_thumbnail group by item_id having count(*) > 1
        ) d
      `)
      expectEqual(dupes.n, 0, 'no item may carry two thumbnail designations')

      expect(
        await relationExists(sql, 'uq_vault_files_item_thumbnail'),
        'uq_vault_files_item_thumbnail should exist once the duplicates are cleared',
      )
    },
  },

  {
    tag: CHANGE_ORDER_VOCABULARY_TAG(),
    applyTwice: true,
    name: 'the shipped change-order workflows take one name each; a renamed one keeps its name',
    async seed(sql) {
      // The two definitions by their fixed ids: one still carrying the shipped
      // name, one an administrator renamed — which the migration must leave
      await exec(
        sql,
        `
        insert into workflow_definitions
          (id, name, version, workflow_type, definition, lifecycle_type)
        values
          ('00000000-0000-4000-8000-000000000102', 'ECO - Default Workflow', 2, 'strict', '{}'::jsonb, 'Driving'),
          ('00000000-0000-4000-8000-000000000103', 'Renamed by an administrator', 1, 'flexible', '{}'::jsonb, 'Driving');
        `,
      )
    },
    async assert(sql) {
      const strict = await one(
        sql,
        `select name from workflow_definitions where id = '00000000-0000-4000-8000-000000000102'`,
      )
      expectEqual(
        strict.name,
        'Change Order - Standard',
        'the strict definition',
      )
      const flexible = await one(
        sql,
        `select name from workflow_definitions where id = '00000000-0000-4000-8000-000000000103'`,
      )
      expectEqual(
        flexible.name,
        'Renamed by an administrator',
        'a definition an administrator renamed keeps that name',
      )
    },
  },

  {
    tag: CHANGE_ORDER_VOCABULARY_TAG(),
    applyTwice: true,
    name: 'the program-setting key moves from ecoNumberFormat to changeOrderNumberFormat',
    async seed(sql) {
      // One program carrying the old key beside another setting, one without
      // it — the second must come through untouched
      await exec(
        sql,
        `
        ${USERS}
        insert into programs (id, name, code, settings, created_by) values
          ('${PROGRAM_A}', 'Program A', 'PA-KEY', '{"ecoNumberFormat": "ECO-{YYYY}-{NNN}", "other": 1}'::jsonb, '${U1}'),
          ('${PROGRAM_B}', 'Program B', 'PB-KEY', '{"other": 2}'::jsonb, '${U1}');
        `,
      )
    },
    async assert(sql) {
      const a = await one(
        sql,
        `select settings from programs where id = '${PROGRAM_A}'`,
      )
      expectEqual(
        a.settings.changeOrderNumberFormat,
        'ECO-{YYYY}-{NNN}',
        'the value now sits under the new key',
      )
      expectEqual(a.settings.ecoNumberFormat, undefined, 'the old key is gone')
      expectEqual(a.settings.other, 1, 'the other settings are untouched')
      const b = await one(
        sql,
        `select settings from programs where id = '${PROGRAM_B}'`,
      )
      expectEqual(
        JSON.stringify(b.settings),
        JSON.stringify({ other: 2 }),
        'a program without the key is untouched',
      )
    },
  },

  {
    tag: LIFECYCLES_BY_CHANGE_TYPE_TAG(),
    applyTwice: true,
    name: 'the change-type mapping moves from workflowsByChangeType to lifecyclesByChangeType',
    async seed(sql) {
      // Three item-type rows: one carrying only the old key, one carrying
      // both (the new one wins), one carrying neither — untouched
      await exec(
        sql,
        `
        ${USERS}
        insert into item_type_configs (item_type, config, modified_by) values
          ('ChangeOrder', '{"lifecycleDefinitionId": "${id(102)}", "workflowsByChangeType": {"ECO": "${id(102)}", "XCO": "${id(103)}"}}'::jsonb, '${U1}'),
          ('Part', '{"lifecycleDefinitionId": "${id(101)}", "lifecyclesByChangeType": {"ECO": "${id(102)}"}, "workflowsByChangeType": {"ECO": "${id(199)}"}}'::jsonb, '${U1}'),
          ('Document', '{"lifecycleDefinitionId": "${id(104)}"}'::jsonb, '${U1}');
        `,
      )
    },
    async assert(sql) {
      const co = await one(
        sql,
        `select config from item_type_configs where item_type = 'ChangeOrder'`,
      )
      expectEqual(
        JSON.stringify(co.config.lifecyclesByChangeType),
        JSON.stringify({ ECO: id(102), XCO: id(103) }),
        'the mapping now sits under the new key',
      )
      expectEqual(
        co.config.workflowsByChangeType,
        undefined,
        'the old key is gone',
      )
      expectEqual(
        co.config.lifecycleDefinitionId,
        id(102),
        'the rest of the config is untouched',
      )
      const part = await one(
        sql,
        `select config from item_type_configs where item_type = 'Part'`,
      )
      expectEqual(
        JSON.stringify(part.config.lifecyclesByChangeType),
        JSON.stringify({ ECO: id(102) }),
        'a row carrying both keys keeps the new one',
      )
      expectEqual(
        part.config.workflowsByChangeType,
        undefined,
        'and loses the old one',
      )
      const doc = await one(
        sql,
        `select config from item_type_configs where item_type = 'Document'`,
      )
      expectEqual(
        JSON.stringify(doc.config),
        JSON.stringify({ lifecycleDefinitionId: id(104) }),
        'a row without the mapping is untouched',
      )
    },
  },

  {
    tag: LIFECYCLE_TYPE_COLUMN_TAG(),
    name: 'the lifecycle_type column takes the truth from the JSONB, then stands alone',
    async seed(sql) {
      // Every shape the JSONB-first read used to resolve: the column's
      // ADD-COLUMN lie corrected by a legacy definitionType, by an explicit
      // JSONB lifecycleType, a silent JSONB that leaves the column alone, a
      // null column with nothing to say (Free), and JSONB nonsense (Free)
      await exec(
        sql,
        `
        insert into workflow_definitions (id, name, version, workflow_type, definition, lifecycle_type) values
          ('${id(601)}', 'Legacy workflow', 1, 'strict', '{"definitionType": "workflow", "states": []}'::jsonb, 'Free'),
          ('${id(602)}', 'Legacy lifecycle', 1, 'strict', '{"definitionType": "lifecycle"}'::jsonb, 'Free'),
          ('${id(603)}', 'Explicit JSONB', 1, 'strict', '{"lifecycleType": "Driven", "definitionType": "workflow"}'::jsonb, 'Free'),
          ('${id(604)}', 'Silent JSONB', 1, 'strict', '{"states": []}'::jsonb, 'Driving'),
          ('${id(605)}', 'Nothing at all', 1, 'strict', '{}'::jsonb, null),
          ('${id(606)}', 'Nonsense', 1, 'strict', '{"lifecycleType": "bogus"}'::jsonb, 'Driving');
        `,
      )
    },
    async assert(sql) {
      const kinds = {}
      for (const row of await sql.unsafe(
        'select id, lifecycle_type, definition from workflow_definitions order by name',
      )) {
        kinds[row.id] = row.lifecycle_type
        expect(
          !('lifecycleType' in row.definition) &&
            !('definitionType' in row.definition),
          `the JSONB of ${row.id} still carries a kind`,
        )
      }
      expectEqual(
        kinds[id(601)],
        'Driving',
        "definitionType 'workflow' is Driving",
      )
      expectEqual(
        kinds[id(602)],
        'Driven',
        "definitionType 'lifecycle' is Driven",
      )
      expectEqual(
        kinds[id(603)],
        'Driven',
        'an explicit JSONB lifecycleType wins',
      )
      expectEqual(
        kinds[id(604)],
        'Driving',
        'a silent JSONB leaves the column alone',
      )
      expectEqual(kinds[id(605)], 'Free', 'nothing to say is Free')
      expectEqual(
        kinds[id(606)],
        'Free',
        'JSONB nonsense is Free, as the code read it',
      )
      const notNull = await one(
        sql,
        `select attnotnull from pg_attribute where attrelid = 'workflow_definitions'::regclass and attname = 'lifecycle_type'`,
      )
      expectEqual(notNull.attnotnull, true, 'the column is NOT NULL')
      const rejected = await refused(
        sql,
        `insert into workflow_definitions (id, name, version, workflow_type, definition) values ('${id(607)}', 'No kind', 1, 'strict', '{}'::jsonb)`,
      )
      expectEqual(
        rejected.code,
        '23502',
        'a row that states no kind is refused, not defaulted',
      )
    },
  },

  {
    tag: PERMISSION_RESOURCE_TAG(),
    applyTwice: true,
    name: 'the workflows permission resource becomes lifecycles in role and API-key maps',
    async seed(sql) {
      // Roles: one with only the old key, one with both (the new wins), one
      // with neither. API keys: a scoped one carrying the old key, an
      // unscoped one (null)
      await exec(
        sql,
        `
        ${USERS}
        insert into roles (id, name, permissions) values
          ('${id(701)}', 'Legacy role', '{"workflows": ["read"], "parts": ["read"]}'::jsonb),
          ('${id(702)}', 'Both keys', '{"lifecycles": ["read", "manage"], "workflows": ["read"]}'::jsonb),
          ('${id(703)}', 'Untouched', '{"parts": ["read"]}'::jsonb);
        insert into api_keys (id, user_id, name, key_hash, key_prefix, permissions) values
          ('${id(704)}', '${U1}', 'Legacy key', 'hash-704', 'csc_legacy04', '{"workflows": ["read"]}'::jsonb),
          ('${id(705)}', '${U1}', 'Unscoped key', 'hash-705', 'csc_noscope5', null);
        `,
      )
    },
    async assert(sql) {
      const role = async (n) =>
        (await one(sql, `select permissions from roles where id = '${id(n)}'`))
          .permissions
      expectEqual(
        JSON.stringify(await role(701)),
        JSON.stringify({ parts: ['read'], lifecycles: ['read'] }),
        'the old key moves, the rest of the map is untouched',
      )
      expectEqual(
        JSON.stringify(await role(702)),
        JSON.stringify({ lifecycles: ['read', 'manage'] }),
        'a map carrying both keeps the new key and loses the old',
      )
      expectEqual(
        JSON.stringify(await role(703)),
        JSON.stringify({ parts: ['read'] }),
        'a map without the key is untouched',
      )
      const key = async (n) =>
        (
          await one(
            sql,
            `select permissions from api_keys where id = '${id(n)}'`,
          )
        ).permissions
      expectEqual(
        JSON.stringify(await key(704)),
        JSON.stringify({ lifecycles: ['read'] }),
        'an API-key scope moves too',
      )
      expectEqual(await key(705), null, 'an unscoped key stays unscoped')
    },
  },

  {
    tag: DESIGN_STRUCTURE_TAG(),
    name: 'a nested part loses its top-level designation; roots, history and other branches keep theirs',
    // The row statements write only rows still designated and the ALTERs
    // are idempotent — the second pass is the proof, across a later fold.
    applyTwice: true,
    async seed(sql) {
      await exec(sql, designStructureSeed())
    },
    async assert(sql) {
      const designated = async (n) =>
        (
          await one(
            sql,
            `select in_design_structure as d from items where id = '${id(n)}'`,
          )
        ).d
      expectEqual(
        await designated(912),
        false,
        'a child the current assembly nests is not a top-level part',
      )
      expectEqual(
        await designated(924),
        false,
        "a branch-created part nested by that branch's working copy is not one either",
      )
      expectEqual(
        await designated(926),
        false,
        'a row that never recorded a designation has none',
      )
      expectEqual(
        await designated(910),
        true,
        'the assembly nothing points at is still a top-level part',
      )
      expectEqual(
        await designated(914),
        true,
        'a part nothing points at is still a top-level part',
      )
      expectEqual(
        await designated(916),
        true,
        'a part only a superseded revision nested keeps its designation',
      )
      expectEqual(
        await designated(920),
        true,
        "a main row only a branch's working copy nests is the merge's business, not this one's",
      )
      expectEqual(
        await designated(928),
        true,
        "a line into another design does not nest that design's part",
      )
      expectEqual(await designated(930), true, 'non-Part rows are left alone')

      const column = await one(
        sql,
        `select is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'items'
            and column_name = 'in_design_structure'`,
      )
      expectEqual(column.is_nullable, 'NO', 'the column is NOT NULL')
      expectEqual(
        column.column_default,
        'false',
        'the column defaults to false',
      )
    },
  },

  ...snapshotSeqScenarios(),
  ...signingCredentialScenarios(),

  {
    tag: VARIANT_EDGES_TAG(),
    name: 'existing BOM edges survive the split into fixed and option indexes',
    async seed(sql) {
      await exec(sql, variantEdgesSeed())
    },
    async assert(sql) {
      // Every edge that was unique under the old triple constraint is unique
      // under the fixed-line index too: the new column is NULL on all of
      // them, so the index sees exactly the tuples the constraint did.
      const [kept] = await sql.unsafe(
        `select count(*)::int as n from item_relationships
          where source_id = '${id(400)}' and option is null`,
      )
      expectEqual(
        kept.n,
        3,
        'the three pre-existing edges are all still there, all fixed',
      )

      expect(
        !(await constraintExists(
          sql,
          'item_relationships_source_id_target_id_relationship_type_unique',
        )),
        'the old triple constraint should be gone',
      )
      expect(
        await relationExists(sql, 'item_relationships_fixed_edge_unique'),
        'the fixed-line index should exist',
      )
      expect(
        await relationExists(sql, 'item_relationships_option_edge_unique'),
        'the option-line index should exist',
      )

      // The split's whole point: a second fixed line on the same child is
      // still refused, the same child under a condition is now allowed, and
      // the same condition twice is refused by the other index.
      const duplicateFixed = await refused(
        sql,
        `insert into item_relationships
           (id, source_id, target_id, relationship_type, quantity, created_by)
         values ('${id(420)}', '${id(400)}', '${id(402)}', 'BOM', '1', '${U1}')`,
      )
      expectEqual(
        duplicateFixed.code,
        '23505',
        'SQLSTATE for a duplicate fixed line',
      )
      expectEqual(
        duplicateFixed.constraint_name,
        'item_relationships_fixed_edge_unique',
        'the fixed-line index refuses it',
      )

      const black = `'{"all":[{"family":"color","values":["black"]}]}'::jsonb`
      await sql.unsafe(
        `insert into item_relationships
           (id, source_id, target_id, relationship_type, quantity, option, created_by)
         values ('${id(421)}', '${id(400)}', '${id(402)}', 'BOM', '2', ${black}, '${U1}')`,
      )
      const duplicateOption = await refused(
        sql,
        `insert into item_relationships
           (id, source_id, target_id, relationship_type, quantity, option, created_by)
         values ('${id(422)}', '${id(400)}', '${id(402)}', 'BOM', '3', ${black}, '${U1}')`,
      )
      expectEqual(
        duplicateOption.code,
        '23505',
        'SQLSTATE for a duplicate conditioned line',
      )
      expectEqual(
        duplicateOption.constraint_name,
        'item_relationships_option_edge_unique',
        'the option-line index refuses it',
      )
    },
  },
]

/**
 * The product-variants migration, named by the index it builds: the tag
 * differs per edition. It replaces the (source, target, type) constraint on
 * item_relationships with two partial unique indexes, one for fixed lines and
 * one for lines carrying an option condition.
 */
function VARIANT_EDGES_TAG() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes('item_relationships_fixed_edge_unique')),
  )
  if (!found) {
    throw new Error(
      'No migration creates item_relationships_fixed_edge_unique — the variant edges scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The approver-uniqueness migration, named by what it builds for the same
 * reason as the three below: the tag differs per edition.
 */
function APPROVERS_TAG() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes('uq_wf_state_approvers')),
  )
  if (!found) {
    throw new Error(
      'No migration adds uq_wf_state_approvers — the approver scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The commits→ECO migration, named by what it builds for the same reason as
 * the two below: the tag differs per edition.
 */
function COMMIT_ECO_TAG() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes('commits_change_order_item_id_items_id_fk')),
  )
  if (!found) {
    throw new Error(
      'No migration adds commits_change_order_item_id_items_id_fk — the commits→ECO scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The affected-items migration, named the same way as the traveler one below
 * and for the same reason: it is the one that creates
 * `uq_coai_change_order_master`.
 */
function AFFECTED_ITEMS_TAG() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes('uq_coai_change_order_master')),
  )
  if (!found) {
    throw new Error(
      'No migration creates uq_coai_change_order_master — the affected-items scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The work-order program backfill, named by what it writes rather than by its
 * filename. It was hardcoded as `0004_work_order_program_backfill` while that
 * file existed; consolidating the unreleased migrations folded it into
 * `0001_remediation`, and a hardcoded tag would have failed the run rather
 * than following it.
 */
function WORK_ORDER_PROGRAM_TAG() {
  const found = migrations.find((m) =>
    m.sql.some(
      (s) => s.includes('UPDATE "work_orders"') && s.includes('"program_id"'),
    ),
  )
  if (!found) {
    throw new Error(
      'No migration backfills work_orders.program_id — the work-order scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The issue program backfill, named by what it writes for the same reason as
 * the work-order one above.
 */
function ISSUE_PROGRAM_TAG() {
  const found = migrations.find((m) =>
    m.sql.some(
      (s) => s.includes('UPDATE "issues"') && s.includes('"issue_designs"'),
    ),
  )
  if (!found) {
    throw new Error(
      'No migration backfills issues.program_id — the issue scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The vault-thumbnail migration, named by what it builds for the same reason
 * as the others: the tag differs per edition. Both of its pre-cleanups — the
 * dangling self-FK pointers and the duplicate per-item designations — ship in
 * this one file, so both scenarios name it.
 */
function VAULT_THUMBNAIL_TAG() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes('uq_vault_files_item_thumbnail')),
  )
  if (!found) {
    throw new Error(
      'No migration creates uq_vault_files_item_thumbnail — the vault thumbnail scenarios name a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The four resolvers below name the change-management remediation's row
 * changes by what they write, for the reason the ones above give and for one
 * more: they were hardcoded as `0004_change_order_vocabulary` through
 * `0007_permission_resource_lifecycles` until those four files were folded
 * into `0004_change_management_remediation`, and a hardcoded tag would have
 * failed the run rather than following the fold. That file was itself folded
 * again before publication, with the design-structure designation, into
 * `0004_change_management_and_design_structure` — which these four followed
 * unaided, as did DESIGN_STRUCTURE_TAG below, so all five resolve to that one
 * file today. They are kept apart because each names a different statement,
 * so a later fold or split moves each scenario to whichever file its own SQL
 * ended up in.
 *
 * The change-order vocabulary rename: both of its row changes — the two
 * shipped definitions' names and the program-settings key — ship in one file,
 * so both scenarios name this one.
 */
function CHANGE_ORDER_VOCABULARY_TAG() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes("'Change Order - Standard'")),
  )
  if (!found) {
    throw new Error(
      'No migration renames the shipped change-order definitions — the vocabulary scenarios name a file that no longer exists.',
    )
  }
  return found.tag
}

/** The item-type config key move, named by the key it writes. */
function LIFECYCLES_BY_CHANGE_TYPE_TAG() {
  const found = migrations.find((m) =>
    m.sql.some(
      (s) =>
        s.includes('UPDATE "item_type_configs"') &&
        s.includes("'lifecyclesByChangeType'"),
    ),
  )
  if (!found) {
    throw new Error(
      'No migration moves workflowsByChangeType to lifecyclesByChangeType — that scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The lifecycle_type consolidation, named by the constraint it tightens
 * rather than by its backfill: the `SET NOT NULL` is the statement that can
 * abort, and the one the scenario's last assertion is about.
 */
function LIFECYCLE_TYPE_COLUMN_TAG() {
  const found = migrations.find((m) =>
    m.sql.some(
      (s) => s.includes('"lifecycle_type"') && /set\s+not\s+null/i.test(s),
    ),
  )
  if (!found) {
    throw new Error(
      'No migration makes workflow_definitions.lifecycle_type NOT NULL — that scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The design-structure designation flip, named by the constraint it adds:
 * the `SET NOT NULL` is the statement that can abort, and the backfill ahead
 * of it is what the scenario's row assertions are about.
 */
function DESIGN_STRUCTURE_TAG() {
  const found = migrations.find((m) =>
    m.sql.some(
      (s) => s.includes('"in_design_structure"') && /set\s+not\s+null/i.test(s),
    ),
  )
  if (!found) {
    throw new Error(
      'No migration makes items.in_design_structure NOT NULL — that scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * One design, its main and change-order branches, and every shape of BOM
 * line the designation backfill has to read correctly: a current line, a
 * line only a superseded revision owns, a branch working copy's line into a
 * main row, the same working copy's line into a branch-created row, a line
 * into another design, plus a row with no designation recorded and a
 * Document carrying the flag.
 */
function designStructureSeed() {
  const D1 = id(900)
  const D2 = id(940)
  const MAIN = id(901)
  const ECO = id(902)
  const row = (n, master, number, revision, type, design, current, flag) =>
    `('${id(n)}', '${id(master)}', '${number}', '${revision}', '${type}', 'Released', '${design}', ${current}, ${flag}, '${U1}', '${U1}')`
  return `
    ${USERS}
    insert into designs (id, name, code, created_by) values
      ('${D1}', 'Structure Design', 'FIX-STRUCT', '${U1}'),
      ('${D2}', 'Other Design', 'FIX-STRUCT-2', '${U1}');
    insert into branches (id, design_id, name, branch_type, is_archived) values
      ('${MAIN}', '${D1}', 'main', 'main', false),
      ('${ECO}', '${D1}', 'eco/FIX', 'eco', false);
    insert into items
      (id, master_id, item_number, revision, item_type, state, design_id,
       is_current, in_design_structure, created_by, modified_by)
    values
      -- the assembly, current on main, and the child it nests
      ${row(910, 911, 'FIX-ASSY', 'B', 'Part', D1, true, true)},
      ${row(912, 913, 'FIX-CHILD', 'A', 'Part', D1, true, true)},
      -- a part nothing points at
      ${row(914, 915, 'FIX-ROOT', 'A', 'Part', D1, true, true)},
      -- a part only the assembly's superseded revision nested
      ${row(916, 917, 'FIX-DROPPED', 'A', 'Part', D1, true, true)},
      ${row(918, 911, 'FIX-ASSY', 'A', 'Part', D1, false, true)},
      -- a main row only the assembly's working copy on the ECO nests
      ${row(920, 921, 'FIX-BRANCH-NESTED', 'A', 'Part', D1, true, true)},
      ${row(922, 911, 'FIX-ASSY', '-00000000', 'Part', D1, false, true)},
      -- a part created on the ECO and nested there by that working copy
      ${row(924, 925, 'FIX-BRANCH-CHILD', '-00000000', 'Part', D1, true, true)},
      -- a row that never recorded a designation
      ${row(926, 927, 'FIX-NULL', 'A', 'Part', D1, true, 'null')},
      -- another design's part, nested by a line from this design's assembly
      ${row(928, 929, 'FIX-EXTERNAL', 'A', 'Part', D2, true, true)},
      -- a Document carrying the flag
      ${row(930, 931, 'FIX-DOC', 'A', 'Document', D1, true, true)};
    insert into branch_items
      (id, branch_id, item_master_id, current_item_id, base_item_id, change_type)
    values
      ('${id(950)}', '${ECO}', '${id(911)}', '${id(922)}', '${id(910)}', 'modified'),
      ('${id(951)}', '${ECO}', '${id(925)}', '${id(924)}', '${id(924)}', 'added');
    insert into item_relationships (source_id, target_id, relationship_type, created_by) values
      ('${id(910)}', '${id(912)}', 'BOM', '${U1}'),
      ('${id(918)}', '${id(916)}', 'BOM', '${U1}'),
      ('${id(922)}', '${id(920)}', 'BOM', '${U1}'),
      ('${id(922)}', '${id(924)}', 'BOM', '${U1}'),
      ('${id(910)}', '${id(928)}', 'BOM', '${U1}');
  `
}

/** The permission-resource rename, named by the map it rewrites. */
function PERMISSION_RESOURCE_TAG() {
  const found = migrations.find((m) =>
    m.sql.some(
      (s) =>
        s.includes('UPDATE "roles"') &&
        s.includes("jsonb_build_object('lifecycles'"),
    ),
  )
  if (!found) {
    throw new Error(
      'No migration renames the workflows permission resource — that scenario names a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * The snapshot-seq scenario, or nothing at all.
 *
 * `design_session_snapshots` is a design-engine table, so it exists only in
 * the enterprise journal; the community edition mints no migration for it and
 * a scenario naming one would fail in the published tree, where this script
 * also runs. Resolving to an empty list there is the difference between "not
 * applicable to this edition" and "the migration went missing".
 */
function snapshotSeqScenarios() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes('uq_design_snapshots_session_seq')),
  )
  if (!found) return []

  return [
    {
      tag: found.tag,
      name: 'duplicate snapshot seqs are renumbered in order, clean sessions untouched',
      async seed(sql) {
        await exec(sql, snapshotSeqSeed())
      },
      async assert(sql) {
        // The renumber is order-preserving: reading the rows by their old
        // order gives 1..N, so the newest snapshot for a stage is still the
        // newest and every rollback target keeps its meaning.
        const expected = {
          [id(340)]: 1,
          [id(341)]: 2,
          [id(342)]: 3,
          [id(343)]: 4,
          // A session with no duplicate is not touched at all, gap included.
          [id(344)]: 1,
          [id(345)]: 5,
        }
        const why = {
          [id(341)]: 'the older of the tied pair keeps the number it had',
          [id(342)]: 'the newer of the tied pair moves up one',
          [id(343)]: 'everything above the tie shifts to stay above it',
          [id(345)]: 'a clean session keeps its numbering, gaps and all',
        }
        for (const [row, seq] of Object.entries(expected)) {
          const found_ = await one(
            sql,
            `select seq from design_session_snapshots where id = '${row}'`,
          )
          expectEqual(found_.seq, seq, why[row] ?? `${row} keeps seq ${seq}`)
        }

        const [dupes] = await sql.unsafe(`
          select count(*)::int as n from (
            select session_id, seq from design_session_snapshots
            group by session_id, seq having count(*) > 1
          ) d
        `)
        expectEqual(dupes.n, 0, 'no session may mint one seq twice')

        expect(
          await relationExists(sql, 'uq_design_snapshots_session_seq'),
          'uq_design_snapshots_session_seq should exist once the seqs are distinct',
        )
      },
    },
  ]
}

/**
 * The signing-credential migration, or nothing at all.
 *
 * `signing_credentials` and `digital_signatures` are advanced-auditing tables,
 * so like the snapshot-seq scenario above this one exists only in the
 * enterprise journal; resolving to an empty list in the published tree is the
 * difference between "not applicable to this edition" and "the migration went
 * missing".
 *
 * This is the migration that made the validating-DDL hole visible: its only
 * data-dependent statements are an `ADD CONSTRAINT` and an `ADD COLUMN`, so
 * the writes-only classifier waved it through with no scenario at all.
 */
function signingCredentialScenarios() {
  // Named by the action, not just the constraint: the baseline adds this same
  // foreign key under this same name, and it is the swap to `restrict` that
  // this scenario is about.
  const found = migrations.find((m) =>
    m.sql.some(
      (s) =>
        s.includes('signing_credentials_user_id_users_id_fk') &&
        /add\s+constraint/i.test(s) &&
        /on\s+delete\s+restrict/i.test(s),
    ),
  )
  if (!found) return []

  return [
    {
      tag: found.tag,
      name: 'an enrollment survives the restrict swap, and now blocks deleting its user',
      async seed(sql) {
        await exec(sql, signingCredentialSeed())
      },
      async assert(sql) {
        // The migration re-adds a foreign key that already existed under the
        // same name, so the only evidence it did anything is the action.
        expectEqual(
          await foreignKeyOnDelete(
            sql,
            'signing_credentials_user_id_users_id_fk',
          ),
          'r',
          'the user foreign key is restrict, not cascade, once the migration runs',
        )

        // Validating that constraint against rows is the whole risk, so say
        // out loud that the rows it validated are still there.
        const [kept] = await sql.unsafe(
          `select count(*)::int as n from signing_credentials where id in ('${id(350)}', '${id(351)}')`,
        )
        expectEqual(kept.n, 2, 'no enrollment is touched by the swap')

        // The point of the swap: an enrollment is evidence of who held which
        // card and when, and deleting the account must not be a way to erase
        // it. Under the cascade this replaced, this DELETE would have
        // succeeded and taken the enrollment with it. `UserService.deleteUser`
        // reads exactly this violation as the signal to degrade to
        // deactivation, so the code it raises is part of the contract:
        // RESTRICT raises 23001, not the 23503 a plain NO ACTION would.
        const error = await refused(sql, `delete from users where id = '${U1}'`)
        expectEqual(error.code, '23001', 'SQLSTATE for the refused delete')
        expectEqual(
          error.constraint_name,
          'signing_credentials_user_id_users_id_fk',
          'the constraint that refused the delete',
        )
        const [survivor] = await sql.unsafe(
          `select count(*)::int as n from users where id = '${U1}'`,
        )
        expectEqual(
          survivor.n,
          1,
          'the refused delete leaves the user in place',
        )

        // A revoked enrollment is kept deliberately as history, so it protects
        // its user too — a revoked card must not become a way to erase the
        // record that it was ever issued.
        const revoked = await refused(
          sql,
          `delete from users where id = '${U2}'`,
        )
        expectEqual(
          revoked.constraint_name,
          'signing_credentials_user_id_users_id_fk',
          'a revoked enrollment protects its user as well',
        )

        // The other half of the file. `hash_version` is documented as needing
        // no backfill because "the default is what an existing row reads" —
        // which is a claim about rows that were already there, and therefore
        // one only a populated database can check.
        const signature = await one(
          sql,
          `select hash_version from digital_signatures where id = '${id(352)}'`,
        )
        expectEqual(
          signature.hash_version,
          1,
          'a signature written before the column existed reads as version 1, ' +
            'the format that actually produced its chain hash',
        )
      },
    },
  ]
}

/**
 * The traveler migration carries a different tag in each edition (the two files
 * are byte-identical; only the generated name differs), so name it by position:
 * it is the one that creates `uq_instr_exec_open_run`.
 */
function TRAVELER_TAG() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes('uq_instr_exec_open_run')),
  )
  if (!found) {
    throw new Error(
      'No migration creates uq_instr_exec_open_run — the traveler scenarios name a file that no longer exists.',
    )
  }
  return found.tag
}

/**
 * Three duplicate groups, one per branch of the affected-items keep-rule, and
 * three rows the DELETE must not reach.
 *
 * The groups are deliberately shaped so that no two branches agree on a
 * survivor: in the first the working-copy row is also the *newest*, so a rule
 * that only looked at `created_at` would keep the wrong one; in the third both
 * rows share a timestamp to the microsecond, so only the id tie-break decides.
 */
function affectedItemsSeed() {
  return `
    ${USERS}
    insert into items
      (id, master_id, item_number, revision, item_type, state, created_by, modified_by)
    values
      ('${id(200)}', '${id(201)}', 'FIX-COAI-ECO-A', 'A', 'ChangeOrder', 'Draft', '${U1}', '${U1}'),
      ('${id(202)}', '${id(203)}', 'FIX-COAI-ECO-B', 'A', 'ChangeOrder', 'Draft', '${U1}', '${U1}'),
      ('${id(204)}', '${id(205)}', 'FIX-COAI-P1', 'A', 'Part', 'Released', '${U1}', '${U1}'),
      -- The working copy of P1: the same master under a second items row,
      -- which is exactly why the index keys on the master and not on the id.
      ('${id(206)}', '${id(205)}', 'FIX-COAI-P1', 'a1', 'Part', 'Preliminary', '${U1}', '${U1}'),
      ('${id(207)}', '${id(208)}', 'FIX-COAI-P2', 'A', 'Part', 'Released', '${U1}', '${U1}'),
      ('${id(209)}', '${id(210)}', 'FIX-COAI-P3', 'A', 'Part', 'Released', '${U1}', '${U1}');

    insert into change_orders (item_id, change_type) values
      ('${id(200)}', 'ECO'),
      ('${id(202)}', 'ECO');

    insert into change_order_affected_items
      (id, change_order_id, affected_item_id, affected_item_master_id,
       change_action, working_copy_id, created_at, created_by)
    values
      -- Group 1, on master P1: the working copy wins although it is newest.
      ('${id(220)}', '${id(200)}', '${id(204)}', '${id(205)}', 'revise', null, '2024-01-01T00:00:00Z', '${U1}'),
      ('${id(221)}', '${id(200)}', '${id(204)}', '${id(205)}', 'revise', '${id(206)}', '2024-06-01T00:00:00Z', '${U1}'),
      ('${id(222)}', '${id(200)}', '${id(204)}', '${id(205)}', 'obsolete', null, '2024-03-01T00:00:00Z', '${U1}'),
      -- Group 2, on master P2: no working copy anywhere, so the oldest wins.
      ('${id(223)}', '${id(200)}', '${id(207)}', '${id(208)}', 'revise', null, '2024-01-01T00:00:00Z', '${U1}'),
      ('${id(224)}', '${id(200)}', '${id(207)}', '${id(208)}', 'revise', null, '2024-06-01T00:00:00Z', '${U1}'),
      -- Group 3, on master P3: same instant, so only the id decides.
      ('${id(225)}', '${id(200)}', '${id(209)}', '${id(210)}', 'revise', null, '2024-01-01T00:00:00Z', '${U1}'),
      ('${id(226)}', '${id(200)}', '${id(209)}', '${id(210)}', 'revise', null, '2024-01-01T00:00:00Z', '${U1}'),
      -- Out of the index: two rows for items that do not exist yet, which a
      -- change order may hold any number of.
      ('${id(227)}', '${id(200)}', null, null, 'create', null, '2024-01-01T00:00:00Z', '${U1}'),
      ('${id(228)}', '${id(200)}', null, null, 'create', null, '2024-01-01T00:00:00Z', '${U1}'),
      -- Out of the group: the same master, listed on a different change order.
      ('${id(229)}', '${id(202)}', '${id(204)}', '${id(205)}', 'revise', null, '2024-01-01T00:00:00Z', '${U1}');
  `
}

/**
 * One parent with three edges that were distinct under the old triple
 * constraint: two BOM children, and one of those children again under a
 * different relationship type. Every row predates the `option` column, so all
 * three arrive at the new indexes as fixed lines.
 */
function variantEdgesSeed() {
  return `
    ${USERS}
    insert into items
      (id, master_id, item_number, revision, item_type, state, created_by, modified_by)
    values
      ('${id(400)}', '${id(401)}', 'FIX-VAR-ASSY', 'A', 'Part', 'Released', '${U1}', '${U1}'),
      ('${id(402)}', '${id(403)}', 'FIX-VAR-C1', 'A', 'Part', 'Released', '${U1}', '${U1}'),
      ('${id(404)}', '${id(405)}', 'FIX-VAR-C2', 'A', 'Part', 'Released', '${U1}', '${U1}');

    insert into item_relationships
      (id, source_id, target_id, relationship_type, quantity, created_by)
    values
      ('${id(410)}', '${id(400)}', '${id(402)}', 'BOM', '1', '${U1}'),
      ('${id(411)}', '${id(400)}', '${id(404)}', 'BOM', '2', '${U1}'),
      ('${id(412)}', '${id(400)}', '${id(402)}', 'Reference', null, '${U1}');
  `
}

/** users -> items -> work_orders -> work_order_instructions, for the traveler. */
function travelerSeed() {
  return `
    ${USERS}
    insert into items
      (id, master_id, item_number, revision, item_type, state, created_by, modified_by)
    values
      ('${id(90)}', '${id(91)}', 'FIX-WO-1', 'A', 'WorkOrder', 'Open', '${U1}', '${U1}'),
      ('${id(92)}', '${id(95)}', 'FIX-PART-1', 'A', 'Part', 'Released', '${U1}', '${U1}');
    insert into work_orders (item_id, part_id, quantity) values ('${id(90)}', '${id(92)}', 2);
    insert into work_order_instructions
      (id, work_order_id, order_index, title, snapshot, created_by)
    values
      ('${id(93)}', '${id(90)}', 0, 'Line one', '{}'::jsonb, '${U1}'),
      ('${id(94)}', '${id(90)}', 1, 'Line two', '{}'::jsonb, '${U1}');
  `
}

/**
 * One work order per branch of the 0004 backfill: a chain that resolves, and
 * each of the three ways it can fail to — no part, a part in no design, and a
 * design with no program — plus a row that already carries a program, whose
 * part deliberately derives a *different* one.
 */
function workOrderProgramSeed() {
  return `
    ${USERS}
    insert into programs (id, name, code, created_by) values
      ('${PROGRAM_A}', 'Program Alpha', 'FIX-PROG-A', '${U1}'),
      ('${PROGRAM_B}', 'Program Beta', 'FIX-PROG-B', '${U1}');

    insert into designs (id, name, code, created_by, program_id) values
      ('${id(122)}', 'Design In Alpha', 'FIX-DSN-A', '${U1}', '${PROGRAM_A}'),
      -- program_id NULL is not a data gap here: it is the Standard Library,
      -- which is globally accessible and belongs to no program.
      ('${id(123)}', 'Standard Library', 'FIX-DSN-LIB', '${U1}', null),
      ('${id(124)}', 'Design In Beta', 'FIX-DSN-B', '${U1}', '${PROGRAM_B}');

    insert into items
      (id, master_id, item_number, revision, item_type, state, created_by,
       modified_by, design_id)
    values
      ('${id(125)}', '${id(140)}', 'FIX-P-INPROG', 'A', 'Part', 'Released', '${U1}', '${U1}', '${id(122)}'),
      -- items.design_id is nullable by design (Tasks and Issues need none).
      ('${id(126)}', '${id(141)}', 'FIX-P-NODSN', 'A', 'Part', 'Released', '${U1}', '${U1}', null),
      ('${id(127)}', '${id(142)}', 'FIX-P-INLIB', 'A', 'Part', 'Released', '${U1}', '${U1}', '${id(123)}'),
      ('${id(128)}', '${id(143)}', 'FIX-P-INBETA', 'A', 'Part', 'Released', '${U1}', '${U1}', '${id(124)}'),
      ('${id(130)}', '${id(150)}', 'FIX-WO-DERIVE', 'A', 'WorkOrder', 'Open', '${U1}', '${U1}', null),
      ('${id(131)}', '${id(151)}', 'FIX-WO-NOPART', 'A', 'WorkOrder', 'Open', '${U1}', '${U1}', null),
      ('${id(132)}', '${id(152)}', 'FIX-WO-NODSN', 'A', 'WorkOrder', 'Open', '${U1}', '${U1}', null),
      ('${id(133)}', '${id(153)}', 'FIX-WO-INLIB', 'A', 'WorkOrder', 'Open', '${U1}', '${U1}', null),
      ('${id(134)}', '${id(154)}', 'FIX-WO-KEPT', 'A', 'WorkOrder', 'Open', '${U1}', '${U1}', null);

    insert into work_orders (item_id, part_id, quantity, program_id) values
      -- Derivable: part -> design -> program.
      ('${id(130)}', '${id(125)}', 1, null),
      -- No part: nothing to derive from.
      ('${id(131)}', null, 1, null),
      -- Part in no design.
      ('${id(132)}', '${id(126)}', 1, null),
      -- Part in the Standard Library, which names no program.
      ('${id(133)}', '${id(127)}', 1, null),
      -- Already repaired by an administrator to Alpha, while its part sits in
      -- Beta. The backfill must not "correct" it.
      ('${id(134)}', '${id(128)}', 1, '${PROGRAM_A}');
  `
}

/**
 * One issue per branch of the 0006 backfill. The many-to-many link is what
 * makes this shape different from the work-order one: as well as the ways the
 * chain can fail to resolve (no link, a link to a program-less design), it can
 * resolve to *two* answers, which must be left alone rather than settled
 * arbitrarily. The last row pins the one outcome the SQL's shape does not make
 * self-evident: a program-less link alongside a real one is ignored, not read
 * as the issue disagreeing with itself.
 */
function issueProgramSeed() {
  return `
    ${USERS}
    insert into programs (id, name, code, created_by) values
      ('${PROGRAM_A}', 'Program Alpha', 'FIX-PROG-A', '${U1}'),
      ('${PROGRAM_B}', 'Program Beta', 'FIX-PROG-B', '${U1}');

    insert into designs (id, name, code, created_by, program_id) values
      ('${id(160)}', 'Design In Alpha', 'FIX-DSN-A', '${U1}', '${PROGRAM_A}'),
      -- program_id NULL is not a data gap here: it is the Standard Library,
      -- which is globally accessible and belongs to no program.
      ('${id(161)}', 'Standard Library', 'FIX-DSN-LIB', '${U1}', null),
      ('${id(162)}', 'Design In Beta', 'FIX-DSN-B', '${U1}', '${PROGRAM_B}');

    -- items.design_id is NULL on every one of these on purpose: an issue
    -- raised from the issues page sits in no design, which is the whole reason
    -- the program has to come from the links instead.
    insert into items
      (id, master_id, item_number, revision, item_type, state, created_by,
       modified_by, design_id)
    values
      ('${id(170)}', '${id(180)}', 'FIX-ISS-DERIVE', 'A', 'Issue', 'Open', '${U1}', '${U1}', null),
      ('${id(171)}', '${id(181)}', 'FIX-ISS-NOLINK', 'A', 'Issue', 'Open', '${U1}', '${U1}', null),
      ('${id(172)}', '${id(182)}', 'FIX-ISS-INLIB', 'A', 'Issue', 'Open', '${U1}', '${U1}', null),
      ('${id(173)}', '${id(183)}', 'FIX-ISS-SPAN', 'A', 'Issue', 'Open', '${U1}', '${U1}', null),
      ('${id(174)}', '${id(184)}', 'FIX-ISS-KEPT', 'A', 'Issue', 'Open', '${U1}', '${U1}', null),
      ('${id(175)}', '${id(185)}', 'FIX-ISS-MIXED', 'A', 'Issue', 'Open', '${U1}', '${U1}', null);

    insert into issues (item_id, description, program_id) values
      ('${id(170)}', 'One design, in Alpha', null),
      ('${id(171)}', 'No design picked at all', null),
      ('${id(172)}', 'Only the Standard Library', null),
      ('${id(173)}', 'Designs in both programs', null),
      -- Already repaired by an administrator to Alpha, while its design sits
      -- in Beta. The backfill must not "correct" it.
      ('${id(174)}', 'Repaired by hand to Alpha', '${PROGRAM_A}'),
      ('${id(175)}', 'Alpha plus the Standard Library', null);

    insert into issue_designs (id, issue_item_id, design_id) values
      ('${id(190)}', '${id(170)}', '${id(160)}'),
      ('${id(191)}', '${id(172)}', '${id(161)}'),
      ('${id(192)}', '${id(173)}', '${id(160)}'),
      ('${id(193)}', '${id(173)}', '${id(162)}'),
      ('${id(194)}', '${id(174)}', '${id(162)}'),
      ('${id(195)}', '${id(175)}', '${id(160)}'),
      ('${id(196)}', '${id(175)}', '${id(161)}');
  `
}

/**
 * Three commits on one branch: one that never named an ECO, one whose ECO was
 * hard-deleted while the pointer was still a bare uuid, and one whose ECO is
 * still there. The pre-cleanup has to tell the second from the third, and it
 * must not confuse either with the first — an already-NULL pointer is not
 * residue.
 */
function commitEcoSeed() {
  return `
    ${USERS}
    insert into designs (id, name, code, created_by)
      values ('${id(240)}', 'Release Design', 'FIX-REL', '${U1}');
    insert into branches (id, design_id, name, branch_type)
      values ('${id(241)}', '${id(240)}', 'main', 'main');

    insert into items
      (id, master_id, item_number, revision, item_type, state, created_by, modified_by)
    values
      ('${id(246)}', '${id(247)}', 'FIX-ECO-LIVE', 'A', 'ChangeOrder', 'Preliminary', '${U1}', '${U1}');

    insert into commits
      (id, design_id, branch_id, message, created_by, change_order_item_id)
    values
      -- No ECO at all: the ordinary commit, which the statement must not touch.
      ('${id(242)}', '${id(240)}', '${id(241)}', 'root', '${U1}', null),
      -- The residue: a release commit whose ECO was deleted while nothing
      -- stopped it. The commit stays; only the pointer goes.
      ('${id(243)}', '${id(240)}', '${id(241)}', 'Released via ECO: gone', '${U1}', '${gone(243)}'),
      -- The live linkage, which must survive the cleanup intact.
      ('${id(244)}', '${id(240)}', '${id(241)}', 'Released via ECO: live', '${U1}', '${id(246)}');
  `
}

/**
 * Three duplicate approver groups, one per branch of the keep-rule, and four
 * rows the DELETE must not reach.
 *
 * The groups are shaped so no two branches agree on a survivor: in the first
 * the required row is also the *newer*, so a rule that only looked at
 * `created_at` would demote the approver to optional; in the third both rows
 * share a timestamp to the microsecond, so only the id tie-break decides.
 *
 * The untouched rows cover each column of the key in turn — a second state on
 * the same definition, a second definition, and the same uuid recorded as a
 * role rather than a user.
 */
function approversSeed() {
  const ROLE = id(270)
  return `
    ${USERS}
    insert into workflow_definitions (id, name, version, workflow_type, definition)
    values
      ('${id(248)}', 'Fixture Approval Flow', 1, 'strict', '{"states":[],"transitions":[]}'),
      ('${id(249)}', 'Fixture Approval Flow II', 1, 'strict', '{"states":[],"transitions":[]}');

    insert into workflow_instances (id, workflow_definition_id) values
      ('${id(259)}', '${id(248)}'),
      ('${id(264)}', '${id(248)}');

    insert into workflow_state_approvers
      (id, workflow_definition_id, state_id, approver_type, approver_id, is_required, created_at)
    values
      -- Required beats older: the optional row was added first.
      ('${id(250)}', '${id(248)}', 'Review', 'user', '${U1}', false, '2024-01-01T00:00:00Z'),
      ('${id(251)}', '${id(248)}', 'Review', 'user', '${U1}', true,  '2024-06-01T00:00:00Z'),
      -- Both required, so the oldest wins.
      ('${id(252)}', '${id(248)}', 'Review', 'role', '${ROLE}', true, '2024-06-01T00:00:00Z'),
      ('${id(253)}', '${id(248)}', 'Review', 'role', '${ROLE}', true, '2024-01-01T00:00:00Z'),
      -- Identical to the microsecond: only the id decides.
      ('${id(254)}', '${id(248)}', 'Review', 'user', '${U2}', true, '2024-03-01T00:00:00Z'),
      ('${id(255)}', '${id(248)}', 'Review', 'user', '${U2}', true, '2024-03-01T00:00:00Z'),
      -- One column of the key different in each of these: state, definition, type.
      ('${id(256)}', '${id(248)}', 'Approved', 'user', '${U1}', true, '2024-01-01T00:00:00Z'),
      ('${id(257)}', '${id(249)}', 'Review', 'user', '${U1}', true, '2024-01-01T00:00:00Z'),
      ('${id(258)}', '${id(248)}', 'Review', 'role', '${U1}', true, '2024-01-01T00:00:00Z');

    insert into workflow_instance_approvers
      (id, workflow_instance_id, state_id, approver_type, approver_id, is_required, created_at)
    values
      ('${id(260)}', '${id(259)}', 'Review', 'user', '${U1}', false, '2024-01-01T00:00:00Z'),
      ('${id(261)}', '${id(259)}', 'Review', 'user', '${U1}', true,  '2024-06-01T00:00:00Z'),
      ('${id(262)}', '${id(259)}', 'Review', 'user', '${U2}', true,  '2024-01-01T00:00:00Z'),
      ('${id(263)}', '${id(264)}', 'Review', 'user', '${U1}', true,  '2024-01-01T00:00:00Z');
  `
}

/**
 * One item and three of its vault files: a row with no thumbnail, a row whose
 * thumbnail was hard-deleted while `thumbnail_file_id` was a bare uuid, and a
 * row whose thumbnail is still there. The cleanup has to tell the second from
 * the third without mistaking the first for residue.
 */
function vaultThumbnailPointerSeed() {
  return `
    ${USERS}
    insert into items
      (id, master_id, item_number, revision, item_type, state, created_by, modified_by)
    values
      ('${id(303)}', '${id(304)}', 'FIX-VF-PTR', 'A', 'Part', 'Released', '${U1}', '${U1}');

    insert into vault_files
      (id, item_id, file_name, original_file_name, file_size, mime_type,
       file_hash, storage_path, uploaded_by, thumbnail_file_id)
    values
      ('${id(300)}', '${id(303)}', 'a.png', 'a.png', 10, 'image/png', 'h300', 'p/300', '${U1}', null),
      ('${id(301)}', '${id(303)}', 'b.step', 'b.step', 20, 'model/step', 'h301', 'p/301', '${U1}', '${gone(300)}'),
      ('${id(302)}', '${id(303)}', 'c.step', 'c.step', 30, 'model/step', 'h302', 'p/302', '${U1}', '${id(300)}');
  `
}

/**
 * Three items, one per branch of the keep-rule: a group of three designations
 * where the newest upload wins, a lone designation that must be left alone
 * beside an unflagged sibling, and a pair uploaded at the same instant where
 * only the id tie-break decides.
 */
function vaultThumbnailFlagSeed() {
  return `
    ${USERS}
    insert into items
      (id, master_id, item_number, revision, item_type, state, created_by, modified_by)
    values
      ('${id(320)}', '${id(323)}', 'FIX-VF-A', 'A', 'Part', 'Released', '${U1}', '${U1}'),
      ('${id(321)}', '${id(324)}', 'FIX-VF-B', 'A', 'Part', 'Released', '${U1}', '${U1}'),
      ('${id(322)}', '${id(325)}', 'FIX-VF-C', 'A', 'Part', 'Released', '${U1}', '${U1}');

    insert into vault_files
      (id, item_id, file_name, original_file_name, file_size, mime_type,
       file_hash, storage_path, uploaded_by, uploaded_at, is_item_thumbnail)
    values
      -- Item A: three designations the two-statement set left standing.
      ('${id(310)}', '${id(320)}', 'a1.png', 'a1.png', 10, 'image/png', 'h310', 'p/310', '${U1}', '2024-01-01T00:00:00Z', true),
      ('${id(311)}', '${id(320)}', 'a2.png', 'a2.png', 10, 'image/png', 'h311', 'p/311', '${U1}', '2024-06-01T00:00:00Z', true),
      ('${id(312)}', '${id(320)}', 'a3.png', 'a3.png', 10, 'image/png', 'h312', 'p/312', '${U1}', '2024-03-01T00:00:00Z', true),
      -- Item B: one designation, plus an ordinary file that must stay unflagged.
      ('${id(313)}', '${id(321)}', 'b1.png', 'b1.png', 10, 'image/png', 'h313', 'p/313', '${U1}', '2024-01-01T00:00:00Z', true),
      ('${id(314)}', '${id(321)}', 'b2.png', 'b2.png', 10, 'image/png', 'h314', 'p/314', '${U1}', '2024-02-01T00:00:00Z', false),
      -- Item C: uploaded to the microsecond together, so only the id decides.
      ('${id(315)}', '${id(322)}', 'c1.png', 'c1.png', 10, 'image/png', 'h315', 'p/315', '${U1}', '2024-03-01T00:00:00Z', true),
      ('${id(316)}', '${id(322)}', 'c2.png', 'c2.png', 10, 'image/png', 'h316', 'p/316', '${U1}', '2024-03-01T00:00:00Z', true);
  `
}

/**
 * Two design sessions: one whose seq was minted twice by two concurrent
 * confirms, and one that is already correct — gap included, so a renumber that
 * reached past the sessions with an actual duplicate would be visible.
 */
function snapshotSeqSeed() {
  return `
    ${USERS}
    insert into programs (id, name, code, created_by) values
      ('${id(330)}', 'Snapshot Program', 'FIX-PROG-SNAP', '${U1}');

    insert into design_sessions (id, user_id, program_id, description) values
      ('${id(331)}', '${U1}', '${id(330)}', 'Two confirms landed on one seq'),
      ('${id(332)}', '${U1}', '${id(330)}', 'Already numbered correctly');

    insert into design_session_snapshots
      (id, session_id, stage, seq, artifacts, llm_history_length, created_at)
    values
      ('${id(340)}', '${id(331)}', 'requirements_review', 1, '{}'::jsonb, 0, '2024-01-01T00:00:00Z'),
      -- The tie: both confirms read max(seq) = 1 and both wrote 2.
      ('${id(341)}', '${id(331)}', 'bom_review', 2, '{}'::jsonb, 0, '2024-02-01T00:00:00Z'),
      ('${id(342)}', '${id(331)}', 'bom_review', 2, '{}'::jsonb, 0, '2024-03-01T00:00:00Z'),
      ('${id(343)}', '${id(331)}', 'cad_review', 3, '{}'::jsonb, 0, '2024-04-01T00:00:00Z'),
      -- A session with no tie, whose numbering must not move.
      ('${id(344)}', '${id(332)}', 'requirements_review', 1, '{}'::jsonb, 0, '2024-01-01T00:00:00Z'),
      ('${id(345)}', '${id(332)}', 'bom_review', 5, '{}'::jsonb, 0, '2024-02-01T00:00:00Z');
  `
}

/**
 * Two enrolled users and one signature written before `hash_version` existed.
 *
 * The signature deliberately names a *third* user as its signer. Its own
 * foreign key to `users` is ON DELETE NO ACTION, so a signer who also held an
 * enrollment would be protected by two constraints at once and which one
 * Postgres named in the error would be an implementation detail to depend on.
 */
function signingCredentialSeed() {
  const U3 = id(353)
  return `
    ${USERS}
    insert into users (id, email, name) values
      ('${U3}', 'three@fixture.invalid', 'User Three');

    insert into signing_credentials
      (id, user_id, cert_thumbprint, cert_subject_dn, cert_issuer_dn, cert_serial, revoked_at)
    values
      -- An active enrollment.
      ('${id(350)}', '${U1}', 'thumb-350', 'CN=One', 'CN=CA', '350', null),
      -- A revoked one. Revoked rows are kept as history deliberately, so this
      -- user is protected by the restrict too.
      ('${id(351)}', '${U2}', 'thumb-351', 'CN=Two', 'CN=CA', '351', '2024-01-01T00:00:00Z');

    insert into digital_signatures
      (id, subject_type, subject_id, chain_scope, signer_user_id, signer_name,
       decision, meaning, method, assurance, signed_payload, payload_hash, chain_hash)
    values
      ('${id(352)}', 'workflow_vote', '${id(354)}', 'global', '${U3}', 'User Three',
       'approve', 'I approve this change', 'password', 'basic',
       '{}'::jsonb, 'p352', 'c352');
  `
}

/* ------------------------------------------------------------------ *
 * The ratchet
 * ------------------------------------------------------------------ */

/**
 * Statements that qualify above but provably cannot behave differently against
 * rows than against an empty database, each with the argument for why.
 *
 * This exists so that the answer to an inert statement is never "narrow the
 * classifier" — that is exactly how the writes-only version of this check came
 * to miss a whole family. An entry is `{ tag, statement, why }`, where
 * `statement` is one of the strings `rowDependentStatements` produces, and it
 * is checked for staleness below: an entry naming a migration or a statement
 * that no longer qualifies fails the run rather than sitting here unread.
 *
 * Prefer a scenario. An argument is only better than an execution when there
 * is genuinely nothing to execute.
 */
/**
 * The domain-event sequencing migration, named by what it builds for the same
 * reason as the helpers above: the tag differs per edition.
 */
function DOMAIN_EVENTS_TAG() {
  const found = migrations.find((m) =>
    m.sql.some((s) => s.includes('domain_events_assign_seq')),
  )
  if (!found) {
    throw new Error(
      'No migration creates domain_events_assign_seq — the CANNOT_ABORT entry names a file that no longer exists.',
    )
  }
  return found.tag
}

const CANNOT_ABORT = [
  {
    tag: DOMAIN_EVENTS_TAG(),
    statement: 'UPDATE',
    why:
      'The UPDATE is inside a CREATE OR REPLACE FUNCTION body — the trigger ' +
      'that assigns domain_events.seq at commit — so the migration defines it ' +
      'and never executes it. It qualifies only because bareSql() strips ' +
      'ordinary string literals but not $$ … $$ dollar-quoting, which leaves ' +
      'the function body looking like statements the migration runs. Against ' +
      'a populated database the migration still creates one sequence, two ' +
      'tables, three indexes and this function: there are no rows for it to ' +
      'depend on, and the table it writes is the one it has just created. A ' +
      'replay scenario is the wrong tool because there is nothing to execute.',
  },
  {
    tag: DOMAIN_EVENTS_TAG(),
    statement: 'ADD CONSTRAINT on "webhook_deliveries"',
    why:
      'The constraint is the foreign key from webhook_deliveries to ' +
      'webhook_subscriptions, and the same migration CREATEs both tables two ' +
      'statements earlier. Postgres validates an ADD CONSTRAINT against the ' +
      'rows already in the table, and a table this migration just created has ' +
      'none — there is no database, populated or otherwise, in which this ' +
      'statement can find a violating row. The classifier is right to be ' +
      'coarse here: it deliberately does not track whether a table was created ' +
      'in the same file, because that reasoning is exactly what goes wrong ' +
      'silently. So the argument is recorded rather than the classifier ' +
      'narrowed. A scenario would seed a table that does not exist yet.',
  },
]

function runRatchet() {
  const covered = new Set(SCENARIOS.map((s) => s.tag))
  const qualifying = migrations
    .map((m) => ({ tag: m.tag, statements: rowDependentStatements(m) }))
    .filter((m) => m.statements.length > 0)

  let ok = true

  // A stale exemption is worse than none: it reads as a considered decision
  // about a statement that is no longer there.
  const stale = CANNOT_ABORT.filter(
    (entry) =>
      !qualifying.some(
        (m) => m.tag === entry.tag && m.statements.includes(entry.statement),
      ),
  )
  if (stale.length > 0) {
    console.error(
      [
        '',
        '✗ CANNOT_ABORT names a statement that no longer qualifies:',
        ...stale.map((e) => `     ${e.tag}: ${e.statement}`),
        '',
        '   Delete the entry. Whatever it was arguing about is gone.',
        '',
      ].join('\n'),
    )
    ok = false
  }

  const uncovered = qualifying
    .filter((m) => !covered.has(m.tag))
    .map((m) => ({
      tag: m.tag,
      statements: m.statements.filter(
        (s) => !CANNOT_ABORT.some((e) => e.tag === m.tag && e.statement === s),
      ),
    }))
    .filter((m) => m.statements.length > 0)

  if (uncovered.length === 0) return ok

  console.error(
    [
      '',
      "✗ A migration's outcome depends on rows and no scenario exercises it:",
      ...uncovered.flatMap((m) => [
        `     ${dir}/drizzle/${m.tag}.sql`,
        `       ${m.statements.join(', ')}`,
      ]),
      '',
      '   Applying that SQL to an empty database proves nothing — the UPDATE',
      '   matches no rows, the DELETE removes none, and the constraint',
      '   validates against nothing. Add a scenario to',
      '   scripts/check-migration-backfills.mjs: seed the shape of data the',
      '   statement exists to handle, then assert what it did to it. A',
      '   statement that is meant to abort gets an `expectAbort` scenario.',
      '',
      '   If the statement genuinely cannot behave differently against rows —',
      '   a constraint the database already enforced, say — record the',
      '   argument in CANNOT_ABORT rather than narrowing the classifier.',
      '',
    ].join('\n'),
  )
  return false
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

const sql = postgres(url, { max: 1, onnotice: () => {} })
let failures = 0

try {
  console.log(
    `Replaying ${dir}/drizzle against populated databases ` +
      `(${SCENARIOS.length} scenarios, ${migrations.length} migrations).\n`,
  )

  for (const scenario of SCENARIOS) {
    const target = migrations.findIndex((m) => m.tag === scenario.tag)
    if (target === -1) {
      console.error(`✗ ${scenario.tag} — ${scenario.name}`)
      console.error(`     no such migration in ${dir}/drizzle`)
      failures += 1
      continue
    }

    let twice = ''
    try {
      await resetDatabase(sql)
      for (let i = 0; i < target; i += 1) {
        await applyMigration(sql, migrations[i])
      }
      await scenario.seed(sql)

      if (scenario.expectAbort) {
        let thrown = null
        try {
          await applyMigration(sql, migrations[target])
        } catch (error) {
          thrown = error
        }
        expect(
          thrown !== null,
          'the migration was expected to abort, and did not',
        )
        expectEqual(thrown.code, scenario.expectAbort.code, 'SQLSTATE')
        if (scenario.expectAbort.constraint) {
          expectEqual(
            thrown.constraint_name,
            scenario.expectAbort.constraint,
            'violated constraint',
          )
        }
        expectEqual(
          await appliedCount(sql),
          target,
          'the aborted migration must leave the journal where it was',
        )
        await scenario.assertRollback(sql)
      } else {
        await applyMigration(sql, migrations[target])
        expectEqual(
          await appliedCount(sql),
          target + 1,
          'the applied migration should be recorded in the journal',
        )
        await scenario.assert(sql)
        if (isDataOnly(migrations[target]) || scenario.applyTwice) {
          await reapplyMigration(sql, migrations[target])
          try {
            await scenario.assert(sql)
          } catch (error) {
            throw new Failed(
              `after being applied a second time — which db:migrate does on ` +
                `a database db:baseline placed — ${describe(error)}`,
            )
          }
          twice = ' (and a second time)'
        }
      }

      console.log(`✓ ${scenario.tag} — ${scenario.name}${twice}`)
    } catch (error) {
      failures += 1
      console.error(`✗ ${scenario.tag} — ${scenario.name}`)
      console.error(`     ${describe(error)}`)
    }
  }

  if (!runRatchet()) failures += 1

  if (failures === 0) {
    console.log(
      `\n✅ Every data-dependent migration behaves as documented against rows.`,
    )
  } else {
    console.error(`\n${failures} check(s) failed.`)
  }
} finally {
  await sql.end({ timeout: 5 })
}

process.exit(failures === 0 ? 0 : 1)
