// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  branchItems,
  branches,
  commits,
  itemVersions,
  items,
  tags,
} from '../db/schema'
import { notDeleted, notWorkingRevision } from '../db/filters'
import { likeContains } from '../db/like-pattern'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'

/**
 * Version context types for viewing items
 */
export type VersionContext =
  | { type: 'released'; designId: string } // main branch HEAD
  | { type: 'branch'; branchId: string } // any branch HEAD
  | { type: 'commit'; commitId: string } // specific commit
  | { type: 'tag'; tagId: string } // tag's commit

export interface ItemFilters {
  itemType?: string
  state?: string
  search?: string
  includeDeleted?: boolean
  limit?: number
  offset?: number
  // Server-side sorting
  sortField?: string
  sortDirection?: 'asc' | 'desc'
  // Column filters (text, multiSelect, or range)
  columnFilters?: Record<
    string,
    string | Array<string> | { min?: number; max?: number }
  >
  // Global search (across itemNumber and name)
  globalSearch?: string
}

export interface PaginatedItemsResult {
  items: Array<typeof items.$inferSelect>
  total: number
}

/**
 * Service for resolving item versions at different contexts
 */
interface PositionSortableItem {
  id: string
  createdAt: Date | string
}

export class VersionResolver {
  /**
   * Parse version context from query parameters
   */
  static parseContext(params: {
    designId?: string
    branch?: string
    commit?: string
    tag?: string
  }): VersionContext | null {
    // Priority: commit > tag > branch > released
    if (params.commit) {
      return { type: 'commit', commitId: params.commit }
    }
    if (params.tag) {
      return { type: 'tag', tagId: params.tag }
    }
    if (params.branch && params.designId) {
      // Need to look up branch ID from name
      return { type: 'branch', branchId: params.branch }
    }
    if (params.designId) {
      return { type: 'released', designId: params.designId }
    }
    return null
  }

  /**
   * Resolve a branch name to branch ID
   */
  static async resolveBranchContext(
    designId: string,
    branchName: string,
  ): Promise<VersionContext | null> {
    if (branchName === 'main' || branchName === 'released') {
      return { type: 'released', designId }
    }

    const branch = await BranchService.getByName(designId, branchName)
    if (!branch) {
      return null
    }
    return { type: 'branch', branchId: branch.id }
  }

  /**
   * Get an item at a specific version context
   */
  static async getItemAtContext(
    itemMasterId: string,
    designId: string,
    context: VersionContext,
  ): Promise<typeof items.$inferSelect | null> {
    switch (context.type) {
      case 'released':
        return this.getReleasedVersion(itemMasterId, designId)

      case 'branch':
        return this.getWorkingVersion(itemMasterId, context.branchId)

      case 'commit':
        return this.getItemAtCommit(itemMasterId, context.commitId)

      case 'tag':
        return this.getItemAtTag(itemMasterId, context.tagId)

      default:
        return null
    }
  }

  /**
   * Get items at a specific version context (list view)
   */
  static async getItemsAtContext(
    designId: string,
    context: VersionContext,
    filters?: ItemFilters,
  ): Promise<PaginatedItemsResult> {
    switch (context.type) {
      case 'released':
        return this.getReleasedItems(designId, filters)

      case 'branch':
        return this.getBranchItems(context.branchId, filters)

      case 'commit':
        return this.getItemsAtCommit(context.commitId, filters)

      case 'tag':
        return this.getItemsAtTag(context.tagId, filters)

      default:
        return { items: [], total: 0 }
    }
  }

  /**
   * Get the current released version of an item (main branch HEAD)
   */
  static async getReleasedVersion(
    itemMasterId: string,
    designId: string,
  ): Promise<typeof items.$inferSelect | null> {
    // Get the main branch
    const mainBranch = await DesignService.getDefaultBranch(designId)

    // If commits exist, try commit-based versioning first
    if (mainBranch?.headCommitId) {
      const commitItem = await this.getItemAtCommit(
        itemMasterId,
        mainBranch.headCommitId,
      )
      if (commitItem) {
        return commitItem
      }
      // Fall through to direct query if item not found in commit history
      // This handles cases where items were created directly (e.g., seed scripts)
      // but not yet committed to the version history
    }

    // Fallback: Query items directly when commits don't exist yet or item not in history
    // This supports pre-commit workflows where items are created but not committed
    // First try isCurrent = true, then fall back to any version with state = Released
    //
    // These fallbacks answer "what is released" without consulting the commit
    // graph, which is what makes them able to answer with a branch's
    // unreleased working copy: those carry a branch-scoped working revision
    // and are never part of main. Excluding that shape keeps a draft from
    // being served as the released version - `getAvailableContextsForItem`
    // refuses these fallbacks outright for the same reason.
    const isReleasedRevision = notWorkingRevision()

    let result = await db
      .select()
      .from(items)
      .where(
        and(
          eq(items.masterId, itemMasterId),
          eq(items.designId, designId),
          eq(items.isCurrent, true),
          isReleasedRevision,
          notDeleted(),
        ),
      )
      .limit(1)

    if (!result.at(0)) {
      // Fallback: the most recent released-lineage version, when no current
      // version exists. Released-family membership is per the item's own
      // lifecycle (every row of one master shares a type), never a name.
      const candidates = await db
        .select()
        .from(items)
        .where(
          and(
            eq(items.masterId, itemMasterId),
            eq(items.designId, designId),
            isReleasedRevision,
            notDeleted(),
          ),
        )
        .orderBy(desc(items.modifiedAt), desc(items.createdAt), items.id)
        .limit(10)
      const first = candidates.at(0)
      if (first) {
        const { LifecycleService } = await import('./LifecycleService')
        const family = await LifecycleService.getReleasedFamilyStates(
          first.itemType,
        )
        const released = candidates.find((c) => family.includes(c.state))
        result = released ? [released] : []
      }
    }

    // Final fallback: any version of this master in this design. Scoped to
    // the design - it used to match across designs entirely, so an unrelated
    // design's copy could answer a released-version query. Ordered — a bare
    // limit(1) let the heap pick between rows sharing the fallback window.
    if (!result.at(0)) {
      result = await db
        .select()
        .from(items)
        .where(
          and(
            eq(items.masterId, itemMasterId),
            eq(items.designId, designId),
            isReleasedRevision,
            notDeleted(),
          ),
        )
        .orderBy(desc(items.modifiedAt), desc(items.createdAt), items.id)
        .limit(1)
    }

    return result.at(0) || null
  }

