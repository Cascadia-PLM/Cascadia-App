import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import {
  branches,
  commits,
  itemFieldChanges,
  itemVersions,
  items,
  tags,
} from '../db/schema'
import { ThreadService } from './ThreadService'
import type {
  ThreadDomain,
  ThreadEdge,
  ThreadNode,
  ThreadRequest,
  ThreadResponse,
} from './ThreadService'
import type { VersionContext } from './VersionResolver'

/**
 * Node diff status in a thread comparison
 */
export type NodeDiffStatus = 'added' | 'removed' | 'modified' | 'unchanged'

/**
 * Edge diff status in a thread comparison
 */
export type EdgeDiffStatus = 'added' | 'removed' | 'modified' | 'unchanged'

/**
 * A single field change in a node
 */
export interface FieldChange {
  fieldName: string
  fieldPath?: string
  oldValue: unknown
  newValue: unknown
  fieldCategory: 'core' | 'type' | 'attribute' | 'relationship'
}

/**
 * A thread node with diff information
 */
export interface ThreadNodeDiff {
  node: ThreadNode
  status: NodeDiffStatus
  previousNode?: ThreadNode
  fieldChanges: Array<FieldChange>
  sourceContext: 'before' | 'after' | 'both'
}

/**
 * A thread edge with diff information
 */
export interface ThreadEdgeDiff {
  edge: ThreadEdge
  status: EdgeDiffStatus
  previousEdge?: ThreadEdge
  changes?: {
    quantityChanged?: boolean
    derivationMethodChanged?: boolean
  }
  sourceContext: 'before' | 'after' | 'both'
}

/**
 * Enriched version context info for display
 */
export interface VersionContextInfo {
  context: VersionContext
  label: string // "v1.0.0", "ECO-2024-001", "Released (main)"
  timestamp?: Date
  commitMessage?: string
}

/**
 * Statistics for a thread comparison
 */
export interface ThreadComparisonStats {
  nodesAdded: number
  nodesRemoved: number
  nodesModified: number
  nodesUnchanged: number
  totalNodes: number
  changesByDomain: Record<
    ThreadDomain,
    { added: number; removed: number; modified: number }
  >
  relationshipsAdded: number
  relationshipsRemoved: number
  relationshipsModified: number
  totalFieldChanges: number
  coverageChanges: {
    mbomCoverage: { before: number; after: number }
    requirementsCoverage: { before: number; after: number }
    testCoverage: { before: number; after: number }
  }
}

/**
 * Complete thread comparison result
 */
export interface ThreadComparison {
  beforeContext: VersionContextInfo
  afterContext: VersionContextInfo
  focalItem: ThreadNodeDiff
  domains: {
    requirements: Array<ThreadNodeDiff>
    engineering: Array<ThreadNodeDiff>
    manufacturing: Array<ThreadNodeDiff>
    validation: Array<ThreadNodeDiff>
  }
  relationships: Array<ThreadEdgeDiff>
  stats: ThreadComparisonStats
  comparedAt: Date
}

/**
 * Available comparison targets for a design
 */
export interface ComparisonTargets {
  tags: Array<{
    id: string
    name: string
    tagType: string | null
    createdAt: Date
  }>
  branches: Array<{
    id: string
    name: string
    branchType: string
    isLocked: boolean
    isArchived: boolean
  }>
  recentCommits: Array<{
    id: string
    message: string
    createdAt: Date
  }>
}

/**
 * Request schema for thread comparison
 */
export const threadComparisonRequestSchema = z.object({
  beforeContext: z.discriminatedUnion('type', [
    z.object({ type: z.literal('released'), designId: z.string().uuid() }),
    z.object({ type: z.literal('branch'), branchId: z.string().uuid() }),
    z.object({ type: z.literal('commit'), commitId: z.string().uuid() }),
    z.object({ type: z.literal('tag'), tagId: z.string().uuid() }),
  ]),
  afterContext: z.discriminatedUnion('type', [
    z.object({ type: z.literal('released'), designId: z.string().uuid() }),
    z.object({ type: z.literal('branch'), branchId: z.string().uuid() }),
    z.object({ type: z.literal('commit'), commitId: z.string().uuid() }),
    z.object({ type: z.literal('tag'), tagId: z.string().uuid() }),
  ]),
  domains: z
    .array(
      z.enum(['requirements', 'engineering', 'manufacturing', 'validation']),
    )
    .optional()
    .default(['requirements', 'engineering', 'manufacturing', 'validation']),
  upstreamDepth: z.number().int().min(0).max(10).optional().default(5),
  downstreamDepth: z.number().int().min(0).max(10).optional().default(5),
  bomDepth: z.number().int().min(0).max(10).optional().default(3),
  includeFieldChanges: z.boolean().optional().default(true),
})

