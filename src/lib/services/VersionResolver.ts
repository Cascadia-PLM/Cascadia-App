// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

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
import { notDeleted } from '../db/filters'
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
    let result = await db
      .select()
      .from(items)
      .where(
        and(
          eq(items.masterId, itemMasterId),
          eq(items.designId, designId),
          eq(items.isCurrent, true),
          notDeleted(),
        ),
      )
      .limit(1)

    if (!result.at(0)) {
      // Fallback: get the Released version if no current version exists
      result = await db
        .select()
        .from(items)
        .where(
          and(
            eq(items.masterId, itemMasterId),
            eq(items.designId, designId),
            eq(items.state, 'Released'),
            notDeleted(),
          ),
        )
        .orderBy(desc(items.modifiedAt))
        .limit(1)
    }

    // Final fallback: just get any item with this masterId
    if (!result.at(0)) {
      result = await db
        .select()
        .from(items)
        .where(and(eq(items.masterId, itemMasterId), notDeleted()))
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

    const currentItemId = branchItem.at(0)?.currentItemId
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

    if (!commit.at(0)) {
      return null
    }

    // Walk backwards through commit history to find the item version
    return this.walkCommitHistory(itemMasterId, commitId, commit[0].designId)
  }

  /**
   * Get an item at a specific tag
   */
  static async getItemAtTag(
    itemMasterId: string,
    tagId: string,
  ): Promise<typeof items.$inferSelect | null> {
    const tag = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1)

    if (!tag.at(0)) {
      return null
    }

    return this.getItemAtCommit(itemMasterId, tag[0].commitId)
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

    // If main branch has commits, try commit-based resolution
    if (mainBranch.headCommitId) {
      const commitResult = await this.getItemsAtCommit(
        mainBranch.headCommitId,
        filters,
      )
      if (commitResult.items.length > 0) {
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

    // Final fallback: isCurrent items for the design
    const result = await db
      .select()
      .from(items)
      .where(
        and(
          eq(items.designId, designId),
          eq(items.isCurrent, true),
          notDeleted(),
        ),
      )
    return this.applyFilters(result, filters)
  }

  /**
   * Get all items on a branch (including unchanged items from main)
   */
  static async getBranchItems(
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

    // Merge: use branch version if available, otherwise released version
    const result: Array<typeof items.$inferSelect> = []
    const processedMasterIds = new Set<string>()

    for (const item of releasedResult.items) {
      const branchItem = branchItemMap.get(item.masterId)
      if (branchItem?.currentItemId && branchItem.changeType !== 'deleted') {
        // Use branch version
        const branchVersion = await db
          .select()
          .from(items)
          .where(and(eq(items.id, branchItem.currentItemId), notDeleted()))
          .limit(1)
        if (branchVersion.at(0)) {
          result.push(branchVersion[0])
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
        const addedItem = await db
          .select()
          .from(items)
          .where(and(eq(items.id, bi.currentItemId), notDeleted()))
          .limit(1)
        if (addedItem.at(0)) {
          result.push(addedItem[0])
        }
      }
    }

    // Apply filters (including pagination) to merged result
    return this.applyFilters(result, filters)
  }

  /**
   * Get all items at a specific commit
   * Optimized to batch all queries instead of per-masterId lookups
   */
  static async getItemsAtCommit(
    commitId: string,
    filters?: ItemFilters,
  ): Promise<PaginatedItemsResult> {
    const commit = await db
      .select()
      .from(commits)
      .where(eq(commits.id, commitId))
      .limit(1)

    if (!commit.at(0)) {
      return { items: [], total: 0 }
    }

    const designId = commit[0].designId

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

    // Group itemVersions by masterId, sorted by createdAt desc
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
    // Sort each list by item.createdAt descending
    for (const [, list] of versionsByMaster) {
      list.sort(
        (a, b) =>
          new Date(b.item.createdAt).getTime() -
          new Date(a.item.createdAt).getTime(),
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

    if (!tag.at(0)) {
      return { items: [], total: 0 }
    }

    return this.getItemsAtCommit(tag[0].commitId, filters)
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

    // Sort by commit ancestry position (most recent first) instead of timestamp
    itemVersionsWithCommits.sort((a, b) => {
      const posA = commitPositionMap.get(a.itemVersion.commitId) ?? Infinity
      const posB = commitPositionMap.get(b.itemVersion.commitId) ?? Infinity
      return posA - posB
    })

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
   * Get all ancestor commits of a given commit (including itself)
   * Uses a recursive CTE for efficient single-query traversal
   */
  private static async getCommitAncestors(
    commitId: string,
  ): Promise<Array<typeof commits.$inferSelect>> {
    // Use recursive CTE to get all ancestors in one query
    const result = await db.execute(sql`
      WITH RECURSIVE commit_ancestors AS (
        SELECT c.* FROM commits c WHERE c.id = ${commitId}
        UNION
        SELECT c.* FROM commits c
        INNER JOIN commit_ancestors ca ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
      )
      SELECT * FROM commit_ancestors
    `)

    return result as unknown as Array<typeof commits.$inferSelect>
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
        if (filterValue === undefined || filterValue === null) continue

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

    if (fieldName in baseFields) {
      return item[baseFields[fieldName]]
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
        return commit.at(0)
          ? `Commit: ${commit[0].message.slice(0, 50)}`
          : 'Unknown commit'
      }

      case 'tag': {
        const tag = await db
          .select({ name: tags.name })
          .from(tags)
          .where(eq(tags.id, context.tagId))
          .limit(1)
        return tag.at(0) ? `Tag: ${tag[0].name}` : 'Unknown tag'
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

          exists =
            branchItem.at(0) !== undefined &&
            branchItem[0].changeType !== 'deleted'
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

          if (branchItem.at(0)) {
            // Item is tracked on this branch
            exists = branchItem[0].changeType !== 'deleted'
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
