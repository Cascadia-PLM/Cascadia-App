// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The classifier behind the ratchet in `check-migration-backfills.mjs`.
 *
 * This is the same shape of test as `check-permission-tuples.test.ts`, for the
 * same reason: a lint that quietly stops matching is indistinguishable from a
 * clean tree, which is exactly the failure the ratchet exists to prevent one
 * level up. The writes-only version of this classifier waved a
 * constraint-validating migration through with no scenario at all, and the
 * check printed a tick for it.
 *
 * The cases are written as SQL rather than as calls, because the thing under
 * test is a reading of SQL. Most of them describe statements no migration in
 * either journal contains yet — which is the point: the run against the real
 * journals only exercises what has already been written.
 *
 * Run: npx vitest run scripts/migration-row-dependence.test.ts
 */

import { describe, expect, it } from 'vitest'
import { rowDependentStatements } from './migration-row-dependence.mjs'

/** What the classifier makes of a migration built from these statements. */
function classify(...sql: Array<string>): Array<string> {
  return rowDependentStatements({ sql })
}

describe('writes', () => {
  it('names each verb that touches rows', () => {
    expect(
      classify(
        'UPDATE "t" SET "c" = 1',
        'DELETE FROM "t"',
        'INSERT INTO "t" VALUES (1)',
      ),
    ).toEqual(['UPDATE', 'DELETE', 'INSERT'])
  })

  it('does not read a keyword inside a string literal as a statement', () => {
    expect(
      classify(`ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 'insert into x'`),
    ).toEqual([])
  })
})

describe('validating DDL', () => {
  it('classifies the statements Postgres checks every row against', () => {
    expect(
      classify(
        'ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("c") REFERENCES "public"."u"("id")',
        'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL',
        'ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE bigint',
        'CREATE UNIQUE INDEX "u" ON "public"."t" USING btree ("c")',
      ),
    ).toEqual([
      'ADD CONSTRAINT on "t"',
      'SET NOT NULL on "t"',
      'SET DATA TYPE on "t"',
      'CREATE UNIQUE INDEX on "t"',
    ])
  })

  it('is silent on DDL that reads no row', () => {
    // The seventeen-rename migration is made entirely of these, and needs no
    // scenario. A plain index cannot fail on rows either; only a unique one can.
    expect(
      classify(
        'ALTER TABLE "t" DROP CONSTRAINT "t_fk"',
        'ALTER TABLE "t" RENAME CONSTRAINT "a" TO "b"',
        'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL',
        'DROP INDEX "i"',
        'CREATE INDEX "i" ON "t" USING btree ("c")',
      ),
    ).toEqual([])
  })

  it('splits the low-lock pattern on the half that reads the rows', () => {
    // NOT VALID explicitly skips the scan; VALIDATE CONSTRAINT is the step
    // that performs it, and therefore the step that can abort an upgrade.
    expect(
      classify(
        'ALTER TABLE "t" ADD CONSTRAINT "t_ck" CHECK ("n" > 0) NOT VALID',
      ),
    ).toEqual([])
    expect(classify('ALTER TABLE "t" VALIDATE CONSTRAINT "t_ck"')).toEqual([
      'VALIDATE CONSTRAINT on "t"',
    ])
  })

  it('splits ADD COLUMN NOT NULL on whether it carries a default', () => {
    // With a default Postgres fills the rows already there and cannot fail;
    // without one, the first row already in the table refuses the statement.
    expect(
      classify('ALTER TABLE "t" ADD COLUMN "c" integer DEFAULT 1 NOT NULL'),
    ).toEqual([])
    expect(classify('ALTER TABLE "t" ADD COLUMN "c" integer NOT NULL')).toEqual(
      ['ADD COLUMN … NOT NULL on "t"'],
    )
  })
})

describe('tables the migration creates itself', () => {
  it('exempts a constraint on a table this file just created', () => {
    // What keeps the two baselines out: each `0000` constrains the dozens of
    // tables it creates in the same file, where "the rows already present" is
    // the empty set.
    expect(
      classify(
        'CREATE TABLE "t" (\n\t"id" uuid PRIMARY KEY\n)',
        'ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("id") REFERENCES "public"."u"("id")',
      ),
    ).toEqual([])
  })

  it('still catches a constraint that runs before its table is created', () => {
    // The exemption is "there were no rows yet", not "the name appears
    // somewhere in this file" — so it is decided in statement order.
    expect(
      classify(
        'ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("id") REFERENCES "public"."u"("id")',
        'CREATE TABLE "t" ("id" uuid PRIMARY KEY)',
      ),
    ).toEqual(['ADD CONSTRAINT on "t"'])
  })

  it('catches the older table when a migration does both', () => {
    expect(
      classify(
        'CREATE TABLE "new" ("id" uuid PRIMARY KEY)',
        'ALTER TABLE "new" ADD CONSTRAINT "new_ck" CHECK ("id" IS NOT NULL)',
        'ALTER TABLE "old" ADD CONSTRAINT "old_ck" CHECK ("id" IS NOT NULL)',
      ),
    ).toEqual(['ADD CONSTRAINT on "old"'])
  })
})
