// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * LIKE/ILIKE pattern builders for user-supplied search terms.
 *
 * A search box is a contains-box, not a pattern language: the characters a
 * user types must match themselves. `%` and `_` are wildcards to SQL, so an
 * unescaped term makes `A_1` match `AB1`, and a bare `%` match every row in
 * the table — a full scan the user never asked for.
 *
 * PostgreSQL's default LIKE/ILIKE escape character is backslash, so callers
 * using drizzle's `like()` / `ilike()` / `notLike()` / `notIlike()` need no
 * `ESCAPE` clause — drizzle emits `col like $1` and the default applies.
 * Callers writing raw SQL must append `ESCAPE '\\'` explicitly, as
 * `VersionResolver.itemFilterConditions` does.
 *
 * This module deliberately lives outside `lib/db/index.ts`: that module opens
 * the postgres connection, and these are pure string functions that route and
 * client-adjacent code should be able to import freely.
 */

/**
 * A user's search term as a LIKE operand.
 *
 * The in-memory path uses `String.includes`, where `%` and `_` are ordinary
 * characters. They are wildcards to `ILIKE`, so a search for `A_1` would
 * otherwise match `AB1` here and not there.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** `%term%` — matches rows containing the term literally. */
export function likeContains(term: string): string {
  return `%${escapeLikePattern(term)}%`
}

/** `term%` — matches rows starting with the term literally. */
export function likeStartsWith(term: string): string {
  return `${escapeLikePattern(term)}%`
}

/** `%term` — matches rows ending with the term literally. */
export function likeEndsWith(term: string): string {
  return `%${escapeLikePattern(term)}`
}
