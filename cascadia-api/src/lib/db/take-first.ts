// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Row accessors for Drizzle query results.
 *
 * Drizzle types every `.returning()` / `.select()` as `T[]`, so the ubiquitous
 * `const [row] = await db.insert(...).returning()` yields `T | undefined` under
 * `noUncheckedIndexedAccess` even when the statement provably returns a row.
 * These helpers turn that into a real runtime check instead of a `!` assertion,
 * so a genuinely empty result surfaces as a clear error rather than a
 * downstream `Cannot read properties of undefined`.
 */

/**
 * Returns the first row, throwing if there is none.
 *
 * Use for statements that must produce a row: single-row inserts, updates and
 * deletes with `.returning()`, and selects already known to match.
 */
export function takeFirst<T>(rows: Array<T>, what = 'row'): T {
  const row = rows[0]
  if (row === undefined) {
    throw new Error(`Expected at least one ${what}, got none`)
  }
  return row
}

/**
 * Returns the first row or `undefined`.
 *
 * Use for lookups where "no match" is a normal outcome the caller handles.
 * This is only a typed alias for `rows[0]`, but it states the intent at the
 * call site and pairs with {@link takeFirst}.
 */
export function takeFirstOrUndefined<T>(rows: Array<T>): T | undefined {
  return rows[0]
}