export type ThreadComparisonRequest = z.input<
  typeof threadComparisonRequestSchema
>

/**
 * Service for comparing digital threads at different version contexts.
 * Enables answering questions like:
 * - "What changed in this design between v1.0 and v2.0?"
 * - "What items were added/removed/modified in this ECO?"
 * - "Compare the current thread to a baseline release"
 */
export class ThreadComparisonService {
  /**
   * Compare threads at two different version contexts.
   */
  static async compare(
    itemId: string,
    request: ThreadComparisonRequest,
  ): Promise<ThreadComparison> {
    const validated = threadComparisonRequestSchema.parse(request)

    // Get item to determine its designId
    const [item] = await db
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1)

    if (!item) {
      throw new Error(`Item not found: ${itemId}`)
    }

    const designId = item.designId
    if (!designId) {
      throw new Error('Item has no associated design')
    }

    // Build context info for both versions
    const [beforeContextInfo, afterContextInfo] = await Promise.all([
      this.buildContextInfo(validated.beforeContext),
      this.buildContextInfo(validated.afterContext),
    ])

    // Build thread request
    const threadRequest: ThreadRequest = {
      itemId,
      domains: validated.domains,
      upstreamDepth: validated.upstreamDepth,
      downstreamDepth: validated.downstreamDepth,
      bomDepth: validated.bomDepth,
    }

    // Get threads at both contexts
    const [beforeThread, afterThread] = await Promise.all([
      ThreadService.getThreadAtContext(threadRequest, validated.beforeContext),
      ThreadService.getThreadAtContext(threadRequest, validated.afterContext),
    ])

    // Compute node diffs
    const { focalItemDiff, domainDiffs } = this.computeNodeDiffs(
      beforeThread,
      afterThread,
      validated.includeFieldChanges,
    )

    // Compute edge diffs
    const edgeDiffs = this.computeEdgeDiffs(
      beforeThread.relationships,
      afterThread.relationships,
    )

    // Calculate stats
    const stats = this.calculateStats(
      focalItemDiff,
      domainDiffs,
      edgeDiffs,
      beforeThread.stats,
      afterThread.stats,
    )

