// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which statements in a migration have an outcome that depends on rows that
 * were already in the database.
 *
 * This is the classifier behind the ratchet in `check-migration-backfills.mjs`,
 * which fails when such a migration ships without a scenario proving what it
 * does to real rows. It lives in its own module because a lint that quietly
 * stops matching is indistinguishable from a clean tree — the exact failure the
 * ratchet exists to prevent one level up — so it has a test of its own, and a
 * test cannot import a file that connects to a database on load.
 *
 * "Depends on rows" is two families, not one. The writes — `UPDATE`, `DELETE`,
 * `INSERT` — are the obvious half. The other half is DDL Postgres validates
 * against every existing row before it will commit: `ADD CONSTRAINT`,
 * `VALIDATE CONSTRAINT`, `SET NOT NULL`, a `NOT NULL` column added without a
 * default, a column whose type changes, and `CREATE UNIQUE INDEX`. Those are
 * precisely the statements that *abort* an upgrade rather than silently doing
 * nothing, and an empty database judges them no better than it judges a
 * backfill. Classifying only the writes is how a constraint-validating
 * migration once shipped with no scenario at all.
 */

/** Strip comments and string literals, so keyword matching sees only SQL. */
function bareSql(statement) {
  return statement
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/** The table an `ALTER TABLE` names, or null if the statement is not one. */
function alterTarget(bare) {
  const match =
    /^\s*alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?"?(?:public"?\s*\.\s*"?)?([\w$]+)"?/i.exec(
      bare,
    )
  return match ? match[1] : null
}

/** The table a `CREATE TABLE` creates, or null. */
function createdTable(bare) {
  const match =
    /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public"?\s*\.\s*"?)?([\w$]+)"?/i.exec(
      bare,
    )
  return match ? match[1] : null
}

/**
 * If this statement's success depends on the rows already in its table, what
 * kind it is and which table — otherwise null.
 *
 * Every entry here is DDL Postgres validates against existing rows before it
 * will commit, which is the same thing as saying it is DDL that can abort an
 * upgrade. `ADD COLUMN … NOT NULL` is on the list only when it carries no
 * default: with one, Postgres fills the existing rows and cannot fail; without
 * one, the first row already in the table refuses it.
 *
 * A `DROP CONSTRAINT` or a `RENAME CONSTRAINT` validates nothing and is
 * deliberately absent — that is why the seventeen-rename migration needs no
 * scenario. `ADD CONSTRAINT … NOT VALID` is absent for the same reason: it is
 * the half of the low-lock pattern that explicitly does *not* read the rows.
 * The other half, `VALIDATE CONSTRAINT`, is where that pattern can abort, so
 * it is on the list.
 */
function validatingStatement(bare) {
  const table = alterTarget(bare)
  if (table) {
    if (/\bvalidate\s+constraint\b/i.test(bare))
      return { what: 'VALIDATE CONSTRAINT', table }
    if (/\badd\s+constraint\b/i.test(bare) && !/\bnot\s+valid\b/i.test(bare))
      return { what: 'ADD CONSTRAINT', table }
    if (/\bset\s+not\s+null\b/i.test(bare))
      return { what: 'SET NOT NULL', table }
    if (/\bset\s+data\s+type\b/i.test(bare))
      return { what: 'SET DATA TYPE', table }
    if (
      /\badd\s+column\b/i.test(bare) &&
      /\bnot\s+null\b/i.test(bare) &&
      !/\bdefault\b/i.test(bare)
    ) {
      return { what: 'ADD COLUMN … NOT NULL', table }
    }
    return null
  }
  const unique =
    /^\s*create\s+unique\s+index\b[\s\S]*?\bon\s+(?:only\s+)?"?(?:public"?\s*\.\s*"?)?([\w$]+)"?/i.exec(
      bare,
    )
  return unique ? { what: 'CREATE UNIQUE INDEX', table: unique[1] } : null
}

/**
 * Every statement in this migration whose outcome depends on rows that were
 * already there, described the way the ratchet's message names them.
 *
 * Validating DDL counts only against a table this file did *not* just create.
 * That exclusion is what keeps the two baselines out — each `0000` constrains
 * the dozens of tables it creates in the same file, where "the rows already
 * present" is the empty set by construction — and it is a reason rather than a
 * special case,
 * so a later migration that both creates a table and constrains an older one
 * is still caught on the older one.
 */
function rowDependentStatements(migration) {
  const created = new Set()
  const found = []
  for (const statement of migration.sql) {
    const bare = bareSql(statement)
    const write = /(^|;)\s*(update|delete|insert)\s/i.exec(bare)
    if (write) found.push(write[2].toUpperCase())
    const validating = validatingStatement(bare)
    if (validating && !created.has(validating.table)) {
      found.push(`${validating.what} on "${validating.table}"`)
    }
    const creates = createdTable(bare)
    if (creates) created.add(creates)
  }
  return [...new Set(found)]
}

export { rowDependentStatements }
