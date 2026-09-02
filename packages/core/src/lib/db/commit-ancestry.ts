// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

/**
 * The recursive walk from a commit to every ancestor, in the two shapes this
 * codebase needs.
 *
 * Both were hand-written at six call sites and had drifted into disagreeing
 * about the one decision that matters: `CommitService` walked with `UNION`
 * three times, `VersionResolver` with `UNION ALL` three times. They are said
 * once here so the question stops being askable at a call site.
 *
 * ## Why `UNION ALL` was wrong
 *
 * A recursive term joined on `parent_id OR merge_parent_id` enumerates *paths*,
 * not nodes. ECO-as-Branch manufactures the topology that makes that expensive:
 * a branch is cut at main's head, its commits parent onto that chain, and
 * `createMergeCommit` writes `parent_id` = main's head together with
 * `merge_parent_id` = the ECO's head. Every release therefore closes a diamond,
 * and every diamond doubles the number of distinct root-to-head paths. Simulated
 * row counts for the walk after N releases on one design: N=10 → 3,070;
 * N=20 → 3.1M; N=25 → 100M; N=30 → 3.2B. This runs on the design item grid.
 *
 * The comment that stood over one of those sites reasoned "a diamond ancestor
 * is revisited at most once per extra path, and the DISTINCT ON collapse keeps
 * exactly one row per commit". Both halves are true. The arithmetic still fails,
 * because the number of paths is the thing that grows, and the collapse happens
 * after the walk has already produced its rows.
 *
 * ## Why swapping the keyword is safe, and why it is not the whole fix
 *
 * `UNION` dedupes on the whole row. In {@link commitAncestorDepthCte} that row
 * is `(id, parent_id, merge_parent_id, created_at, depth)`, and `id` functionally
 * determines the middle three — so two rows are equal exactly when the same
 * commit was reached at the same depth. Every consumer wraps this in
 * `SELECT DISTINCT ON (id) … ORDER BY id, depth`, which keeps the minimum-depth
 * row per commit; discarding exact duplicates beforehand cannot change which row
 * that is. The output is identical and the work is strictly less.
 *
 * It bounds the walk to one row per commit *per distinct depth* rather than one
 * per path — polynomial rather than exponential — which is the difference
 * between a page that slows down and a page that stops answering. Collapsing
 * fully to one row per commit means dropping `depth` from the recursive term and
 * deriving it outside, which changes the resolution ordering the versioning core
 * depends on. That is a larger change and wants the merge-heavy fixture first:
 * the existing equivalence oracle is structurally blind here, because both its
 * arms share this walk and its fixture is purely linear.
 */

/**
 * Ancestors as a **set** — one row per reachable commit, no ordering.
 *
 * For membership questions: is this commit an ancestor of that one, what is the
 * common ancestry of two heads. Carries no `depth`, so `UNION` collapses it to
 * exactly one row per commit.
 *
 * Emit after `WITH RECURSIVE`:
 * ``sql`WITH RECURSIVE ${commitAncestorSetCte(id)} SELECT id FROM commit_ancestors` ``
 */
export function commitAncestorSetCte(commitId: string): SQL {
  return sql`
    commit_ancestors AS (
      SELECT c.id, c.parent_id, c.merge_parent_id
      FROM commits c WHERE c.id = ${commitId}
      UNION
      SELECT c.id, c.parent_id, c.merge_parent_id
      FROM commits c
      INNER JOIN commit_ancestors ca
        ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
    )`
}

/**
 * Ancestors **ranked by distance** — `(id, depth, created_at)`, for consumers
 * that resolve "the most recent version at or before this commit".
 *
 * Pair with {@link ancestorsDedupedCte}, which is the `DISTINCT ON` collapse
 * every consumer applies to it.
 */
export function commitAncestorDepthCte(commitId: string): SQL {
  return sql`
    commit_ancestors AS (
      SELECT c.id, c.parent_id, c.merge_parent_id, c.created_at, 0 AS depth
      FROM commits c WHERE c.id = ${commitId}
      UNION
      SELECT c.id, c.parent_id, c.merge_parent_id, c.created_at, ca.depth + 1
      FROM commits c
      INNER JOIN commit_ancestors ca
        ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
    )`
}

/**
 * One row per ancestor commit at its shallowest depth, named `ancestors`.
 *
 * Always follows {@link commitAncestorDepthCte}; kept beside it so the pair
 * cannot drift apart the way the six hand-written copies did.
 */
export const ancestorsDedupedCte: SQL = sql`
    ancestors AS (
      SELECT DISTINCT ON (id) id, depth, created_at
      FROM commit_ancestors
      ORDER BY id, depth
    )`
