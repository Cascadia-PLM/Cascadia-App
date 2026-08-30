// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { desc, eq, inArray } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { NotFoundError } from '../errors'
import { db } from '../db'
import { changeOrderDesigns, items } from '../db/schema/items'
import { commits, itemVersions, tags } from '../db/schema/versioning'
import { designs } from '../db/schema/designs'
import { users } from '../db/schema/users'
import { consolidateCommits } from '../versioning/graph-utils'
import { BranchService } from './BranchService'
import { CommitService } from './CommitService'
import { DesignService } from './DesignService'
import type {
  CommitGraphData,
  CommitGraphEdge,
  CommitGraphNode,
} from '../versioning/graph-types'

export interface AffectedItemCommit {
  commitId: string
  itemId: string
  itemMasterId: string
  itemNumber: string
  itemName: string | null
  revision: string
  changeType: 'added' | 'modified' | 'deleted'
  message: string
  author: { id: string; name: string }
  date: string
  fieldChangesCount?: number
}

export interface BranchTimeline {
  branchId: string
  branchName: string
  designId: string
  designName: string
  baseCommitId: string | null
  commits: Array<{
    id: string
    message: string
    author: { id: string; name: string }
    date: string
    changeStats: { added: number; modified: number; deleted: number }
    affectedItemChanges: Array<AffectedItemCommit>
  }>
}

export interface EcoBranchHistory {
  ecoNumber: string
  ecoName: string
  mainBranch: {
    commits: Array<{
      id: string
      message: string
      author: { id: string; name: string }
      date: string
      changeStats: { added: number; modified: number; deleted: number }
    }>
  }
  ecoBranches: Array<BranchTimeline>
  splitPoints: Array<{
    designId: string
    designName: string
    baseCommitId: string | null
    baseCommitMessage: string | null
    baseCommitDate: string | null
  }>
}

export interface EcoBranchGraph extends CommitGraphData {
  ecoNumber: string
  ecoName: string
  affectedDesigns: Array<{
    designId: string
    designName: string
    branchId: string
    branchName: string
  }>
}

/**
 * Reads a change order's branch activity — the per-design commit timeline and
 * the commit graph the history view draws.
 *
 * Both shapes are assembled from commits, item versions, tags and authors; none
 * of it is HTTP-shaped, and it sat in two route handlers where it could not be
 * reused or tested directly.
 */
export class EcoBranchHistoryService {
  /** The designs this change order touches, with their branch and name. */
  private static async getAffectedDesigns(changeOrderId: string): Promise<
    Array<{
      designId: string
      branchId: string | null
      designName: string
    }>
  > {
    return db
      .select({
        designId: changeOrderDesigns.designId,
        branchId: changeOrderDesigns.branchId,
        designName: designs.name,
      })
      .from(changeOrderDesigns)
      .innerJoin(designs, eq(designs.id, changeOrderDesigns.designId))
      .where(eq(changeOrderDesigns.changeOrderId, changeOrderId))
  }