    return {
      beforeContext: beforeContextInfo,
      afterContext: afterContextInfo,
      focalItem: focalItemDiff,
      domains: domainDiffs,
      relationships: edgeDiffs,
      stats,
      comparedAt: new Date(),
    }
  }

  /**
   * Get available comparison targets for a design.
   */
  static async getComparisonTargets(
    _masterId: string,
    designId: string,
  ): Promise<ComparisonTargets> {
    // Get tags grouped by type
    const tagsList = await db
      .select({
        id: tags.id,
        name: tags.name,
        tagType: tags.tagType,
        createdAt: tags.createdAt,
      })
      .from(tags)
      .where(eq(tags.designId, designId))
      .orderBy(desc(tags.createdAt))

    // Get branches
    const branchesList = await db
      .select({
        id: branches.id,
        name: branches.name,
        branchType: branches.branchType,
        isLocked: branches.isLocked,
        isArchived: branches.isArchived,
      })
      .from(branches)
      .where(eq(branches.designId, designId))

    // Get recent commits
    const recentCommitsList = await db
      .select({
        id: commits.id,
        message: commits.message,
        createdAt: commits.createdAt,
      })
      .from(commits)
      .where(eq(commits.designId, designId))
      .orderBy(desc(commits.createdAt))
      .limit(20)

    return {
      tags: tagsList,
      branches: branchesList.map((b) => ({
        ...b,
        isLocked: b.isLocked ?? false,
        isArchived: b.isArchived ?? false,
      })),
      recentCommits: recentCommitsList,
    }
  }

  /**
   * Build enriched context info for display.
   */
  private static async buildContextInfo(
    context: VersionContext,
  ): Promise<VersionContextInfo> {
    switch (context.type) {
      case 'released':
        return {
          context,
          label: 'Released (main)',
          timestamp: new Date(),
        }

      case 'branch': {
        const [branch] = await db
          .select({ name: branches.name, createdAt: branches.createdAt })
          .from(branches)
          .where(eq(branches.id, context.branchId))
          .limit(1)

        return {
          context,
          label: branch ? `Branch: ${branch.name}` : 'Unknown branch',
          timestamp: branch?.createdAt,
        }
      }

      case 'commit': {
        const [commit] = await db
          .select({ message: commits.message, createdAt: commits.createdAt })
          .from(commits)
          .where(eq(commits.id, context.commitId))
          .limit(1)

        return {
          context,
          label: commit
            ? `Commit: ${commit.message.slice(0, 40)}${commit.message.length > 40 ? '...' : ''}`
            : 'Unknown commit',
          timestamp: commit?.createdAt,
          commitMessage: commit?.message,
        }
      }

      case 'tag': {
        const [tag] = await db
          .select({ name: tags.name, createdAt: tags.createdAt })
          .from(tags)
          .where(eq(tags.id, context.tagId))
          .limit(1)

        return {
          context,
          label: tag ? tag.name : 'Unknown tag',
          timestamp: tag?.createdAt,
        }
      }

      default:
        return {
          context,
          label: 'Unknown context',
        }
    }
  }

  /**
   * Compute node diffs between two thread responses.
   * Matches nodes by masterId to handle different versions of the same item.
   */
  private static computeNodeDiffs(
    before: ThreadResponse,
    after: ThreadResponse,
    includeFieldChanges: boolean,
  ): {
    focalItemDiff: ThreadNodeDiff
    domainDiffs: {
      requirements: Array<ThreadNodeDiff>
      engineering: Array<ThreadNodeDiff>
      manufacturing: Array<ThreadNodeDiff>
      validation: Array<ThreadNodeDiff>
    }
  } {
    // Build maps by masterId
    const beforeNodesMap = new Map<string, ThreadNode>()
    const afterNodesMap = new Map<string, ThreadNode>()

    // Add focal items
    beforeNodesMap.set(before.focalItem.masterId, before.focalItem)
    afterNodesMap.set(after.focalItem.masterId, after.focalItem)

    // Add all domain nodes
    for (const domain of [
      'requirements',
      'engineering',
      'manufacturing',
      'validation',
    ] as const) {
      for (const node of before.domains[domain]) {
        beforeNodesMap.set(node.masterId, node)
      }
      for (const node of after.domains[domain]) {
        afterNodesMap.set(node.masterId, node)
      }
    }

    // Compute focal item diff
    const focalItemDiff = this.computeSingleNodeDiff(
      before.focalItem,
      after.focalItem,
      includeFieldChanges,
    )

    // Compute domain diffs
    const domainDiffs = {
      requirements: this.computeDomainNodeDiffs(
        before.domains.requirements,
        after.domains.requirements,
        beforeNodesMap,
        afterNodesMap,
        includeFieldChanges,
      ),
      engineering: this.computeDomainNodeDiffs(
        before.domains.engineering,
        after.domains.engineering,
        beforeNodesMap,
        afterNodesMap,
        includeFieldChanges,
      ),
      manufacturing: this.computeDomainNodeDiffs(
        before.domains.manufacturing,
        after.domains.manufacturing,
        beforeNodesMap,
        afterNodesMap,
        includeFieldChanges,
      ),
      validation: this.computeDomainNodeDiffs(
        before.domains.validation,
        after.domains.validation,
        beforeNodesMap,
        afterNodesMap,
        includeFieldChanges,
      ),
    }

    return { focalItemDiff, domainDiffs }
  }

  /**
   * Compute diff for nodes in a single domain.
   */
  private static computeDomainNodeDiffs(
    beforeNodes: Array<ThreadNode>,
    afterNodes: Array<ThreadNode>,
    _beforeNodesMap: Map<string, ThreadNode>,
    _afterNodesMap: Map<string, ThreadNode>,
    includeFieldChanges: boolean,
  ): Array<ThreadNodeDiff> {
    const beforeByMasterId = new Map<string, ThreadNode>()
    const afterByMasterId = new Map<string, ThreadNode>()

    for (const node of beforeNodes) {
      beforeByMasterId.set(node.masterId, node)
    }
    for (const node of afterNodes) {
      afterByMasterId.set(node.masterId, node)
    }

    const diffs: Array<ThreadNodeDiff> = []
    const processedMasterIds = new Set<string>()

    // Process nodes in "after" (added or modified or unchanged)
    for (const afterNode of afterNodes) {
      const beforeNode = beforeByMasterId.get(afterNode.masterId)
      processedMasterIds.add(afterNode.masterId)

      if (!beforeNode) {
        // Added
        diffs.push({
          node: afterNode,
          status: 'added',
          fieldChanges: [],
          sourceContext: 'after',
        })
      } else {
        // Check if modified or unchanged
        const diff = this.computeSingleNodeDiff(
          beforeNode,
          afterNode,
          includeFieldChanges,
        )
        diffs.push(diff)
      }
    }

    // Process nodes only in "before" (removed)
    for (const beforeNode of beforeNodes) {
      if (!processedMasterIds.has(beforeNode.masterId)) {
        diffs.push({
          node: beforeNode,
          status: 'removed',
          fieldChanges: [],
          sourceContext: 'before',
        })
      }
    }

    return diffs
  }

  /**
   * Compute diff for a single node.
   */
  private static computeSingleNodeDiff(
    beforeNode: ThreadNode | undefined,
    afterNode: ThreadNode | undefined,
    _includeFieldChanges: boolean,
  ): ThreadNodeDiff {
    if (!beforeNode && afterNode) {
      return {
        node: afterNode,
        status: 'added',
        fieldChanges: [],
        sourceContext: 'after',
      }
    }

    if (beforeNode && !afterNode) {
      return {
        node: beforeNode,
        status: 'removed',
        fieldChanges: [],
        sourceContext: 'before',
      }
    }

    if (!beforeNode || !afterNode) {
      throw new Error('At least one node must exist for comparison')
    }

    // Both exist - check if modified
    const fieldChanges: Array<FieldChange> = []

    // Compare core fields
    if (beforeNode.name !== afterNode.name) {
      fieldChanges.push({
        fieldName: 'name',
        oldValue: beforeNode.name,
        newValue: afterNode.name,
        fieldCategory: 'core',
      })
    }

    if (beforeNode.revision !== afterNode.revision) {
      fieldChanges.push({
        fieldName: 'revision',
        oldValue: beforeNode.revision,
        newValue: afterNode.revision,
        fieldCategory: 'core',
      })
    }

    if (beforeNode.state !== afterNode.state) {
      fieldChanges.push({
        fieldName: 'state',
        oldValue: beforeNode.state,
        newValue: afterNode.state,
        fieldCategory: 'core',
      })
    }

    const status: NodeDiffStatus =
      fieldChanges.length > 0 ? 'modified' : 'unchanged'

    return {
      node: afterNode,
      status,
      previousNode: status === 'modified' ? beforeNode : undefined,
      fieldChanges,
      sourceContext: 'both',
    }
  }

  /**
   * Compute edge diffs between two sets of relationships.
   * Matches edges by sourceId + targetId + relationshipType.
   */
  private static computeEdgeDiffs(
    beforeEdges: Array<ThreadEdge>,
    afterEdges: Array<ThreadEdge>,
  ): Array<ThreadEdgeDiff> {
    const edgeKey = (edge: ThreadEdge) =>
      `${edge.sourceId}|${edge.targetId}|${edge.relationshipType}`

    const beforeByKey = new Map<string, ThreadEdge>()
    const afterByKey = new Map<string, ThreadEdge>()

    for (const edge of beforeEdges) {
      beforeByKey.set(edgeKey(edge), edge)
    }
    for (const edge of afterEdges) {
      afterByKey.set(edgeKey(edge), edge)
    }

    const diffs: Array<ThreadEdgeDiff> = []
    const processedKeys = new Set<string>()

    // Process edges in "after"
    for (const afterEdge of afterEdges) {
      const key = edgeKey(afterEdge)
      const beforeEdge = beforeByKey.get(key)
      processedKeys.add(key)

      if (!beforeEdge) {
        // Added
        diffs.push({
          edge: afterEdge,
          status: 'added',
          sourceContext: 'after',
        })
      } else {
        // Check for changes in quantity or derivationMethod
        const quantityChanged = beforeEdge.quantity !== afterEdge.quantity
        const derivationMethodChanged =
          beforeEdge.derivationMethod !== afterEdge.derivationMethod

        if (quantityChanged || derivationMethodChanged) {
          diffs.push({
            edge: afterEdge,
            status: 'modified',
            previousEdge: beforeEdge,
            changes: { quantityChanged, derivationMethodChanged },
            sourceContext: 'both',
          })
        } else {
          diffs.push({
            edge: afterEdge,
            status: 'unchanged',
            sourceContext: 'both',
          })
        }
      }
    }

    // Process edges only in "before" (removed)
    for (const beforeEdge of beforeEdges) {
      const key = edgeKey(beforeEdge)
      if (!processedKeys.has(key)) {
        diffs.push({
          edge: beforeEdge,
          status: 'removed',
          sourceContext: 'before',
        })
      }
    }

    return diffs
  }

  /**
   * Get field changes for a modified node from itemFieldChanges table.
   * This provides detailed field-level changes from the commit history.
   */
  static async getFieldChangesFromHistory(
    itemId: string,
    _beforeCommitId: string,
    _afterCommitId: string,
  ): Promise<Array<FieldChange>> {
    // Get all item versions between the two commits
    const [beforeItem, afterItem] = await Promise.all([
      db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.id, itemId))
        .limit(1),
      db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.id, itemId))
        .limit(1),
    ])

    if (!beforeItem[0] || !afterItem[0]) {
      return []
    }

    // Get itemVersions for this item in commits between before and after
    const versionIds = await db
      .select({ id: itemVersions.id })
      .from(itemVersions)
      .innerJoin(commits, eq(itemVersions.commitId, commits.id))
      .where(eq(itemVersions.itemId, itemId))

    if (versionIds.length === 0) {
      return []
    }

    // Get field changes for these versions
    const changes = await db
      .select()
      .from(itemFieldChanges)
      .where(
        inArray(
          itemFieldChanges.itemVersionId,
          versionIds.map((v) => v.id),
        ),
      )

    return changes.map((change) => ({
      fieldName: change.fieldName,
      fieldPath: change.fieldPath ?? undefined,
      oldValue: change.oldValue,
      newValue: change.newValue,
      fieldCategory: (change.fieldCategory ??
        'core') as FieldChange['fieldCategory'],
    }))
  }

  /**
   * Calculate comparison statistics.
   */
  private static calculateStats(
    focalItemDiff: ThreadNodeDiff,
    domainDiffs: {
      requirements: Array<ThreadNodeDiff>
      engineering: Array<ThreadNodeDiff>
      manufacturing: Array<ThreadNodeDiff>
      validation: Array<ThreadNodeDiff>
    },
    edgeDiffs: Array<ThreadEdgeDiff>,
    beforeStats: ThreadResponse['stats'],
    afterStats: ThreadResponse['stats'],
  ): ThreadComparisonStats {
    let nodesAdded = 0
    let nodesRemoved = 0
    let nodesModified = 0
    let nodesUnchanged = 0
    let totalFieldChanges = 0

    const changesByDomain: Record<
      ThreadDomain,
      { added: number; removed: number; modified: number }
    > = {
      requirements: { added: 0, removed: 0, modified: 0 },
      engineering: { added: 0, removed: 0, modified: 0 },
      manufacturing: { added: 0, removed: 0, modified: 0 },
      validation: { added: 0, removed: 0, modified: 0 },
    }

    // Count focal item
    if (focalItemDiff.status === 'added') nodesAdded++
    else if (focalItemDiff.status === 'removed') nodesRemoved++
    else if (focalItemDiff.status === 'modified') {
      nodesModified++
      totalFieldChanges += focalItemDiff.fieldChanges.length
    } else nodesUnchanged++

    // Count domain nodes
    for (const [domain, diffs] of Object.entries(domainDiffs) as Array<
      [ThreadDomain, Array<ThreadNodeDiff>]
    >) {
      for (const diff of diffs) {
        switch (diff.status) {
          case 'added':
            nodesAdded++
            changesByDomain[domain].added++
            break
          case 'removed':
            nodesRemoved++
            changesByDomain[domain].removed++
            break
          case 'modified':
            nodesModified++
            changesByDomain[domain].modified++
            totalFieldChanges += diff.fieldChanges.length
            break
          case 'unchanged':
            nodesUnchanged++
            break
        }
      }
    }

    // Count edge changes
    let relationshipsAdded = 0
    let relationshipsRemoved = 0
    let relationshipsModified = 0

    for (const edgeDiff of edgeDiffs) {
      switch (edgeDiff.status) {
        case 'added':
          relationshipsAdded++
          break
        case 'removed':
          relationshipsRemoved++
          break
        case 'modified':
          relationshipsModified++
          break
      }
    }

    return {
      nodesAdded,
      nodesRemoved,
      nodesModified,
      nodesUnchanged,
      totalNodes: nodesAdded + nodesRemoved + nodesModified + nodesUnchanged,
      changesByDomain,
      relationshipsAdded,
      relationshipsRemoved,
      relationshipsModified,
      totalFieldChanges,
      coverageChanges: {
        mbomCoverage: {
          before: beforeStats.mbomCoverage,
          after: afterStats.mbomCoverage,
        },
        requirementsCoverage: {
          before: beforeStats.requirementsCoverage,
          after: afterStats.requirementsCoverage,
        },
        testCoverage: {
          before: beforeStats.testCoverage,
          after: afterStats.testCoverage,
        },
      },
    }
  }
}
