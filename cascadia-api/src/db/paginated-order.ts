// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { asc } from 'drizzle-orm'
import type { Column, SQL } from 'drizzle-orm'

/**
 * An ORDER BY for a query that also uses LIMIT/OFFSET, with the total order a
 * stable page needs.
 *
 * `LIMIT`/`OFFSET` paging is only coherent if the sort is a *total* order.
 * Postgres is free to return tied rows in a different sequence per query, so
 * a page boundary that falls inside a run of ties silently repeats some rows
 * and skips others — no error, wrong data. `created_at` is the worst offender
 * because it is the transaction timestamp: every row written by one seed, bulk
 * import or ECO merge shares it exactly. Sorting on a state or a type ties far
 * more heavily still.
 *
 * This codebase has learned that twice and lost it twice — CommitService and
 * DesignService were each fixed for it in their own incident — and the clearest
 * evidence that a comment is not sufficient memory here sits inside one file:
 * `ItemSearchService.buildGlobalOrderByClause` appends the tiebreaker under the
 * comment "Secondary key keeps paging stable when the primary has ties", and
 * `buildOrderByClause`, 260 lines below it, does not.
 *
 * So the tiebreaker is a required argument rather than a convention. Pass the
 * primary sort and the table's id.
 *
 * The tiebreaker is always appended, never conditionally: a sort key that
 * follows one already unique can never be consulted, so re-appending an id to a
 * list that ends in one is a no-op rather than something to detect. Trying to
 * detect it would be worse than useless — callers pass `asc(table.id)`, which is
 * an `SQL` wrapper rather than the `Column`, so an identity check would silently
 * never match and the guard would read as protection it does not give.
 *
 * ```ts
 * .orderBy(...paginatedOrderBy(desc(jobs.createdAt), jobs.id))
 * .orderBy(...paginatedOrderBy(sortOrder, reports.id))
 * ```
 */
export function paginatedOrderBy(
  primary: SQL | Array<SQL>,
  tiebreaker: Column,
): Array<SQL> {
  const terms = Array.isArray(primary) ? primary : [primary]
  return [...terms, asc(tiebreaker)]
}