  /**
   * Get the working version of an item on a branch
   */
  static async getWorkingVersion(
    itemMasterId: string,
    branchId: string,
  ): Promise<typeof items.$inferSelect | null> {
    // First check if there's a branchItem entry for this item
    const branchItem = await db
      .select()
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, branchId),
          eq(branchItems.itemMasterId, itemMasterId),
        ),
      )
      .limit(1)

    const tracked = branchItem.at(0)

    // Deleted on this branch: the row still points at the last version so the
    // merge knows what to retire, but at this branch's context the item is
    // gone. The list resolver already excluded these, so a deleted item
    // vanished from the branch's item list while its detail page still
    // rendered it as live.
    if (tracked?.changeType === 'deleted') {
      return null
    }

    const currentItemId = tracked?.currentItemId
    if (currentItemId) {
      // Return the branch-specific version
      const item = await db
        .select()
        .from(items)
        .where(and(eq(items.id, currentItemId), notDeleted()))
        .limit(1)
      return item.at(0) || null
    }

    // No branch-specific version, fall back to main
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      return null
    }

    return this.getReleasedVersion(itemMasterId, branch.designId)
  }

  /**
   * Get an item at a specific commit
   */
  static async getItemAtCommit(
    itemMasterId: string,
    commitId: string,
  ): Promise<typeof items.$inferSelect | null> {
    const commit = await db
      .select()
      .from(commits)
      .where(eq(commits.id, commitId))
      .limit(1)

    const commitRow = commit[0]
    if (!commitRow) {
      return null
    }

    // Walk backwards through commit history to find the item version
    return this.walkCommitHistory(itemMasterId, commitId, commitRow.designId)
  }

  /**
   * Get an item at a specific tag
   */
  static async getItemAtTag(
    itemMasterId: string,
    tagId: string,
  ): Promise<typeof items.$inferSelect | null> {
    const tag = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1)

    const tagRow = tag[0]
    if (!tagRow) {
      return null
    }

    return this.getItemAtCommit(itemMasterId, tagRow.commitId)
  }

  /**
   * Get all released items for a design
   */
  static async getReleasedItems(
    designId: string,
    filters?: ItemFilters,
  ): Promise<PaginatedItemsResult> {
    const mainBranch = await DesignService.getDefaultBranch(designId)
    if (!mainBranch) {
      return { items: [], total: 0 }
    }

    // If main branch has commits, try commit-based resolution.
    //
    // The question the fallbacks answer is "did commit resolution find this
    // design at all", so the test is the pre-pagination `total`, not whether
    // this particular page came back with rows. Asking for rows meant that
    // paging past the end of a released list — or any filter matching nothing
    // — looked like missing commit data and sent the query on to the
    // branchItems fallback to be answered from a different source, which
    // reported `total: 0` for a design holding hundreds of items.
    if (mainBranch.headCommitId) {
      const commitResult = await this.getItemsAtCommit(
        mainBranch.headCommitId,
        filters,
      )
      if (commitResult.total > 0) {
        return commitResult
      }
      // Fall through: commit exists but itemVersions may be empty (pre-release data)
    }

    // Fallback: no commits yet — try branchItems on main branch
    const mainBranchItemsList = await db
      .select({ currentItemId: branchItems.currentItemId })
      .from(branchItems)
      .where(eq(branchItems.branchId, mainBranch.id))

    const currentItemIds = mainBranchItemsList
      .map((bi) => bi.currentItemId)
      .filter((id): id is string => id !== null)

    if (currentItemIds.length > 0) {
      const result = await db
        .select()
        .from(items)
        .where(and(inArray(items.id, currentItemIds), notDeleted()))
      return this.applyFilters(result, filters)
    }

    // Final fallback: isCurrent items for the design. Working copies are
    // excluded - on a design whose work all happens on a branch, this
    // fallback otherwise listed that branch's drafts as main's contents.
    const result = await db
      .select()
      .from(items)
      .where(
        and(
          eq(items.designId, designId),
          eq(items.isCurrent, true),
          notWorkingRevision(),
          notDeleted(),
        ),
      )
    return this.applyFilters(result, filters)
  }

  /**
   * Get all items on a branch (including unchanged items from main).
   *
   * The overlay — main's contents at its head commit, with this branch's own
   * versions substituted in and its deletions removed — is computed in SQL
   * when main has commit history to resolve against, and in Node otherwise.
   * `getBranchItemsInMemory` carries the fallbacks for a design whose main
   * branch has no usable commit data: seeded rows, pre-release data, anything
   * `getReleasedItems` answers from `branchItems` or `isCurrent` instead.
   */
  static async getBranchItems(
    branchId: string,
    filters?: ItemFilters,
  ): Promise<PaginatedItemsResult> {
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      return { items: [], total: 0 }
    }

    if (this.canResolveAtCommitInSql(filters)) {
      const mainBranch = await DesignService.getDefaultBranch(branch.designId)
      if (mainBranch?.headCommitId) {
        const page = await this.resolveBranchItemIds(
          branchId,
          mainBranch.headCommitId,
          filters,
        )
        // `mainResolved` is the same gate `getReleasedItems` applies: no rows
        // from commit resolution means this design's released contents live
        // somewhere the commit graph cannot see, and the whole merge has to
        // happen over the fallback chain instead.
        if (page.mainResolved > 0) {
          if (page.ids.length === 0) {
            return { items: [], total: page.total }
          }
          const rows = await db
            .select()
            .from(items)
            .where(inArray(items.id, page.ids))
          const byId = new Map(rows.map((row) => [row.id, row]))
          return {
            items: page.ids
              .map((id) => byId.get(id))
              .filter((row): row is (typeof rows)[number] => row !== undefined),
            total: page.total,
          }
        }
      }
    }

    return this.getBranchItemsInMemory(branchId, filters)
  }

  /**
   * The item ids visible on a branch, filtered, counted and paginated by the
   * database.
   *
   * `main_items` is the commit resolution `resolveItemIdsAtCommit` performs,
   * against main's head. The overlay onto it reproduces the four cases the
   * in-memory merge distinguishes, and the order matters:
   *
   * - no `branch_items` row for the master — main's version stands
   * - `change_type = 'deleted'` — the item is gone on this branch
   * - a row with no `current_item_id` — main's version stands (it is tracked
   *   but not yet replaced)
   * - otherwise the branch's own version, and *nothing* if that row has since
   *   been deleted. Falling back to main's version there would resurrect an
   *   item the branch is holding a deleted working copy of, which is why the
   *   CASE yields NULL rather than `m.id`.
   *
   * `added` then contributes the masters that exist only on the branch —
   * items created there, and items tracked in `branch_items` but absent from
   * `item_versions` at all. Its "not deleted" test is `IS DISTINCT FROM`
   * rather than `<>`, because a plain checkout records no change type at all:
   * against a NULL, `<>` is neither true nor false, and the row was dropped
   * where the in-memory merge — which asks `changeType !== 'deleted'` — keeps
   * it.
   */
  private static async resolveBranchItemIds(
    branchId: string,
    headCommitId: string,
    filters?: ItemFilters,
  ): Promise<{ ids: Array<string>; total: number; mainResolved: number }> {
    const conditions = this.itemFilterConditions(filters, 'i')
    const limit = filters?.limit
    const offset = filters?.offset ?? 0

    const rows = await db.execute(sql`
      WITH RECURSIVE commit_ancestors AS (
        SELECT c.id, c.parent_id, c.merge_parent_id, c.created_at, 0 AS depth
        FROM commits c WHERE c.id = ${headCommitId}
        UNION ALL
        SELECT c.id, c.parent_id, c.merge_parent_id, c.created_at, ca.depth + 1
        FROM commits c
        INNER JOIN commit_ancestors ca
          ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
      ),
      ancestors AS (
        SELECT DISTINCT ON (id) id, depth, created_at
        FROM commit_ancestors
        ORDER BY id, depth
      ),
      resolved AS (
        SELECT DISTINCT ON (i.master_id)
               i.id, i.master_id, iv.change_type
        FROM item_versions iv
        INNER JOIN items i ON i.id = iv.item_id
        INNER JOIN ancestors a ON a.id = iv.commit_id
        INNER JOIN commits target ON target.id = ${headCommitId}
        WHERE i.design_id = target.design_id
          AND i.is_deleted IS NOT TRUE
        ORDER BY i.master_id,
                 a.depth ASC, a.created_at DESC, a.id ASC,
                 i.created_at DESC, i.id ASC
      ),
      main_items AS (
        SELECT id, master_id FROM resolved WHERE change_type <> 'deleted'
      ),
      tracked AS (
        SELECT item_master_id, current_item_id, change_type
        FROM branch_items WHERE branch_id = ${branchId}
      ),
      overlaid AS (
        SELECT CASE
                 WHEN t.item_master_id IS NULL THEN m.id
                 WHEN t.change_type = 'deleted' THEN NULL
                 WHEN t.current_item_id IS NULL THEN m.id
                 ELSE bv.id
               END AS id
        FROM main_items m
        LEFT JOIN tracked t ON t.item_master_id = m.master_id
        LEFT JOIN items bv
          ON bv.id = t.current_item_id AND bv.is_deleted IS NOT TRUE
      ),
      added AS (
        SELECT bv.id
        FROM tracked t
        INNER JOIN items bv
          ON bv.id = t.current_item_id AND bv.is_deleted IS NOT TRUE
        WHERE t.change_type IS DISTINCT FROM 'deleted'
          AND NOT EXISTS (
            SELECT 1 FROM main_items m WHERE m.master_id = t.item_master_id
          )
      ),
      merged AS (
        SELECT id FROM overlaid WHERE id IS NOT NULL
        UNION ALL
        SELECT id FROM added
      ),
      filtered AS (
        SELECT i.id, i.item_number
        FROM merged mg
        INNER JOIN items i ON i.id = mg.id
        WHERE ${sql.join(conditions, sql` AND `)}
      )
      SELECT counted.total, counted.main_resolved, page.id
      FROM (
        SELECT (SELECT COUNT(*) FROM filtered) AS total,
               (SELECT COUNT(*) FROM main_items) AS main_resolved
      ) counted
      LEFT JOIN (
        SELECT id, item_number FROM filtered
        ORDER BY item_number ASC, id ASC
        ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
        OFFSET ${offset}
      ) page ON TRUE
      ORDER BY page.item_number ASC NULLS LAST, page.id ASC
    `)

    const page = rows as unknown as Array<{
      id: string | null
      total: number | string
      main_resolved: number | string
    }>
    const first = page[0]
    if (!first) return { ids: [], total: 0, mainResolved: 0 }

    return {
      ids: page.map((row) => row.id).filter((id): id is string => id !== null),
      total: Number(first.total),
      mainResolved: Number(first.main_resolved),
    }
  }

  /**
   * Get all items on a branch, merged in Node.
   *
   * The fallback for designs whose main branch has no commit-resolvable
   * contents, and the reference the equivalence tests compare against.
   */
  private static async getBranchItemsInMemory(
    branchId: string,
    filters?: ItemFilters,
  ): Promise<PaginatedItemsResult> {
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      return { items: [], total: 0 }
    }

    // Get items modified on this branch
    const branchItemsList = await db
      .select()
      .from(branchItems)
      .where(eq(branchItems.branchId, branchId))

    // Build a map of masterId -> branchItem
    const branchItemMap = new Map<string, (typeof branchItemsList)[0]>()
    for (const bi of branchItemsList) {
      branchItemMap.set(bi.itemMasterId, bi)
    }

    // Get all released items WITHOUT pagination (we need all for merging)
    // Only pass non-pagination filters for consistency during merge
    const releasedResult = await this.getReleasedItems(branch.designId)

    // Every version this branch points at, in one read. Both loops below need
    // them, and fetching one per branch item made listing a branch cost a query
    // per item on it.
    const branchVersionIds = branchItemsList
      .map((bi) => bi.currentItemId)
      .filter((id): id is string => id !== null)
    const branchVersionById = new Map(
      branchVersionIds.length > 0
        ? (
            await db
              .select()
              .from(items)
              .where(and(inArray(items.id, branchVersionIds), notDeleted()))
          ).map((row) => [row.id, row])
        : [],
    )

    // Merge: use branch version if available, otherwise released version
    const result: Array<typeof items.$inferSelect> = []
    const processedMasterIds = new Set<string>()

    for (const item of releasedResult.items) {
      const branchItem = branchItemMap.get(item.masterId)
      if (branchItem?.currentItemId && branchItem.changeType !== 'deleted') {
        // Use branch version
        const branchVersionRow = branchVersionById.get(branchItem.currentItemId)
        if (branchVersionRow) {
          result.push(branchVersionRow)
        }
      } else if (!branchItem || branchItem.changeType !== 'deleted') {
        // Use released version
        result.push(item)
      }
      processedMasterIds.add(item.masterId)
    }

    // Add any branchItems not found in the released (commit history) set.
    // This covers items added on the branch AND items that are tracked in
    // branchItems but missing from itemVersions (e.g., pre-release items
    // that were added to the main branch before any ECO was released).
    for (const bi of branchItemsList) {
      if (
        !processedMasterIds.has(bi.itemMasterId) &&
        bi.currentItemId &&
        bi.changeType !== 'deleted'
      ) {
        const addedItemRow = branchVersionById.get(bi.currentItemId)
        if (addedItemRow) {
          result.push(addedItemRow)
        }
      }
    }

    // Apply filters (including pagination) to merged result
    return this.applyFilters(result, filters)
  }

  /**
   * Get all items at a specific commit.
   *
   * Two queries: one resolves the page's item ids — ancestry walk, filtering,
   * count and pagination all in SQL — and the second hydrates just those rows.
   * `getItemsAtCommitInMemory` is the same computation done in Node, and stays
   * the path for filters SQL does not express; see `canResolveAtCommitInSql`.
   */
  static async getItemsAtCommit(
    commitId: string,
    filters?: ItemFilters,
  ): Promise<PaginatedItemsResult> {
    if (!this.canResolveAtCommitInSql(filters)) {
      return this.getItemsAtCommitInMemory(commitId, filters)
    }

    const page = await this.resolveItemIdsAtCommit(commitId, filters)
    if (page.ids.length === 0) {
      return { items: [], total: page.total }
    }

    const rows = await db
      .select()
      .from(items)
      .where(inArray(items.id, page.ids))

    // `inArray` makes no promise about the order it returns, and the page's
    // order was decided by the query above.
    const byId = new Map(rows.map((row) => [row.id, row]))
    return {
      items: page.ids
        .map((id) => byId.get(id))
        .filter((row): row is (typeof rows)[number] => row !== undefined),
      total: page.total,
    }
  }

  /**
   * Whether `filters` is expressible in the SQL resolution path.
   *
   * Everything the API sends is: `itemType`, `state`, `search`,
   * `globalSearch`, `limit`, `offset`. A `sortField` or a `columnFilters`
   * entry routes to the in-memory path instead, and deliberately.
   *
   * `applyFilters` orders strings with `localeCompare`; the database orders
   * them by whichever collation the cluster was initialised with. Those
   * disagree on case and punctuation. No caller passes `sortField` here today,
   * so pushing the sort down would quietly change results for a caller that
   * does not exist yet — when one arrives, the ordering is worth choosing
   * deliberately rather than inheriting.
   *
   * `columnFilters` is the same story with an extra wrinkle: in-memory, an
   * entry naming anything outside `getItemFieldValue`'s base fields compares
   * against `undefined` and so rejects every row. That is a quirk rather than
   * an intent, and reproducing it in SQL would entrench it.
   */
  /**
   * The SQL-expressible half of `applyFilters`, as predicates on `alias`.
   *
   * Always at least `TRUE`, so callers can join the list unconditionally.
   * `canResolveAtCommitInSql` has already refused anything not covered here.
   */
  private static itemFilterConditions(
    filters: ItemFilters | undefined,
    alias: string,
  ) {
    const col = (name: string) => sql.raw(`${alias}.${name}`)
    const conditions = [sql`TRUE`]

    if (filters?.itemType) {
      conditions.push(sql`${col('item_type')} = ${filters.itemType}`)
    }
    if (filters?.state) {
      conditions.push(sql`${col('state')} = ${filters.state}`)
    }
    // `search` and `globalSearch` are the same predicate under two names, and
    // `applyFilters` applies each independently when both are set.
    for (const term of [filters?.search, filters?.globalSearch]) {
      if (!term) continue
      const pattern = likeContains(term)
      conditions.push(
        sql`(${col('item_number')} ILIKE ${pattern} ESCAPE '\\' OR ${col('name')} ILIKE ${pattern} ESCAPE '\\')`,
      )
    }

    return conditions
  }

  private static canResolveAtCommitInSql(filters?: ItemFilters): boolean {
    if (filters?.sortField) return false
    if (
      filters?.columnFilters &&
      Object.keys(filters.columnFilters).length > 0
    ) {
      return false
    }
    return true
  }

  /**
   * The item ids visible at `commitId`, filtered, counted and paginated by the
   * database.
   *
   * A chain of CTEs:
   *
   * - `commit_ancestors` walks parents and merge parents back from the target.
   * - `ancestors` collapses that to one row per commit at its shallowest
   *   depth — the same de-duplication `getCommitAncestors` does.
   * - `resolved` takes, per master, the version whose commit sits earliest in
   *   ancestry order. The `DISTINCT ON` ORDER BY is exactly what
   *   `compareByAncestryPosition` implements in Node, tiebreakers included:
   *   `created_at DESC, id` for two versions of one master in one commit.
   * - the outer query drops masters whose winning version is a delete, applies
   *   the filters, and takes the page.
   *
   * `COUNT(*) OVER ()` carries the pre-pagination total on every row, so the
   * count costs no second pass.
   *
   * Ordering is `item_number, id` rather than nothing. The in-memory path
   * returns these rows unordered — it iterates a map built from an unordered
   * `SELECT` — so its `limit`/`offset` slice a set the database is free to
   * return in a different order each call. Paginating that is broken however
   * it is implemented; this path orders deterministically instead.
   */
  private static async resolveItemIdsAtCommit(
    commitId: string,
    filters?: ItemFilters,
  ): Promise<{ ids: Array<string>; total: number }> {
    const conditions = [
      sql`r.change_type <> 'deleted'`,
      ...this.itemFilterConditions(filters, 'r'),
    ]

    const limit = filters?.limit
    const offset = filters?.offset ?? 0

    const rows = await db.execute(sql`
      WITH RECURSIVE commit_ancestors AS (
        SELECT c.id, c.parent_id, c.merge_parent_id, c.created_at, 0 AS depth
        FROM commits c WHERE c.id = ${commitId}
        UNION ALL
        SELECT c.id, c.parent_id, c.merge_parent_id, c.created_at, ca.depth + 1
        FROM commits c
        INNER JOIN commit_ancestors ca
          ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
      ),
      ancestors AS (
        SELECT DISTINCT ON (id) id, depth, created_at
        FROM commit_ancestors
        ORDER BY id, depth
      ),
      resolved AS (
        SELECT DISTINCT ON (i.master_id)
               i.id,
               i.item_number,
               i.name,
               i.state,
               i.item_type,
               iv.change_type
        FROM item_versions iv
        INNER JOIN items i ON i.id = iv.item_id
        INNER JOIN ancestors a ON a.id = iv.commit_id
        INNER JOIN commits target ON target.id = ${commitId}
        WHERE i.design_id = target.design_id
          AND i.is_deleted IS NOT TRUE
        ORDER BY i.master_id,
                 a.depth ASC, a.created_at DESC, a.id ASC,
                 i.created_at DESC, i.id ASC
      )
      , filtered AS (
        SELECT r.id, r.item_number
        FROM resolved r
        WHERE ${sql.join(conditions, sql` AND `)}
      )
      SELECT counted.total, page.id
      FROM (SELECT COUNT(*) AS total FROM filtered) counted
      LEFT JOIN (
        SELECT id, item_number FROM filtered
        ORDER BY item_number ASC, id ASC
        ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
        OFFSET ${offset}
      ) page ON TRUE
      ORDER BY page.item_number ASC NULLS LAST, page.id ASC
    `)

    // The count is joined rather than taken as `COUNT(*) OVER ()` on the page.
    // An offset past the end returns no page rows, and a window function then
    // has nothing to report the total on — which is how the in-memory path
    // reports it, since it counts before slicing. This shape always yields at
    // least the count row, whose `id` is null.
    const page = rows as unknown as Array<{
      id: string | null
      total: number | string
    }>
    const first = page[0]
    if (!first) return { ids: [], total: 0 }

    return {
      ids: page.map((row) => row.id).filter((id): id is string => id !== null),
      total: Number(first.total),
    }
  }

  /**
   * Get all items at a specific commit, resolved in Node.
   *
   * The fallback for filters `resolveItemIdsAtCommit` does not express, and
   * the reference the equivalence tests compare the SQL path against.
   */
  private static async getItemsAtCommitInMemory(
    commitId: string,
    filters?: ItemFilters,
  ): Promise<PaginatedItemsResult> {
    const commit = await db
      .select()
      .from(commits)
      .where(eq(commits.id, commitId))
      .limit(1)

    const commitRow = commit[0]
    if (!commitRow) {
      return { items: [], total: 0 }
    }

    const designId = commitRow.designId

    // Get all commit ancestors in one query using recursive CTE
    const commitAncestors = await this.getCommitAncestors(commitId)
    const commitIdSet = new Set(commitAncestors.map((c) => c.id))

    // Get all items for this design in one query
    const designItems = await db
      .select()
      .from(items)
      .where(and(eq(items.designId, designId), notDeleted()))

    // Get all itemVersions for this design in one query
    const allItemVersions = await db
      .select({
        itemVersion: itemVersions,
        item: items,
      })
      .from(itemVersions)
      .innerJoin(items, eq(itemVersions.itemId, items.id))
      .where(and(eq(items.designId, designId), notDeleted()))

    // Group items and versions by masterId
    const itemsByMaster = new Map<string, Array<typeof items.$inferSelect>>()
    for (const item of designItems) {
      const list = itemsByMaster.get(item.masterId) || []
      list.push(item)
      itemsByMaster.set(item.masterId, list)
    }

    // Group itemVersions by masterId, resolved in ancestry order
    const versionsByMaster = new Map<
      string,
      Array<{
        itemVersion: typeof itemVersions.$inferSelect
        item: typeof items.$inferSelect
      }>
    >()
    for (const iv of allItemVersions) {
      const list = versionsByMaster.get(iv.item.masterId) || []
      list.push(iv)
      versionsByMaster.set(iv.item.masterId, list)
    }
    // Sort each list by commit-ancestry position — the order
    // walkCommitHistory resolves in, so the grid and the detail page cannot
    // disagree. This used to sort by item.createdAt, which served the wrong
    // row after an in-place promotion: the promotion keeps the working
    // copy's old createdAt while its commit moves ahead, so another ECO's
    // earlier release out-sorted it here while walkCommitHistory correctly
    // served the promotion.
    const commitPositionMap = new Map<string, number>()
    commitAncestors.forEach((c, i) => commitPositionMap.set(c.id, i))
    for (const [, list] of versionsByMaster) {
      list.sort((a, b) =>
        this.compareByAncestryPosition(a, b, commitPositionMap),
      )
    }

    // For each masterId, find the version that was current at this commit (in-memory)
    const result: Array<typeof items.$inferSelect> = []
    for (const [masterId] of itemsByMaster) {
      const versions = versionsByMaster.get(masterId) || []

      // Find the most recent version that was committed in our history
      let foundItem: typeof items.$inferSelect | null = null
      for (const iv of versions) {
        if (commitIdSet.has(iv.itemVersion.commitId)) {
          // Check if this was a delete
          if (iv.itemVersion.changeType === 'deleted') {
            foundItem = null
            break
          }
          foundItem = iv.item
          break
        }
      }

      if (foundItem) {
        result.push(foundItem)
      }
    }

    return this.applyFilters(result, filters)
  }

  /**
   * Get all items at a specific tag
   */
  static async getItemsAtTag(
    tagId: string,
    filters?: ItemFilters,
  ): Promise<PaginatedItemsResult> {
    const tag = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1)

    const tagRow = tag[0]
    if (!tagRow) {
      return { items: [], total: 0 }
    }

    return this.getItemsAtCommit(tagRow.commitId, filters)
  }

  /**
   * Walk commit history backwards to find the item version at a specific commit
   */
  private static async walkCommitHistory(
    itemMasterId: string,
    commitId: string,
    designId: string,
  ): Promise<typeof items.$inferSelect | null> {
    // Get all items with this masterId
    const itemVersionsList = await db
      .select()
      .from(items)
      .where(
        and(
          eq(items.masterId, itemMasterId),
          eq(items.designId, designId),
          notDeleted(),
        ),
      )

    if (itemVersionsList.length === 0) {
      return null
    }

    // Get all commits up to and including the target commit
    const commitHistory = await this.getCommitAncestors(commitId)
    const commitIdSet = new Set(commitHistory.map((c) => c.id))

    // Build position map from commit ancestry (most recent = 0)
    const commitPositionMap = new Map<string, number>()
    commitHistory.forEach((c, i) => commitPositionMap.set(c.id, i))

    // Find which item version was introduced in a commit in our history
    const itemVersionsWithCommits = await db
      .select({
        itemVersion: itemVersions,
        item: items,
      })
      .from(itemVersions)
      .innerJoin(items, eq(itemVersions.itemId, items.id))
      .where(
        and(
          eq(items.masterId, itemMasterId),
          eq(items.designId, designId),
          notDeleted(),
        ),
      )

    // Sort by commit ancestry position (most recent first) instead of
    // timestamp — shared with getItemsAtCommit so the two resolvers agree.
    itemVersionsWithCommits.sort((a, b) =>
      this.compareByAncestryPosition(a, b, commitPositionMap),
    )

    // Find the most recent version that was committed in our history
    for (const iv of itemVersionsWithCommits) {
      if (commitIdSet.has(iv.itemVersion.commitId)) {
        // Check if this was a delete
        if (iv.itemVersion.changeType === 'deleted') {
          return null
        }
        return iv.item
      }
    }

    // No version found in commit history - item didn't exist at this point
    return null
  }

  /**
   * Ancestry-position order for item versions: the version whose commit sits
   * nearest the target commit resolves first. Versions from commits outside
   * the walked history sort last (Infinity) and are skipped by the callers'
   * membership check either way.
   *
   * The tiebreakers matter: itemVersions' unique(commitId, itemId) does not
   * prevent two *different* item rows of one master landing in one commit,
   * and that pathological shape used to resolve in heap order. Newest
   * item.createdAt wins there, then id — a deliberate (and now documented)
   * choice rather than an accident of storage.
   */
  private static compareByAncestryPosition(
    a: { itemVersion: { commitId: string }; item: PositionSortableItem },
    b: { itemVersion: { commitId: string }; item: PositionSortableItem },
    commitPositionMap: Map<string, number>,
  ): number {
    const posA = commitPositionMap.get(a.itemVersion.commitId) ?? Infinity
    const posB = commitPositionMap.get(b.itemVersion.commitId) ?? Infinity
    if (posA !== posB) return posA - posB
    const createdA = new Date(a.item.createdAt).getTime()
    const createdB = new Date(b.item.createdAt).getTime()
    if (createdA !== createdB) return createdB - createdA
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0
  }

  /**
   * Every ancestor commit of `commitId` (including itself), as
   * `{ id, depth }` in deterministic order: depth ascending — position 0 is
   * always the target commit — then created_at descending, then id. Two
   * walks of the same graph enumerate identically, so every consumer that
   * builds a position map from this order gets a stable one; the previous
   * version had no ORDER BY at all, which left resolution order to the heap.
   *
   * UNION ALL rather than UNION: commit DAGs here are acyclic and shallow
   * (per-design linear history plus ECO merge edges), so a diamond ancestor
   * is revisited at most once per extra path, and the DISTINCT ON collapse
   * keeps exactly one row per commit at its shallowest depth. Raw
   * `db.execute` rows are snake_case — the old signature cast them to full
   * camelCase commit rows, a lie both callers survived only by reading `.id`;
   * only the columns actually consumed are selected now.
   */
  private static async getCommitAncestors(
    commitId: string,
  ): Promise<Array<{ id: string; depth: number }>> {
    const result = await db.execute(sql`
      WITH RECURSIVE commit_ancestors AS (
        SELECT c.id, c.parent_id, c.merge_parent_id, c.created_at, 0 AS depth
        FROM commits c WHERE c.id = ${commitId}
        UNION ALL
        SELECT c.id, c.parent_id, c.merge_parent_id, c.created_at, ca.depth + 1
        FROM commits c
        INNER JOIN commit_ancestors ca
          ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
      )
      SELECT id, depth FROM (
        SELECT DISTINCT ON (id) id, depth, created_at
        FROM commit_ancestors
        ORDER BY id, depth
      ) deduped
      ORDER BY depth ASC, created_at DESC, id
    `)

    return result as unknown as Array<{ id: string; depth: number }>
  }

  /**
   * Apply filters to an item list
   */
  private static applyFilters(
    itemList: Array<typeof items.$inferSelect>,
    filters?: ItemFilters,
  ): PaginatedItemsResult {
    let result = itemList

    if (!filters?.includeDeleted) {
      result = result.filter((i) => !i.isDeleted)
    }

    if (filters?.itemType) {
      result = result.filter((i) => i.itemType === filters.itemType)
    }

    if (filters?.state) {
      result = result.filter((i) => i.state === filters.state)
    }

    if (filters?.search) {
      const searchLower = filters.search.toLowerCase()
      result = result.filter(
        (i) =>
          i.itemNumber.toLowerCase().includes(searchLower) ||
          (i.name && i.name.toLowerCase().includes(searchLower)),
      )
    }

    // Global search (same as search but named differently for DataGrid compatibility)
    if (filters?.globalSearch) {
      const searchLower = filters.globalSearch.toLowerCase()
      result = result.filter(
        (i) =>
          i.itemNumber.toLowerCase().includes(searchLower) ||
          (i.name && i.name.toLowerCase().includes(searchLower)),
      )
    }

    // Column filters
    if (filters?.columnFilters) {
      for (const [columnId, filterValue] of Object.entries(
        filters.columnFilters,
      )) {
        result = result.filter((item) => {
          const itemValue = this.getItemFieldValue(item, columnId)

          // Multi-select filter (array of values)
          if (Array.isArray(filterValue)) {
            if (filterValue.length === 0) return true
            return filterValue.includes(String(itemValue ?? ''))
          }

          // Range filter (for numeric fields)
          if (
            typeof filterValue === 'object' &&
            ('min' in filterValue || 'max' in filterValue)
          ) {
            const numValue = Number(itemValue)
            if (isNaN(numValue)) return false
            if (filterValue.min !== undefined && numValue < filterValue.min)
              return false
            if (filterValue.max !== undefined && numValue > filterValue.max)
              return false
            return true
          }

          // Text filter (string contains)
          if (typeof filterValue === 'string') {
            if (!filterValue) return true
            const strValue = String(itemValue ?? '').toLowerCase()
            return strValue.includes(filterValue.toLowerCase())
          }

          return true
        })
      }
    }

    // Sorting
    if (filters?.sortField) {
      const sortDir = filters.sortDirection === 'desc' ? -1 : 1
      result = [...result].sort((a, b) => {
        const aVal = this.getItemFieldValue(a, filters.sortField!)
        const bVal = this.getItemFieldValue(b, filters.sortField!)

        // Handle null/undefined
        if (aVal == null && bVal == null) return 0
        if (aVal == null) return sortDir
        if (bVal == null) return -sortDir

        // Compare values
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          return aVal.localeCompare(bVal) * sortDir
        }
        if (aVal < bVal) return -1 * sortDir
        if (aVal > bVal) return 1 * sortDir
        return 0
      })
    }

    // Capture total count before pagination
    const total = result.length

    // Apply pagination only when explicitly requested
    // Internal callers (cloneHandler, MbomService) pass no filters and expect ALL items.
    // API routes always provide explicit limit via paginationSchema (default 50).
    const offset = filters?.offset || 0
    const paginatedItems = filters?.limit
      ? result.slice(offset, offset + filters.limit)
      : result.slice(offset)

    return { items: paginatedItems, total }
  }

  /**
   * Get a field value from an item for filtering/sorting
   * Supports base item fields (works with items table data)
   */
  private static getItemFieldValue(
    item: typeof items.$inferSelect,
    fieldName: string,
  ): unknown {
    // Base item fields
    const baseFields: Record<string, keyof typeof items.$inferSelect> = {
      itemNumber: 'itemNumber',
      name: 'name',
      state: 'state',
      revision: 'revision',
      itemType: 'itemType',
      createdAt: 'createdAt',
      modifiedAt: 'modifiedAt',
    }

    const baseField = baseFields[fieldName]
    if (baseField) {
      return item[baseField]
    }

    // For type-specific fields, they would need to be joined/enriched
    // The applyFilters method works on base items, so type-specific filtering
    // is limited. For full type-specific filtering at branch context,
    // consider using the enriched items approach.
    return undefined
  }

  /**
   * Get the context description for display
   */
  static async getContextDescription(context: VersionContext): Promise<string> {
    switch (context.type) {
      case 'released':
        return 'Released (main)'

      case 'branch': {
        const branch = await BranchService.getById(context.branchId)
        return branch ? `Branch: ${branch.name}` : 'Unknown branch'
      }

      case 'commit': {
        const commit = await db
          .select({ message: commits.message })
          .from(commits)
          .where(eq(commits.id, context.commitId))
          .limit(1)
        const commitRow = commit[0]
        return commitRow
          ? `Commit: ${commitRow.message.slice(0, 50)}`
          : 'Unknown commit'
      }

      case 'tag': {
        const tag = await db
          .select({ name: tags.name })
          .from(tags)
          .where(eq(tags.id, context.tagId))
          .limit(1)
        const tagRow = tag[0]
        return tagRow ? `Tag: ${tagRow.name}` : 'Unknown tag'
      }

      default:
        return 'Unknown context'
    }
  }

  /**
   * Get all branches and tags where an item exists for context filtering
   */
  static async getAvailableContextsForItem(
    itemMasterId: string,
    designId: string,
  ): Promise<{
    branches: Array<{
      id: string
      name: string
      branchType: string
      isLocked: boolean
      isArchived: boolean
      exists: boolean
    }>
    tags: Array<{
      id: string
      name: string
      tagType: string | null
      exists: boolean
    }>
  }> {
    // Fetch all non-archived branches for the design
    // (Released ECOs are archived after merge, so they won't appear in selectors)
    const allBranches = await db
      .select()
      .from(branches)
      .where(
        and(eq(branches.designId, designId), eq(branches.isArchived, false)),
      )

    // Fetch all tags for the design
    const allTags = await db
      .select()
      .from(tags)
      .where(eq(tags.designId, designId))

    // Check item existence on each branch
    const branchResults = await Promise.all(
      allBranches.map(async (branch) => {
        let exists = false

        if (branch.branchType === 'main') {
          // For main branch, ONLY check commit history - no fallbacks
          // This ensures new items on ECO branches don't appear on main until released
          if (branch.headCommitId) {
            const item = await this.getItemAtCommit(
              itemMasterId,
              branch.headCommitId,
            )
            exists = item !== null
          }
          // If no HEAD commit on main, item cannot exist on main yet
        } else if (branch.branchType === 'eco') {
          // For ECO branches, only show if item is explicitly tracked on this branch
          // (i.e., it's an affected item in the ECO). Don't fall back to base commit
          // because that would show the ECO for ALL items in the design.
          const branchItem = await db
            .select()
            .from(branchItems)
            .where(
              and(
                eq(branchItems.branchId, branch.id),
                eq(branchItems.itemMasterId, itemMasterId),
              ),
            )
            .limit(1)

          const branchItemRow = branchItem[0]
          exists =
            branchItemRow !== undefined &&
            branchItemRow.changeType !== 'deleted'
        } else {
          // For workspace/release branches, check branchItems or base commit
          // First check if item was added/modified on this branch
          const branchItem = await db
            .select()
            .from(branchItems)
            .where(
              and(
                eq(branchItems.branchId, branch.id),
                eq(branchItems.itemMasterId, itemMasterId),
              ),
            )
            .limit(1)

          const branchItemRow = branchItem[0]
          if (branchItemRow) {
            // Item is tracked on this branch
            exists = branchItemRow.changeType !== 'deleted'
          } else if (branch.baseCommitId) {
            // Item not modified on branch - check if it exists in base commit ancestry
            const itemAtBase = await this.walkCommitHistory(
              itemMasterId,
              branch.baseCommitId,
              designId,
            )
            exists = itemAtBase !== null
          }
        }

        return {
          id: branch.id,
          name: branch.name,
          branchType: branch.branchType,
          isLocked: branch.isLocked ?? false,
          isArchived: branch.isArchived ?? false,
          exists,
        }
      }),
    )

    // Check item existence at each tag
    const tagResults = await Promise.all(
      allTags.map(async (tag) => {
        const item = await this.getItemAtTag(itemMasterId, tag.id)
        return {
          id: tag.id,
          name: tag.name,
          tagType: tag.tagType,
          exists: item !== null,
        }
      }),
    )

    return {
      branches: branchResults,
      tags: tagResults,
    }
  }

  /**
   * Resolve a relationship target to the correct version at a context.
   *
   * Relationships store specific version IDs (items.id), but when viewing
   * at a branch or commit context, we need to resolve to the version of
   * that item that exists at that context.
   *
   * @param targetVersionId - The specific item version ID from the relationship
   * @param context - The version context to resolve at
   * @param ecoDesignContexts - Optional map of designId -> context for ECO-affected designs
   * @returns The resolved item at context, or null if not found
   */
  static async resolveRelationshipTarget(
    targetVersionId: string,
    context: VersionContext,
    ecoDesignContexts?: Map<string, VersionContext>,
  ): Promise<typeof items.$inferSelect | null> {
    // Get the target item to find its masterId and designId
    const targetItem = await db
      .select()
      .from(items)
      .where(eq(items.id, targetVersionId))
      .limit(1)

    if (!targetItem[0]) return null

    const { masterId, designId } = targetItem[0]

    // No design = library item or legacy item, return as-is
    if (!designId) return targetItem[0]

    // Determine the appropriate context for this item's design
    let targetContext: VersionContext

    // Check if this design has a specific context in the ECO
    if (ecoDesignContexts?.has(designId)) {
      targetContext = ecoDesignContexts.get(designId)!
    } else if (context.type === 'released' && 'designId' in context) {
      // If primary context is released and target is in same design, use same context
      if (context.designId === designId) {
        targetContext = context
      } else {
        // Different design not in ECO - use its released version
        targetContext = { type: 'released', designId }
      }
    } else if (context.type === 'branch') {
      // For branch context, external designs use their released version
      targetContext = { type: 'released', designId }
    } else if (context.type === 'commit') {
      // For commit context, external designs use their released version
      targetContext = { type: 'released', designId }
    } else {
      // Fallback to released
      targetContext = { type: 'released', designId }
    }

    return this.getItemAtContext(masterId, designId, targetContext)
  }

  /**
   * Resolve multiple relationship targets at a context (batch operation).
   * Truly batched - fetches all items per context in single queries.
   */
  static async resolveRelationshipTargets(
    targetVersionIds: Array<string>,
    context: VersionContext,
    ecoDesignContexts?: Map<string, VersionContext>,
  ): Promise<Map<string, typeof items.$inferSelect>> {
    const result = new Map<string, typeof items.$inferSelect>()

    if (targetVersionIds.length === 0) return result

    // Fetch all target items to get their masterIds and designIds
    const targetItems = await db
      .select()
      .from(items)
      .where(inArray(items.id, targetVersionIds))

    // Group by designId for efficient resolution
    const itemsByDesign = new Map<
      string | null,
      Array<{
        originalId: string
        masterId: string
        item: typeof items.$inferSelect
      }>
    >()

    for (const item of targetItems) {
      const designId = item.designId
      if (!itemsByDesign.has(designId)) {
        itemsByDesign.set(designId, [])
      }
      itemsByDesign.get(designId)!.push({
        originalId: item.id,
        masterId: item.masterId,
        item,
      })
    }

    // Resolve items for each design using batch operations
    for (const [designId, designItems] of itemsByDesign) {
      if (!designId) {
        // No design = library items, return as-is
        for (const { originalId, item } of designItems) {
          result.set(originalId, item)
        }
        continue
      }

      // Determine context for this design
      let targetContext: VersionContext
      if (ecoDesignContexts?.has(designId)) {
        targetContext = ecoDesignContexts.get(designId)!
      } else if (
        context.type === 'released' &&
        'designId' in context &&
        context.designId === designId
      ) {
        targetContext = context
      } else {
        targetContext = { type: 'released', designId }
      }

      // Batch resolve: get ALL items at context, then filter to what we need
      const { items: contextItems } = await this.getItemsAtContext(
        designId,
        targetContext,
      )

      // Build masterId -> item lookup from context items
      const contextItemsByMasterId = new Map<
        string,
        typeof items.$inferSelect
      >()
      for (const item of contextItems) {
        contextItemsByMasterId.set(item.masterId, item)
      }

      // Map back to original IDs
      for (const { originalId, masterId } of designItems) {
        const resolved = contextItemsByMasterId.get(masterId)
        if (resolved) {
          result.set(originalId, resolved)
        }
      }
    }

    return result
  }
}