  /** Display names for a set of user ids, defaulting to 'Unknown'. */
  private static async getAuthorNames(
    userIds: Array<string>,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter(Boolean))]
    if (ids.length === 0) return new Map()

    const authors = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids))

    return new Map(authors.map((a) => [a.id, a.name || 'Unknown']))
  }

  /**
   * Per-design commit timeline for a change order, each commit carrying the
   * item changes it recorded.
   */
  static async getTimeline(changeOrderId: string): Promise<EcoBranchHistory> {
    const eco = await ItemService.findById(changeOrderId)
    if (!eco) {
      throw new NotFoundError('Change order', changeOrderId)
    }

    const affectedDesigns = await this.getAffectedDesigns(changeOrderId)

    const result: EcoBranchHistory = {
      ecoNumber: eco.itemNumber,
      ecoName: eco.name || '',
      mainBranch: { commits: [] },
      ecoBranches: [],
      splitPoints: [],
    }

    if (affectedDesigns.length === 0) {
      return result
    }

    for (const design of affectedDesigns) {
      if (!design.branchId) continue

      const branch = await BranchService.getById(design.branchId)
      if (!branch) continue

      const branchCommits = await db
        .select({
          id: commits.id,
          message: commits.message,
          createdAt: commits.createdAt,
          createdById: commits.createdBy,
          itemsAdded: commits.itemsAdded,
          itemsChanged: commits.itemsChanged,
          itemsDeleted: commits.itemsDeleted,
        })
        .from(commits)
        .where(eq(commits.branchId, design.branchId))
        .orderBy(desc(commits.createdAt))

      const authorMap = await this.getAuthorNames(
        branchCommits.map((c) => c.createdById).filter(Boolean),
      )

      const timelineCommits = []
      for (const commit of branchCommits) {
        const itemChanges = await db
          .select({
            itemId: itemVersions.itemId,
            changeType: itemVersions.changeType,
            previousItemId: itemVersions.previousItemId,
          })
          .from(itemVersions)
          .where(eq(itemVersions.commitId, commit.id))

        const itemIds = itemChanges.map((ic) => ic.itemId).filter(Boolean)
        const itemDetails =
          itemIds.length > 0
            ? await db
                .select({
                  id: items.id,
                  masterId: items.masterId,
                  itemNumber: items.itemNumber,
                  name: items.name,
                  revision: items.revision,
                })
                .from(items)
                .where(inArray(items.id, itemIds))
            : []

        const itemDetailsMap = new Map(itemDetails.map((i) => [i.id, i]))

        const author = {
          id: commit.createdById || '',
          name: authorMap.get(commit.createdById || '') || 'System',
        }

        const affectedItemChanges: Array<AffectedItemCommit> = itemChanges
          .map((ic) => {
            const itemDetail = itemDetailsMap.get(ic.itemId)
            if (!itemDetail) return null

            return {
              commitId: commit.id,
              itemId: ic.itemId,
              itemMasterId: itemDetail.masterId || '',
              itemNumber: itemDetail.itemNumber || '',
              itemName: itemDetail.name,
              revision: itemDetail.revision || '',
              changeType: ic.changeType as 'added' | 'modified' | 'deleted',
              message: commit.message || 'No message',
              author,
              date: commit.createdAt.toISOString(),
            }
          })
          .filter((ic): ic is AffectedItemCommit => ic !== null)

        timelineCommits.push({
          id: commit.id,
          message: commit.message || 'No message',
          author,
          date: commit.createdAt.toISOString(),
          changeStats: {
            added: commit.itemsAdded || 0,
            modified: commit.itemsChanged || 0,
            deleted: commit.itemsDeleted || 0,
          },
          affectedItemChanges,
        })
      }

      result.ecoBranches.push({
        branchId: design.branchId,
        branchName: branch.name,
        designId: design.designId,
        designName: design.designName || '',
        baseCommitId: branch.baseCommitId,
        commits: timelineCommits,
      })

      if (branch.baseCommitId) {
        const baseCommit = await CommitService.getById(branch.baseCommitId)
        if (baseCommit) {
          result.splitPoints.push({
            designId: design.designId,
            designName: design.designName || '',
            baseCommitId: branch.baseCommitId,
            baseCommitMessage: baseCommit.message || null,
            baseCommitDate: baseCommit.createdAt.toISOString(),
          })
        }
      }
    }

    return result
  }

  /**
   * Build commit graph data for ECO branch visualization
   * Shows the main branch context around the fork point and all ECO branch commits
   */
  private static async buildGraph(
    designId: string,
    ecoBranchId: string,
    limit: number,
  ): Promise<CommitGraphData> {
    // 1. Get the ECO branch and main branch
    const ecoBranch = await BranchService.getById(ecoBranchId)
    if (!ecoBranch) {
      return { nodes: [], edges: [], mainBranchId: '' }
    }

    const allBranches = await DesignService.getBranches(designId, false)
    const mainBranch = allBranches.find((b) => b.branchType === 'main')

    if (!mainBranch) {
      return { nodes: [], edges: [], mainBranchId: '' }
    }

    const forkPoint = ecoBranch.baseCommitId || undefined

    // 2. Get ECO branch commits
    const ecoBranchCommits = await db
      .select()
      .from(commits)
      .where(eq(commits.branchId, ecoBranchId))
      .orderBy(desc(commits.createdAt))
      .limit(limit)

    // 3. Get main branch commits (context around fork point)
    const mainCommits = await db
      .select()
      .from(commits)
      .where(eq(commits.branchId, mainBranch.id))
      .orderBy(desc(commits.createdAt))
      .limit(limit)

    // 4. Collect all commits
    const allCommits = [...mainCommits, ...ecoBranchCommits]
    const uniqueCommits = Array.from(
      new Map(allCommits.map((c) => [c.id, c])).values(),
    )
    const allCommitIds = uniqueCommits.map((c) => c.id)

    if (allCommitIds.length === 0) {
      return {
        nodes: [],
        edges: [],
        mainBranchId: mainBranch.id,
        selectedBranchId: ecoBranchId,
        selectedBranchName: ecoBranch.name,
        forkPoint,
      }
    }

    // 5. Get tags for these commits
    const commitTags = await db
      .select()
      .from(tags)
      .where(inArray(tags.commitId, allCommitIds))

    const tagsByCommit = new Map<
      string,
      Array<{ id: string; name: string; tagType: string }>
    >()
    for (const tag of commitTags) {
      const existing = tagsByCommit.get(tag.commitId) || []
      existing.push({
        id: tag.id,
        name: tag.name,
        tagType: tag.tagType || 'baseline',
      })
      tagsByCommit.set(tag.commitId, existing)
    }

    // 6. Get authors for all commits
    const authorMap = await this.getAuthorNames(
      uniqueCommits.map((c) => c.createdBy).filter(Boolean),
    )

    // 7. Get ECO item numbers for commits linked to change orders
    const changeOrderIds = [
      ...new Set(
        uniqueCommits
          .map((c) => c.changeOrderItemId)
          .filter((id): id is string => id !== null),
      ),
    ]
    let ecoNumberMap = new Map<string, string>()

    if (changeOrderIds.length > 0) {
      const ecoItems = await db
        .select({ id: items.id, itemNumber: items.itemNumber })
        .from(items)
        .where(inArray(items.id, changeOrderIds))

      ecoNumberMap = new Map(ecoItems.map((e) => [e.id, e.itemNumber]))
    }

    // 8. Build nodes and edges
    const nodes: Array<CommitGraphNode> = []
    const edges: Array<CommitGraphEdge> = []
    const includedCommitIds = new Set(allCommitIds)

    for (const commit of uniqueCommits) {
      const isMainBranch = commit.branchId === mainBranch.id

      const branchName = isMainBranch ? mainBranch.name : ecoBranch.name
      const branchType: 'main' | 'eco' | 'workspace' | 'release' = isMainBranch
        ? 'main'
        : 'eco'

      nodes.push({
        id: commit.id,
        type: 'commitNode',
        position: { x: 0, y: 0 },
        data: {
          commitId: commit.id,
          message: commit.message || 'No message',
          author: {
            id: commit.createdBy || '',
            name: authorMap.get(commit.createdBy || '') || 'Unknown',
          },
          date: commit.createdAt.toISOString(),
          branchId: commit.branchId,
          branchName,
          branchType,
          isMergeCommit: commit.mergeParentId !== null,
          changeStats: {
            added: commit.itemsAdded || 0,
            modified: commit.itemsChanged || 0,
            deleted: commit.itemsDeleted || 0,
          },
          tags: tagsByCommit.get(commit.id) || [],
          changeOrderItemId: commit.changeOrderItemId || undefined,
          ecoNumber: commit.changeOrderItemId
            ? ecoNumberMap.get(commit.changeOrderItemId)
            : undefined,
          revisionsAssigned: commit.revisionsAssigned as
            Record<string, string> | undefined,
        },
      })

      // Parent edge
      if (commit.parentId && includedCommitIds.has(commit.parentId)) {
        edges.push({
          id: `${commit.parentId}-${commit.id}`,
          source: commit.parentId,
          target: commit.id,
          type: 'default',
          data: { edgeType: 'parent' },
        })
      }

      // Merge parent edge
      if (commit.mergeParentId && includedCommitIds.has(commit.mergeParentId)) {
        edges.push({
          id: `${commit.mergeParentId}-${commit.id}-merge`,
          source: commit.mergeParentId,
          target: commit.id,
          type: 'default',
          data: { edgeType: 'merge' },
          animated: true,
          style: { strokeDasharray: '5,5' },
        })
      }
    }

    // 9. Add edge from fork point to first ECO branch commit
    if (forkPoint && ecoBranchCommits.length > 0) {
      const sortedEcoCommits = [...ecoBranchCommits].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      // Non-empty per the `ecoBranchCommits.length > 0` guard above
      const oldestEcoCommit = sortedEcoCommits[0]!

      if (includedCommitIds.has(forkPoint)) {
        const edgeId = `${forkPoint}-${oldestEcoCommit.id}`
        if (!edges.find((e) => e.id === edgeId)) {
          edges.push({
            id: edgeId,
            source: forkPoint,
            target: oldestEcoCommit.id,
            type: 'default',
            data: { edgeType: 'parent' },
          })
        }
      }
    }

    // 10. Consolidate sequential similar commits
    const consolidated = consolidateCommits(nodes, edges)

    return {
      nodes: consolidated.nodes,
      edges: consolidated.edges,
      forkPoint,
      mainBranchId: mainBranch.id,
      selectedBranchId: ecoBranchId,
      selectedBranchName: ecoBranch.name,
    }
  }

  /**
   * Commit graph for one of the change order's designs.
   *
   * A graph shows one design at a time — `designId` picks it, defaulting to the
   * first affected design — but every affected design is listed so the caller
   * can offer the switch.
   */
  static async getGraph(
    changeOrderId: string,
    options: { designId?: string | null; limit?: number } = {},
  ): Promise<EcoBranchGraph> {
    const { designId: selectedDesignId, limit = 50 } = options

    const eco = await ItemService.findById(changeOrderId)
    if (!eco) {
      throw new NotFoundError('Change order', changeOrderId)
    }

    const affectedDesigns = await this.getAffectedDesigns(changeOrderId)

    const empty = {
      ecoNumber: eco.itemNumber,
      ecoName: eco.name || '',
      nodes: [],
      edges: [],
      mainBranchId: '',
    }

    if (affectedDesigns.length === 0) {
      return { ...empty, affectedDesigns: [] }
    }

    // Non-empty per the guard above
    const targetDesign = selectedDesignId
      ? (affectedDesigns.find((d) => d.designId === selectedDesignId) ??
        affectedDesigns[0]!)
      : affectedDesigns[0]!

    const affectedDesignsWithBranches = await Promise.all(
      affectedDesigns.map(async (d) => {
        let branchName = ''
        if (d.branchId) {
          const branch = await BranchService.getById(d.branchId)
          branchName = branch?.name || ''
        }
        return {
          designId: d.designId,
          designName: d.designName || '',
          branchId: d.branchId || '',
          branchName,
        }
      }),
    )

    if (!targetDesign.branchId) {
      return { ...empty, affectedDesigns: affectedDesignsWithBranches }
    }

    const graphData = await this.buildGraph(
      targetDesign.designId,
      targetDesign.branchId,
      limit,
    )

    return {
      ...graphData,
      ecoNumber: eco.itemNumber,
      ecoName: eco.name || '',
      affectedDesigns: affectedDesignsWithBranches,
    }
  }
}
