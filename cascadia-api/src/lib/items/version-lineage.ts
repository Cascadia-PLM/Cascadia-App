// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import { items } from '../db/schema/items'
import { RevisionService } from '../services/RevisionService'

/**
 * Reading a stored reference to an item **version** across a revision.
 *
 * Anything that names another item names one row of it — `item_relationships`
 * edges, and the type-specific pointer columns (`requirements.parent_requirement_id`)
 * that do the same job with a foreign key. A revision moves only the referring
 * item's own side: `createRevisionWorkingCopy` copies its outgoing edges onto
 * the working copy and the merge rebuilds them on the released row, while
 * everything pointing the other way is left exactly where it was. Reading by
 * exact `items.id` therefore goes wrong in both directions the moment anything
 * is revised, and these three primitives are the whole correction:
 *
 * | Direction                  | Rule                                                                              |
 * | -------------------------- | --------------------------------------------------------------------------------- |
 * | Outgoing — what do I name? | `followSupersededRows`: follow a stale reference forward                          |
 * | Incoming — who names me?   | `resolveInheritedLineage` for what a row inherited, `findSupersededRows` to drop   |
 * |                            | the claims a revision left behind                                                 |
 *
 * The asymmetry is deliberate, and is why these are two rules and not one. A
 * stale **reference** is stale only in the id: the statement is the referring
 * item's own content and still means what it says, so it is followed forward.
 * A stale **claim** is stale outright: the new revision carries its own copy
 * whenever it still means it, so following the old row's claim forward would
 * re-assert something the change order may have dropped on purpose.
 *
 * Consumers: `ItemRelationshipService` for the edge table, `RequirementService`
 * for the derive hierarchy's pointer column. A new pointer column has to be
 * routed through here too — this defect has been found once per path that
 * answered the question for itself, three times so far.
 */

/**
 * Which of `ids` name a row a release left behind.
 *
 * The one predicate behind every version-aware read here: not its master's
 * current row, and not a working copy. Working revisions are excluded rather
 * than "everything that is not current" because a reference pointing at a
 * working copy is a branch's own edit and must be left exactly where it points.
 */
export async function findSupersededRows(
  ids: Array<string>,
): Promise<Array<{ id: string; masterId: string }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []

  const rows = await db
    .select({
      id: items.id,
      masterId: items.masterId,
      isCurrent: items.isCurrent,
      revision: items.revision,
    })
    .from(items)
    .where(inArray(items.id, unique))

  return rows
    .filter(
      (row) =>
        !row.isCurrent && !RevisionService.isWorkingRevision(row.revision),
    )
    .map((row) => ({ id: row.id, masterId: row.masterId }))
}

/**
 * Map any id that names a *superseded* revision onto the revision that
 * replaced it. Ids already current, and ids naming a working copy, are absent
 * from the result.
 *
 * A reference names one item version, and a merge re-points only the lines
 * owned by the items the change order touched. An assembly the change order
 * never touched therefore keeps naming the row the release superseded, and its
 * BOM reads back a revision behind — showing the child as `Superseded` and
 * linking to the row nobody should be working from.
 *
 * Only superseded rows are followed. A line pointing at a *working* copy is a
 * branch's own edit and must be left exactly where it points, which is why the
 * working revision is excluded rather than every non-current row.
 */
export async function followSupersededRows(
  ids: Array<string>,
): Promise<Map<string, string>> {
  const redirects = new Map<string, string>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return redirects

  const stale = await findSupersededRows(unique)
  if (stale.length === 0) return redirects

  const currentRows = await db
    .select({ id: items.id, masterId: items.masterId })
    .from(items)
    .where(
      and(
        inArray(
          items.masterId,
          stale.map((row) => row.masterId),
        ),
        eq(items.isCurrent, true),
        notDeleted(),
      ),
    )

  const currentByMaster = new Map(
    currentRows.map((row) => [row.masterId, row.id] as const),
  )
  for (const row of stale) {
    const current = currentByMaster.get(row.masterId)
    if (current && current !== row.id) {
      redirects.set(row.id, current)
    }
  }

  return redirects
}

/**
 * The rows whose *incoming* references belong to each of `itemIds`, mapped
 * back to the item that answers for them.
 *
 * `followSupersededRows` is the same fact read forwards. A reference names one
 * item version, and a merge re-points only the lines owned by the items the
 * change order touched — so when an ECO revises a requirement, the test cases
 * and parts that point at it, and the children derived from it, keep naming
 * the revision it superseded. Reading incoming references by exact id
 * therefore loses them: the new revision reports zero verifying tests and zero
 * children, for a requirement whose V&V and decomposition never changed.
 *
 * Expansion runs one way only, which is what keeps it safe:
 *
 * - a **current** row inherits the superseded rows behind it;
 * - a **working copy** inherits the released lineage it was cut from, so a
 *   requirement opened inside an ECO still shows the coverage it arrived with;
 * - a **superseded** row names only itself, so reading an old revision still
 *   reports what that revision actually had.
 *
 * Nothing ever inherits from a working revision. That is the branch isolation
 * guarantee: a reference recorded inside one ECO stays invisible to main and
 * to every other branch until the merge promotes it.
 *
 * An id passed in always answers for itself, so a caller that names two
 * revisions of one master gets each one's own references rather than one
 * swallowing the other.
 */
export async function resolveInheritedLineage(
  itemIds: Array<string>,
): Promise<Map<string, string>> {
  const lineage = new Map<string, string>()
  const named = [...new Set(itemIds)]
  if (named.length === 0) return lineage
  for (const id of named) lineage.set(id, id)

  const namedRows = await db
    .select({
      id: items.id,
      masterId: items.masterId,
      isCurrent: items.isCurrent,
      revision: items.revision,
    })
    .from(items)
    .where(inArray(items.id, named))

  // The complement of `findSupersededRows`: a row a release left behind
  // inherits nothing, so an old revision still reports what it had.
  const inheritors = namedRows.filter(
    (row) => row.isCurrent || RevisionService.isWorkingRevision(row.revision),
  )
  if (inheritors.length === 0) return lineage

  const inheritorByMaster = new Map(
    inheritors.map((row) => [row.masterId, row.id] as const),
  )

  const lineageRows = await db
    .select({
      id: items.id,
      masterId: items.masterId,
      revision: items.revision,
    })
    .from(items)
    .where(
      and(inArray(items.masterId, [...inheritorByMaster.keys()]), notDeleted()),
    )

  for (const row of lineageRows) {
    if (lineage.has(row.id)) continue
    if (RevisionService.isWorkingRevision(row.revision)) continue
    const inheritor = inheritorByMaster.get(row.masterId)
    if (inheritor) lineage.set(row.id, inheritor)
  }

  return lineage
}
