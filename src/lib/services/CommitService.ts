// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { withSerializableRetry } from '../db/retry'
import {
  branches,
  commits,
  itemFieldChanges,
  itemVersions,
  items,
  tags,
  users,
} from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import { notDeleted } from '../db/filters'
import { BranchService } from './BranchService'
import type { TransactionClient } from '../db'

/**
 * Represents a field-level change for tracking in commits
 */
export interface FieldChange {
  fieldName: string
  fieldPath?: string
  oldValue: unknown
  newValue: unknown
  fieldCategory: 'core' | 'type' | 'attribute' | 'relationship'
}

// Zod schemas for validation
const fieldChangeSchema = z.object({
  fieldName: z.string(),
  fieldPath: z.string().optional(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  fieldCategory: z.enum(['core', 'type', 'attribute', 'relationship']),
})

export const commitCreateSchema = z.object({
  branchId: z.string().uuid(),
  message: z.string().min(1, 'Commit message is required'),
  itemChanges: z.array(
    z.object({
      itemId: z.string().uuid(),
      changeType: z.enum(['added', 'modified', 'deleted']),
      previousItemId: z.string().uuid().optional(),
      fieldChanges: z.array(fieldChangeSchema).optional(),
    }),
  ),
  // Optional: Link to ECO for release commits
  changeOrderItemId: z.string().uuid().optional(),
  // Optional: Revision info for release commits
  revisionsAssigned: z.record(z.string(), z.string()).optional(),
})

export const mergeCommitSchema = z.object({
  targetBranchId: z.string().uuid(),
  sourceBranchId: z.string().uuid(),
  message: z.string().min(1),
  changeOrderItemId: z.string().uuid().optional(),
  revisionsAssigned: z.record(z.string(), z.string()).optional(),
  // Optional item changes - if not provided, changes are collected from source branch
  itemChanges: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        changeType: z.enum(['added', 'modified', 'deleted']),
        previousItemId: z.string().uuid().optional(),
      }),
    )
    .optional(),
})

export type CreateCommitInput = z.infer<typeof commitCreateSchema>
export type CreateMergeCommitInput = z.infer<typeof mergeCommitSchema>

export interface CommitFilters {
  since?: Date
  until?: Date
  limit?: number
  offset?: number
}

export interface CommitDiff {
  commit: typeof commits.$inferSelect
  items: Array<{
    itemId: string
    itemNumber: string
    name: string | null
    changeType: 'added' | 'modified' | 'deleted'
    previousItemId: string | null
  }>
}

export interface ItemHistoryEntry {
  commit: typeof commits.$inferSelect
  item: typeof items.$inferSelect
  changeType: 'added' | 'modified' | 'deleted'
  previousItem: typeof items.$inferSelect | null
  fieldChanges: Array<FieldChange>
}

/**
 * Service for managing Commits
 */
export class CommitService {
  /**
   * Get commit by ID
   */
  static async getById(id: string) {
    const result = await db
      .select()
      .from(commits)
      .where(eq(commits.id, id))
      .limit(1)

    return result.at(0) || null
  }

  /**
   * Get commits for a branch
   */
  static async getByBranch(
    branchId: string,
    options?: { limit?: number; offset?: number },
  ) {
    const limit = options?.limit || 50
    const offset = options?.offset || 0

    return db
      .select()
      .from(commits)
      .where(eq(commits.branchId, branchId))
      .orderBy(desc(commits.createdAt))
      .limit(limit)
      .offset(offset)
  }

