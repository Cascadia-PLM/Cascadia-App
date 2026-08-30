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
 * Two design choices worth knowing:
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
 * The ratchet at the end is the half that keeps this honest. A new migration
 * that touches rows and registers no scenario fails the check, so this hole
 * cannot quietly reopen the next time someone writes a backfill.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config as loadEnv } from 'dotenv'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'

import { resolveApp } from './edition.mjs'

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
// for the same reason, as packages/core/src/__tests__/global-setup.ts. Deriving
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
const migrationsFolder = resolve(repoRoot, 'apps', app, 'drizzle')

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
async function applyMigration(sql, migration) {
  await sql.begin(async (tx) => {
    for (const statement of migration.sql) {
      // Drizzle executes every chunk, including a whitespace-only trailing one
      // that a file ending in a breakpoint would produce. An empty statement is
      // a no-op there and an error over the extended protocol here, so it is
      // the one thing skipped.
      if (statement.trim() === '') continue
      await tx.unsafe(statement)
    }
    await tx.unsafe(
      `insert into ${MIGRATIONS_TABLE} ("hash", "created_at") values ($1, $2)`,
      [migration.hash, migration.folderMillis],
    )
  })
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
]

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

/* ------------------------------------------------------------------ *
 * The ratchet
 * ------------------------------------------------------------------ */

/** Strip comments and string literals, so keyword matching sees only SQL. */
function bareSql(statement) {
  return statement
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/** Does this migration contain a statement that reads or writes existing rows? */
function touchesRows(migration) {
  return migration.sql.some((statement) =>
    /(^|;)\s*(update|delete|insert)\s/i.test(bareSql(statement)),
  )
}

function runRatchet() {
  const covered = new Set(SCENARIOS.map((s) => s.tag))
  const uncovered = migrations
    .filter((m) => touchesRows(m) && !covered.has(m.tag))
    .map((m) => m.tag)
  if (uncovered.length === 0) return true

  console.error(
    [
      '',
      '✗ A migration touches rows and no scenario exercises it:',
      ...uncovered.map((tag) => `     apps/${app}/drizzle/${tag}.sql`),
      '',
      '   Applying that SQL to an empty database proves nothing — the UPDATE',
      '   matches no rows and the DELETE removes none. Add a scenario to',
      '   scripts/check-migration-backfills.mjs: seed the shape of data the',
      '   statement exists to handle, then assert what it did to it. A',
      '   statement that is meant to abort gets an `expectAbort` scenario.',
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
    `Replaying apps/${app}/drizzle against populated databases ` +
      `(${SCENARIOS.length} scenarios, ${migrations.length} migrations).\n`,
  )

  for (const scenario of SCENARIOS) {
    const target = migrations.findIndex((m) => m.tag === scenario.tag)
    if (target === -1) {
      console.error(`✗ ${scenario.tag} — ${scenario.name}`)
      console.error(`     no such migration in apps/${app}/drizzle`)
      failures += 1
      continue
    }

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
      }

      console.log(`✓ ${scenario.tag} — ${scenario.name}`)
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
