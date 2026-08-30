// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The decision `boot-migrate.ts` makes, with nothing else attached.
 *
 * Its own module because importing `boot-migrate.ts` opens a database
 * connection and then runs — so a test of the decision would have to boot the
 * thing it is testing. Nothing here imports anything.
 */

export type MigrationState = 'migrate' | 'refuse'

/**
 * Which of three states a database is in, and therefore what boot may do:
 *
 *   journal has entries          → migrate (fresh or current, both are the same)
 *   journal empty, tables exist  → refuse  (a pre-0.5 database, push-created)
 *   journal empty, no tables     → migrate (fresh install: baseline + the rest)
 *
 * The middle case is the one that matters. Those databases got their schema
 * from `db:push`, which records nothing, so migrate would replay the baseline
 * from the top and fail on its first CREATE TABLE — or partially apply.
 */
export function classifyMigrationState(
  journalCount: number,
  liveTables: ReadonlySet<string>,
  expectedTables: ReadonlyArray<string>,
): MigrationState {
  if (journalCount > 0) return 'migrate'
  // Any table the schema defines is enough. A partially-created database is
  // still one nobody should replay a baseline over.
  return expectedTables.some((t) => liveTables.has(t)) ? 'refuse' : 'migrate'
}