  /**
   * Count total commits for a branch
   */
  static async countByBranch(branchId: string): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(commits)
      .where(eq(commits.branchId, branchId))
    return result?.count ?? 0
  }

  /**
   * Create a new commit on a branch
   */
  static async create(
    data: CreateCommitInput,
    userId: string,
    outerTx?: TransactionClient,
  ) {
    const validated = commitCreateSchema.parse(data)

    // Get the branch
    const branch = await BranchService.getById(validated.branchId)
    if (!branch) {
      throw new NotFoundError('Branch', validated.branchId, {
        operation: 'createCommit',
      })
    }

    // Check if branch is locked
    if (branch.isLocked) {
      throw new ValidationError('Cannot commit to a locked branch')
    }

    // Calculate stats
    const stats = validated.itemChanges.reduce(
      (acc, change) => {
        if (change.changeType === 'added') acc.added++
        else if (change.changeType === 'modified') acc.changed++
        else acc.deleted++
        return acc
      },
      { added: 0, changed: 0, deleted: 0 },
    )

    // If an outer transaction is provided, run inside it (savepoint).
    // Otherwise, create a new transaction.
    const run = outerTx ?? db
    return run.transaction(async (tx) => {
      // 1. Create the commit
      const [commit] = await tx
        .insert(commits)
        .values({
          designId: branch.designId,
          branchId: branch.id,
          parentId: branch.headCommitId,
          message: validated.message,
          itemsAdded: stats.added,
          itemsChanged: stats.changed,
          itemsDeleted: stats.deleted,
          changeOrderItemId: validated.changeOrderItemId,
          revisionsAssigned: validated.revisionsAssigned,
          createdBy: userId,
        })
        .returning()

      // 2. Create itemVersion entries for each change
      if (validated.itemChanges.length > 0) {
        const insertedVersions = await tx
          .insert(itemVersions)
          .values(
            validated.itemChanges.map((change) => ({
              commitId: commit.id,
              itemId: change.itemId,
              changeType: change.changeType,
              previousItemId: change.previousItemId,
            })),
          )
          .returning()

        // 3. Store field-level changes for each itemVersion
        const fieldChangesToInsert: Array<{
          itemVersionId: string
          fieldName: string
          fieldPath: string | null
          oldValue: unknown
          newValue: unknown
          fieldCategory: string
        }> = []

        for (let i = 0; i < validated.itemChanges.length; i++) {
          const change = validated.itemChanges[i]
          const itemVersion = insertedVersions[i]

          if (change.fieldChanges && change.fieldChanges.length > 0) {
            for (const fc of change.fieldChanges) {
              fieldChangesToInsert.push({
                itemVersionId: itemVersion.id,
                fieldName: fc.fieldName,
                fieldPath: fc.fieldPath || null,
                oldValue: fc.oldValue,
                newValue: fc.newValue,
                fieldCategory: fc.fieldCategory,
              })
            }
          }
        }

        if (fieldChangesToInsert.length > 0) {
          await tx.insert(itemFieldChanges).values(fieldChangesToInsert)
        }
      }

      // 4. Update branch HEAD
      await tx
        .update(branches)
        .set({ headCommitId: commit.id })
        .where(eq(branches.id, branch.id))

      return commit
    })
  }

  /**
   * Create a merge commit (for ECO release)
   */
  static async createMergeCommit(data: CreateMergeCommitInput, userId: string) {
    // Input is already typed via CreateMergeCommitInput (inferred from mergeCommitSchema)
    // TypeScript validates the structure at compile time
    const validated = data

    // Get both branches
    const [targetBranch, sourceBranch] = await Promise.all([
      BranchService.getById(validated.targetBranchId),
      BranchService.getById(validated.sourceBranchId),
    ])

    if (!targetBranch) {
      throw new NotFoundError('Branch', validated.targetBranchId, {
        operation: 'createMergeCommit',
      })
    }
    if (!sourceBranch) {
      throw new NotFoundError('Branch', validated.sourceBranchId, {
        operation: 'createMergeCommit',
      })
    }

    // Source must be same design
    if (targetBranch.designId !== sourceBranch.designId) {
      throw new ValidationError('Cannot merge branches from different designs')
    }

    // Target is typically main
    if (targetBranch.branchType !== 'main') {
      throw new ValidationError('Merge target must be the main branch')
    }

    return withSerializableRetry(() =>
      db.transaction(
        async (tx) => {
          // 1. Get item changes - use provided changes or collect from source branch
          const itemChangesToRecord =
            validated.itemChanges && validated.itemChanges.length > 0
              ? validated.itemChanges
              : await this.getBranchChanges(sourceBranch.id)

          // Calculate stats
          const stats = itemChangesToRecord.reduce(
            (acc, change) => {
              if (change.changeType === 'added') acc.added++
              else if (change.changeType === 'modified') acc.changed++
              else acc.deleted++
              return acc
            },
            { added: 0, changed: 0, deleted: 0 },
          )

          // 2. Create merge commit with two parents
          const [mergeCommit] = await tx
            .insert(commits)
            .values({
              designId: targetBranch.designId,
              branchId: targetBranch.id,
              parentId: targetBranch.headCommitId,
              mergeParentId: sourceBranch.headCommitId,
              message: validated.message,
              changeOrderItemId: validated.changeOrderItemId,
              revisionsAssigned: validated.revisionsAssigned,
              itemsAdded: stats.added,
              itemsChanged: stats.changed,
              itemsDeleted: stats.deleted,
              createdBy: userId,
            })
            .returning()

          // 3. Create itemVersion entries for merged changes
          if (itemChangesToRecord.length > 0) {
            await tx.insert(itemVersions).values(
              itemChangesToRecord.map((change) => ({
                commitId: mergeCommit.id,
                itemId: change.itemId,
                changeType: change.changeType,
                previousItemId: change.previousItemId,
              })),
            )
          }

          // 4. Update target branch HEAD
          await tx
            .update(branches)
            .set({ headCommitId: mergeCommit.id })
            .where(eq(branches.id, targetBranch.id))

          return mergeCommit
        },
        { isolationLevel: 'serializable' },
      ),
    )
  }

  /**
   * Get commit history for a branch
   */
  static async getHistory(branchId: string, options?: CommitFilters) {
    const conditions = [eq(commits.branchId, branchId)]

    if (options?.since) {
      conditions.push(gte(commits.createdAt, options.since))
    }
    if (options?.until) {
      conditions.push(lte(commits.createdAt, options.until))
    }

    const result = await db
      .select()
      .from(commits)
      .where(and(...conditions))
      .orderBy(desc(commits.createdAt))

    const offset = options?.offset || 0
    const limit = options?.limit || 100
    return result.slice(offset, offset + limit)
  }

  /**
   * Get all commits that affected a specific item
   * @param itemMasterId - The master ID of the item
   * @param designId - The design ID
   * @param options - Optional filtering options
   * @param options.untilCommitId - Limit history to commits up to this timestamp
   * @param options.branchId - Only include commits on this branch
   */
  static async getItemCommits(
    itemMasterId: string,
    designId: string,
    options?: {
      untilCommitId?: string
      branchId?: string
    },
  ): Promise<Array<ItemHistoryEntry>> {
    const { untilCommitId, branchId } = options || {}

    // Get all items with this masterId in this design
    const itemVersionsList = await db
      .select({
        itemId: items.id,
        masterId: items.masterId,
      })
      .from(items)
      .where(
        and(
          eq(items.masterId, itemMasterId),
          eq(items.designId, designId),
          notDeleted(),
        ),
      )

    if (itemVersionsList.length === 0) {
      return []
    }

    const itemIds = itemVersionsList.map((i) => i.itemId)

    // If we have a cutoff commit, get its ancestor set for filtering
    let ancestorCommitIds: Set<string> | null = null
    if (untilCommitId) {
      const result = await db.execute(sql`
        WITH RECURSIVE commit_ancestors AS (
          SELECT c.id, c.parent_id, c.merge_parent_id FROM commits c WHERE c.id = ${untilCommitId}
          UNION
          SELECT c.id, c.parent_id, c.merge_parent_id FROM commits c
          INNER JOIN commit_ancestors ca ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
        )
        SELECT id FROM commit_ancestors
      `)
      ancestorCommitIds = new Set(
        (result as unknown as Array<{ id: string }>).map((r) => r.id),
      )
    }

    // Build the query conditions
    const baseConditions = [inArray(itemVersions.itemId, itemIds)]

    // Determine branch filtering strategy
    let branchFilterCondition = null
    if (branchId) {
      // Get the branch to determine its type
      const branch = await db
        .select({
          id: branches.id,
          branchType: branches.branchType,
          baseCommitId: branches.baseCommitId,
          designId: branches.designId,
        })
        .from(branches)
        .where(eq(branches.id, branchId))
        .limit(1)

      if (branch.length > 0) {
        const branchInfo = branch[0]

        if (branchInfo.branchType === 'main') {
          // Main branch: only show commits on main (exclude unmerged ECO commits)
          branchFilterCondition = eq(commits.branchId, branchId)
        } else {
          // ECO branch: show commits on this ECO branch + main branch commits up to fork point
          // First, get the main branch ID
          const mainBranch = await BranchService.getMainBranch(
            branchInfo.designId,
          )

          if (mainBranch && branchInfo.baseCommitId) {
            // Get the timestamp of the base commit (fork point)
            const baseCommit = await db
              .select({ createdAt: commits.createdAt })
              .from(commits)
              .where(eq(commits.id, branchInfo.baseCommitId))
              .limit(1)

            if (baseCommit.length > 0) {
              const forkTimestamp = baseCommit[0].createdAt
              // ECO branch commits OR main branch commits at or before the fork
              branchFilterCondition = or(
                eq(commits.branchId, branchId),
                and(
                  eq(commits.branchId, mainBranch.id),
                  lte(commits.createdAt, forkTimestamp),
                ),
              )
            } else {
              // Fallback: just show ECO branch commits
              branchFilterCondition = eq(commits.branchId, branchId)
            }
          } else {
            // No main branch or no base commit, just show ECO branch commits
            branchFilterCondition = eq(commits.branchId, branchId)
          }
        }
      }
    }

    // Get all itemVersions for these items
    const queryConditions = branchFilterCondition
      ? [...baseConditions, branchFilterCondition]
      : baseConditions

    const versions = await db
      .select({
        itemVersion: itemVersions,
        commit: commits,
        item: items,
      })
      .from(itemVersions)
      .innerJoin(commits, eq(itemVersions.commitId, commits.id))
      .innerJoin(items, eq(itemVersions.itemId, items.id))
      .where(and(...queryConditions))
      .orderBy(desc(commits.createdAt))

    // Filter by commit ancestry if specified
    const filteredVersions = ancestorCommitIds
      ? versions.filter((v) => ancestorCommitIds.has(v.commit.id))
      : versions

    // Get all item version IDs to fetch field changes in bulk
    const versionIds = filteredVersions.map((v) => v.itemVersion.id)
    const allFieldChanges =
      versionIds.length > 0
        ? await db
            .select()
            .from(itemFieldChanges)
            .where(inArray(itemFieldChanges.itemVersionId, versionIds))
        : []

    // Group field changes by version ID
    const fieldChangesByVersion = new Map<string, Array<FieldChange>>()
    for (const fc of allFieldChanges) {
      const existing = fieldChangesByVersion.get(fc.itemVersionId) ?? []
      existing.push({
        fieldName: fc.fieldName,
        fieldPath: fc.fieldPath ?? undefined,
        oldValue: fc.oldValue,
        newValue: fc.newValue,
        fieldCategory: fc.fieldCategory as FieldChange['fieldCategory'],
      })
      fieldChangesByVersion.set(fc.itemVersionId, existing)
    }

    // Get previous items for each version
    const result: Array<ItemHistoryEntry> = []
    for (const v of filteredVersions) {
      let previousItem = null
      if (v.itemVersion.previousItemId) {
        const prev = await db
          .select()
          .from(items)
          .where(eq(items.id, v.itemVersion.previousItemId))
          .limit(1)
        previousItem = prev.at(0) || null
      }

      result.push({
        commit: v.commit,
        item: v.item,
        changeType: v.itemVersion.changeType as
          | 'added'
          | 'modified'
          | 'deleted',
        previousItem,
        fieldChanges: fieldChangesByVersion.get(v.itemVersion.id) || [],
      })
    }

    return result
  }

  /**
   * Get the diff for a specific commit
   */
  static async getDiff(commitId: string): Promise<CommitDiff | null> {
    const commit = await this.getById(commitId)
    if (!commit) {
      return null
    }

    // Get all itemVersions for this commit
    const versions = await db
      .select({
        itemVersion: itemVersions,
        item: items,
      })
      .from(itemVersions)
      .innerJoin(items, eq(itemVersions.itemId, items.id))
      .where(eq(itemVersions.commitId, commitId))

    return {
      commit,
      items: versions.map((v) => ({
        itemId: v.item.id,
        itemNumber: v.item.itemNumber,
        name: v.item.name,
        changeType: v.itemVersion.changeType as
          | 'added'
          | 'modified'
          | 'deleted',
        previousItemId: v.itemVersion.previousItemId,
      })),
    }
  }

  /**
   * Compare two tags and return the commits between them
   */
  static async compareTags(
    tagId1: string,
    tagId2: string,
  ): Promise<Array<CommitDiff>> {
    // Get both tags
    const [tag1Result, tag2Result] = await Promise.all([
      db.select().from(tags).where(eq(tags.id, tagId1)).limit(1),
      db.select().from(tags).where(eq(tags.id, tagId2)).limit(1),
    ])

    const tag1 = tag1Result.at(0)
    const tag2 = tag2Result.at(0)

    if (!tag1 || !tag2) {
      throw new NotFoundError('Tag', tag1 ? tagId2 : tagId1, {
        operation: 'compareTags',
      })
    }

    // Get commits between the two tag commits using commit graph ancestry
    const commit1 = await this.getById(tag1.commitId)
    const commit2 = await this.getById(tag2.commitId)

    if (!commit1 || !commit2) {
      return []
    }

    // Get ancestors of both commits
    const [ancestors1Result, ancestors2Result] = await Promise.all([
      db.execute(sql`
        WITH RECURSIVE commit_ancestors AS (
          SELECT c.id, c.parent_id, c.merge_parent_id FROM commits c WHERE c.id = ${commit1.id}
          UNION
          SELECT c.id, c.parent_id, c.merge_parent_id FROM commits c
          INNER JOIN commit_ancestors ca ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
        )
        SELECT id FROM commit_ancestors
      `),
      db.execute(sql`
        WITH RECURSIVE commit_ancestors AS (
          SELECT c.id, c.parent_id, c.merge_parent_id FROM commits c WHERE c.id = ${commit2.id}
          UNION
          SELECT c.id, c.parent_id, c.merge_parent_id FROM commits c
          INNER JOIN commit_ancestors ca ON c.id = ca.parent_id OR c.id = ca.merge_parent_id
        )
        SELECT id FROM commit_ancestors
      `),
    ])
    const ancestor1Ids = new Set(
      (ancestors1Result as unknown as Array<{ id: string }>).map((r) => r.id),
    )
    const ancestor2Ids = new Set(
      (ancestors2Result as unknown as Array<{ id: string }>).map((r) => r.id),
    )

    // Determine which is older by checking if one is an ancestor of the other
    const commit1IsAncestorOf2 = ancestor2Ids.has(commit1.id)
    const commit2IsAncestorOf1 = ancestor1Ids.has(commit2.id)

    if (!commit1IsAncestorOf2 && !commit2IsAncestorOf1) {
      throw new ValidationError(
        'Tags are on divergent branches and cannot be compared',
      )
    }

    const [olderSet, newerSet] = commit1IsAncestorOf2
      ? [ancestor1Ids, ancestor2Ids]
      : [ancestor2Ids, ancestor1Ids]

    // Commits in newer's ancestry that are NOT in older's ancestry
    const commitIdsBetween = [...newerSet].filter((id) => !olderSet.has(id))

    const commitsBetween =
      commitIdsBetween.length > 0
        ? await db
            .select()
            .from(commits)
            .where(
              and(
                eq(commits.designId, tag1.designId),
                inArray(commits.id, commitIdsBetween),
              ),
            )
            .orderBy(commits.createdAt)
        : []

    // Get diffs for each commit
    const diffs: Array<CommitDiff> = []
    for (const c of commitsBetween) {
      const diff = await this.getDiff(c.id)
      if (diff) {
        diffs.push(diff)
      }
    }

    return diffs
  }

  /**
   * Get all changes on a branch (relative to its base)
   * Used for merge operations
   */
  static async getBranchChanges(branchId: string): Promise<
    Array<{
      itemId: string
      changeType: 'added' | 'modified' | 'deleted'
      previousItemId: string | null
    }>
  > {
    const branch = await BranchService.getById(branchId)
    if (!branch) {
      return []
    }

    // Get all commits on this branch since base
    const branchCommits = await db
      .select()
      .from(commits)
      .where(eq(commits.branchId, branchId))
      .orderBy(commits.createdAt)

    // Collect all item changes
    const changeMap = new Map<
      string,
      {
        itemId: string
        changeType: 'added' | 'modified' | 'deleted'
        previousItemId: string | null
      }
    >()

    for (const commit of branchCommits) {
      const versions = await db
        .select({
          itemId: itemVersions.itemId,
          changeType: itemVersions.changeType,
          previousItemId: itemVersions.previousItemId,
          masterId: items.masterId,
        })
        .from(itemVersions)
        .innerJoin(items, eq(itemVersions.itemId, items.id))
        .where(eq(itemVersions.commitId, commit.id))

      for (const v of versions) {
        // Use masterId as key to track latest change per item
        const existing = changeMap.get(v.masterId)
        if (!existing || existing.changeType !== 'added') {
          // Keep the original previousItemId for non-added items
          changeMap.set(v.masterId, {
            itemId: v.itemId,
            changeType: v.changeType as 'added' | 'modified' | 'deleted',
            previousItemId: existing?.previousItemId || v.previousItemId,
          })
        }
      }
    }

    return Array.from(changeMap.values())
  }

  /**
   * Get commit with author info
   */
  static async getWithAuthor(commitId: string) {
    const result = await db
      .select({
        commit: commits,
        author: users,
      })
      .from(commits)
      .innerJoin(users, eq(commits.createdBy, users.id))
      .where(eq(commits.id, commitId))
      .limit(1)

    return result.at(0) || null
  }
}
