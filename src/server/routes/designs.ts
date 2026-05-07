import { Hono } from 'hono'
import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import type {
  CommitGraphData,
  CommitGraphEdge,
  CommitGraphNode,
  CommitNodeData,
} from '@/lib/versioning/graph-types'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { BranchService } from '@/lib/services/BranchService'
import { ItemService } from '@/lib/items/services/ItemService'
import { CrossDesignReferenceService } from '@/lib/services/CrossDesignReferenceService'
import { UsageService } from '@/lib/services/UsageService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { RequirementService } from '@/lib/services/RequirementService'
import { VerificationService } from '@/lib/services/VerificationService'
import {
  GapAnalysisService,
  gapAnalysisRequestSchema,
} from '@/lib/services/GapAnalysisService'
import { JobService } from '@/lib/jobs/JobService'
import { requirePermission } from '@/lib/auth/server'
import { requireDesignAccess } from '@/lib/auth/access'
import { permissionService } from '@/lib/auth/permission-service'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { apiHandler, created, jsonResponse } from '@/lib/api/handler'
import { serviceLogger } from '@/lib/logging/logger'
import { db } from '@/lib/db'
import {
  changeOrderAffectedItems,
  changeOrders,
  itemRelationships,
  items,
} from '@/lib/db/schema/items'
import {
  branchItems,
  branches,
  commits,
  tags,
} from '@/lib/db/schema/versioning'
import { users } from '@/lib/db/schema/users'
import { designs } from '@/lib/db/schema/designs'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Designs')

// ============================================
// Types
// ============================================

interface ECOSummary {
  id: string
  itemNumber: string
  name: string
  state: string
  reasonForChange: string
  itemCount: number
  owner: { id: string; name: string }
  createdAt: string
  submittedAt?: string
}

interface BOMTreeNode {
  itemId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  quantity?: number
  findNumber?: number
  relationshipId?: string // ID of the BOM relationship to parent (undefined for roots)
  isInWork?: boolean
  children?: Array<BOMTreeNode>
  // Cross-design reference fields
  designId?: string | null
  designCode?: string
  designName?: string
  isExternal?: boolean
  // Cross-design reference (lightweight link, not usage-copy)
  isCrossDesignRef?: boolean
  crossReferenceId?: string
}

interface OrphanItem {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
}

interface Item {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  modifiedAt: string
}

const cloneInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  programId: z.string().uuid().optional(),
  suffixItemNumbers: z.boolean().optional(),
})

// ============================================
// Commit Consolidation
// ============================================

/** Time window in milliseconds for consolidating commits (30 minutes) */
const CONSOLIDATION_TIME_WINDOW_MS = 30 * 60 * 1000

/** Minimum number of commits to trigger consolidation */
const MIN_COMMITS_TO_CONSOLIDATE = 2

/**
 * Check if a commit should NOT be consolidated (is "important")
 */
function isImportantCommit(data: CommitNodeData): boolean {
  // Merge commits are always important
  if (data.isMergeCommit) return true
  // ECO-related commits are always important
  if (data.changeOrderItemId || data.ecoNumber) return true
  // Commits with tags are always important
  if (data.tags && data.tags.length > 0) return true
  // Initial commits are important
  if (data.message === 'Initial commit') return true
  // ChangeOrder commits are important - each ECO should be its own node
  if (data.message.includes('ChangeOrder')) return true
  return false
}

/**
 * Extract the action type from a commit message
 * Returns: 'created' | 'updated' | 'deleted' | 'other'
 */
function extractActionType(message: string): string {
  const lowerMsg = message.toLowerCase()
  if (lowerMsg.includes('created') || lowerMsg.includes('added'))
    return 'created'
  if (lowerMsg.includes('updated') || lowerMsg.includes('modified'))
    return 'updated'
  if (lowerMsg.includes('deleted') || lowerMsg.includes('removed'))
    return 'deleted'
  return 'other'
}

/**
 * Extract the item type from a commit message (Part, Document, etc.)
 */
function extractItemType(message: string): string {
  // Match patterns like "Part WA-1000 created" or "Document DOC-001 updated"
  const match = message.match(
    /^(Part|Document|ChangeOrder|Requirement|Task)\s+/i,
  )
  if (match) return match[1]
  return 'Item'
}

/**
 * Generate a consolidated message
 */
function generateConsolidatedMessage(
  count: number,
  actionType: string,
  itemType: string,
): string {
  const plural = count > 1 ? 's' : ''
  const verb =
    actionType === 'created'
      ? 'created'
      : actionType === 'updated'
        ? 'updated'
        : actionType === 'deleted'
          ? 'deleted'
          : 'modified'
  return `${count} ${itemType}${plural} ${verb}`
}

/**
 * Consolidate sequential similar commits into grouped nodes
 */
function consolidateCommits(
  nodes: Array<CommitGraphNode>,
  edges: Array<CommitGraphEdge>,
): { nodes: Array<CommitGraphNode>; edges: Array<CommitGraphEdge> } {
  if (nodes.length < MIN_COMMITS_TO_CONSOLIDATE) {
    return { nodes, edges }
  }

  // Sort nodes by date (oldest first) for processing
  const sortedNodes = [...nodes].sort(
    (a, b) => new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
  )

  // Group commits that can be consolidated
  const consolidatedNodes: Array<CommitGraphNode> = []
  const removedNodeIds = new Set<string>()
  let i = 0

  while (i < sortedNodes.length) {
    const currentNode = sortedNodes[i]

    // If this is an important commit, don't consolidate it
    if (isImportantCommit(currentNode.data)) {
      consolidatedNodes.push(currentNode)
      i++
      continue
    }

    // Try to find consecutive commits to consolidate
    const group: Array<CommitGraphNode> = [currentNode]
    const currentAction = extractActionType(currentNode.data.message)
    const currentItemType = extractItemType(currentNode.data.message)
    const currentTime = new Date(currentNode.data.date).getTime()

    let j = i + 1
    while (j < sortedNodes.length) {
      const nextNode = sortedNodes[j]

      // Stop if next commit is important
      if (isImportantCommit(nextNode.data)) break

      // Stop if different branch
      if (nextNode.data.branchId !== currentNode.data.branchId) break

      // Stop if different author
      if (nextNode.data.author.id !== currentNode.data.author.id) break

      // Stop if different action type
      if (extractActionType(nextNode.data.message) !== currentAction) break

      // Stop if different item type
      if (extractItemType(nextNode.data.message) !== currentItemType) break

      // Stop if outside time window (compare to first commit in group)
      const nextTime = new Date(nextNode.data.date).getTime()
      if (nextTime - currentTime > CONSOLIDATION_TIME_WINDOW_MS) break

      group.push(nextNode)
      j++
    }

    if (group.length >= MIN_COMMITS_TO_CONSOLIDATE) {
      // Create consolidated node
      const firstCommit = group[0]
      const lastCommit = group[group.length - 1]

      // Aggregate stats
      const totalStats = group.reduce(
        (acc, n) => ({
          added: acc.added + (n.data.changeStats?.added || 0),
          modified: acc.modified + (n.data.changeStats?.modified || 0),
          deleted: acc.deleted + (n.data.changeStats?.deleted || 0),
        }),
        { added: 0, modified: 0, deleted: 0 },
      )

      const consolidatedNode: CommitGraphNode = {
        id: `consolidated-${firstCommit.id}`,
        type: 'commitNode',
        position: { x: 0, y: 0 },
        data: {
          commitId: firstCommit.data.commitId,
          message: generateConsolidatedMessage(
            group.length,
            currentAction,
            currentItemType,
          ),
          author: firstCommit.data.author,
          date: lastCommit.data.date, // Use latest date for display
          branchId: firstCommit.data.branchId,
          branchName: firstCommit.data.branchName,
          branchType: firstCommit.data.branchType,
          isMergeCommit: false,
          changeStats: totalStats,
          tags: [],
          isConsolidated: true,
          consolidatedCount: group.length,
          consolidatedCommitIds: group.map((n) => n.data.commitId),
          dateRangeStart: firstCommit.data.date,
          dateRangeEnd: lastCommit.data.date,
        },
      }

      consolidatedNodes.push(consolidatedNode)

      // Mark original nodes as removed
      for (const node of group) {
        removedNodeIds.add(node.id)
      }

      i = j
    } else {
      // Not enough commits to consolidate, keep original
      consolidatedNodes.push(currentNode)
      i++
    }
  }

  // Update edges to point to consolidated nodes
  const nodeIdMapping = new Map<string, string>()
  for (const node of consolidatedNodes) {
    if (node.data.isConsolidated && node.data.consolidatedCommitIds) {
      for (const originalId of node.data.consolidatedCommitIds) {
        nodeIdMapping.set(originalId, node.id)
      }
    }
  }

  // Filter and remap edges
  const consolidatedEdges: Array<CommitGraphEdge> = []
  const seenEdges = new Set<string>()

  for (const edge of edges) {
    let sourceId = edge.source
    let targetId = edge.target

    // Skip edges between nodes that were consolidated together
    if (removedNodeIds.has(sourceId) && removedNodeIds.has(targetId)) {
      const newSourceId = nodeIdMapping.get(sourceId)
      const newTargetId = nodeIdMapping.get(targetId)
      if (newSourceId === newTargetId) continue // Same consolidated node
    }

    // Remap to consolidated node IDs
    if (nodeIdMapping.has(sourceId)) {
      sourceId = nodeIdMapping.get(sourceId)!
    }
    if (nodeIdMapping.has(targetId)) {
      targetId = nodeIdMapping.get(targetId)!
    }

    // Skip if source or target was removed and not remapped
    if (removedNodeIds.has(edge.source) && !nodeIdMapping.has(edge.source))
      continue
    if (removedNodeIds.has(edge.target) && !nodeIdMapping.has(edge.target))
      continue

    // Avoid duplicate edges
    const edgeKey = `${sourceId}-${targetId}-${edge.data?.edgeType || 'default'}`
    if (seenEdges.has(edgeKey)) continue
    seenEdges.add(edgeKey)

    consolidatedEdges.push({
      ...edge,
      id: `${sourceId}-${targetId}${edge.data?.edgeType === 'merge' ? '-merge' : ''}`,
      source: sourceId,
      target: targetId,
    })
  }

  return { nodes: consolidatedNodes, edges: consolidatedEdges }
}

/**
 * Build commit graph data for visualization
 *
 * When viewing main branch: Shows main commits plus historical merged branches
 * When viewing other branch: Shows main + that branch's commits
 */
async function buildCommitGraph(
  designId: string,
  selectedBranchId: string | null,
  limit: number,
): Promise<CommitGraphData> {
  // 1. Get the main branch and all branches (including archived for historical reconstruction)
  const allBranches = await DesignService.getBranches(designId, true) // Include archived
  const mainBranch = allBranches.find((b) => b.branchType === 'main')

  if (!mainBranch) {
    return {
      nodes: [],
      edges: [],
      mainBranchId: '',
    }
  }

  // 2. Get main branch commits
  const mainCommits = await db
    .select()
    .from(commits)
    .where(eq(commits.branchId, mainBranch.id))
    .orderBy(desc(commits.createdAt))
    .limit(limit)

  // 3. Get selected branch commits if specified (for active branch view)
  let branchCommits: typeof mainCommits = []
  let selectedBranch: (typeof allBranches)[0] | null = null
  let forkPoint: string | undefined

  if (selectedBranchId && selectedBranchId !== mainBranch.id) {
    selectedBranch = await BranchService.getById(selectedBranchId)
    if (selectedBranch && selectedBranch.designId === designId) {
      forkPoint = selectedBranch.baseCommitId || undefined

      branchCommits = await db
        .select()
        .from(commits)
        .where(eq(commits.branchId, selectedBranchId))
        .orderBy(desc(commits.createdAt))
        .limit(limit)
    }
  }

  // 3b. When viewing main branch, also get all open (non-archived) ECO branches
  const openEcoBranchCommits: typeof mainCommits = []
  const openEcoBranchInfo = new Map<
    string,
    { name: string; branchType: string; baseCommitId: string | null }
  >()

  if (!selectedBranchId || selectedBranchId === mainBranch.id) {
    // Find all non-archived ECO branches for this design
    const openEcoBranches = allBranches.filter(
      (b) => b.branchType === 'eco' && !b.isArchived,
    )

    for (const ecoBranch of openEcoBranches) {
      openEcoBranchInfo.set(ecoBranch.id, {
        name: ecoBranch.name,
        branchType: ecoBranch.branchType,
        baseCommitId: ecoBranch.baseCommitId,
      })

      // Get commits for this open ECO branch
      const ecoBranchCommits = await db
        .select()
        .from(commits)
        .where(eq(commits.branchId, ecoBranch.id))
        .orderBy(desc(commits.createdAt))
        .limit(limit)

      openEcoBranchCommits.push(...ecoBranchCommits)
    }
  }

  // 4. Find historical merged branches
  // Look at merge commits on main and reconstruct the branches that were merged
  // Always include these regardless of which branch is selected, so users can see
  // the full history context including previously merged ECOs
  const historicalBranchCommits: typeof mainCommits = []
  const historicalBranchInfo = new Map<
    string,
    { name: string; branchType: string }
  >()

  // Find merge commits on main (commits with mergeParentId)
  const mergeCommits = mainCommits.filter((c) => c.mergeParentId !== null)

  if (mergeCommits.length > 0) {
    // Get all merge parent commit IDs
    const mergeParentIds = mergeCommits
      .map((c) => c.mergeParentId)
      .filter((id): id is string => id !== null)

    if (mergeParentIds.length > 0) {
      // Fetch the merge parent commits (tips of merged branches)
      const mergeParentCommits = await db
        .select()
        .from(commits)
        .where(inArray(commits.id, mergeParentIds))

      // For each merge parent, trace back to find all commits in that branch
      // until we hit a commit that's on main (the fork point)
      for (const mergeParent of mergeParentCommits) {
        const branchId = mergeParent.branchId

        // Skip if this is somehow a main branch commit
        if (branchId === mainBranch.id) continue

        // Find the branch info
        const branch = allBranches.find((b) => b.id === branchId)
        if (branch) {
          historicalBranchInfo.set(branchId, {
            name: branch.name,
            branchType: branch.branchType,
          })
        }

        // Get all commits from this historical branch
        const branchHistoryCommits = await db
          .select()
          .from(commits)
          .where(eq(commits.branchId, branchId))
          .orderBy(desc(commits.createdAt))

        historicalBranchCommits.push(...branchHistoryCommits)
      }
    }
  }

  // 5. Collect all commits
  const allCommits = [
    ...mainCommits,
    ...branchCommits,
    ...openEcoBranchCommits,
    ...historicalBranchCommits,
  ]
  // Deduplicate by commit ID
  const uniqueCommits = Array.from(
    new Map(allCommits.map((c) => [c.id, c])).values(),
  )
  const allCommitIds = uniqueCommits.map((c) => c.id)

  if (allCommitIds.length === 0) {
    return {
      nodes: [],
      edges: [],
      mainBranchId: mainBranch.id,
      selectedBranchId: selectedBranchId || undefined,
      selectedBranchName: selectedBranch?.name,
    }
  }

  // 6. Get tags for these commits
  const commitTags = await db
    .select()
    .from(tags)
    .where(inArray(tags.commitId, allCommitIds))

  // Group tags by commit ID
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

  // 7. Get authors for all commits
  const authorIds = [
    ...new Set(uniqueCommits.map((c) => c.createdBy).filter(Boolean)),
  ]
  let authorMap = new Map<string, string>()

  if (authorIds.length > 0) {
    const authors = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, authorIds))

    authorMap = new Map(authors.map((a) => [a.id, a.name || 'Unknown']))
  }

  // 8. Get ECO item numbers for commits linked to change orders
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

  // 9. Build nodes
  const nodes: Array<CommitGraphNode> = []
  const edges: Array<CommitGraphEdge> = []

  // Track commit IDs we're including (for edge filtering)
  const includedCommitIds = new Set(allCommitIds)

  for (const commit of uniqueCommits) {
    const isMainBranch = commit.branchId === mainBranch.id

    // Determine branch name and type for this commit
    let branchName: string
    let branchType: 'main' | 'eco' | 'workspace' | 'release'

    if (isMainBranch) {
      branchName = mainBranch.name
      branchType = 'main'
    } else if (selectedBranch && commit.branchId === selectedBranch.id) {
      branchName = selectedBranch.name
      branchType = (selectedBranch.branchType ||
        'eco') as 'eco' | 'workspace' | 'release'
    } else {
      // Look up from open ECO branches first, then historical branches
      const openEcoInfo = openEcoBranchInfo.get(commit.branchId)
      const histInfo = historicalBranchInfo.get(commit.branchId)
      const branchInfo = openEcoInfo || histInfo
      branchName = branchInfo?.name || 'Unknown Branch'
      branchType = (branchInfo?.branchType ||
        'eco') as 'eco' | 'workspace' | 'release'
    }

    nodes.push({
      id: commit.id,
      type: 'commitNode',
      position: { x: 0, y: 0 }, // Will be calculated by layout
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
          | Record<string, string>
          | undefined,
      },
    })

    // Parent edge (only if parent is in our set)
    if (commit.parentId && includedCommitIds.has(commit.parentId)) {
      edges.push({
        id: `${commit.parentId}-${commit.id}`,
        source: commit.parentId,
        target: commit.id,
        type: 'default',
        data: { edgeType: 'parent' },
      })
    }

    // Merge parent edge (only if merge parent is in our set)
    if (commit.mergeParentId && includedCommitIds.has(commit.mergeParentId)) {
      edges.push({
        id: `${commit.mergeParentId}-${commit.id}-merge`,
        source: commit.mergeParentId,
        target: commit.id,
        type: 'default',
        data: { edgeType: 'merge' },
        animated: true, // Dashed/animated for merge edges
        style: { strokeDasharray: '5,5' },
      })
    }
  }

  // 9. Add edge from fork point to first branch commit (for selected branch)
  if (forkPoint && selectedBranch && branchCommits.length > 0) {
    // Find the oldest commit on the branch (closest to fork point)
    const oldestBranchCommit = branchCommits[branchCommits.length - 1]

    // Only add if fork point is in our nodes
    if (includedCommitIds.has(forkPoint)) {
      // Check if edge already exists
      const edgeId = `${forkPoint}-${oldestBranchCommit.id}`
      if (!edges.find((e) => e.id === edgeId)) {
        edges.push({
          id: edgeId,
          source: forkPoint,
          target: oldestBranchCommit.id,
          type: 'default',
          data: { edgeType: 'parent' },
        })
      }
    }
  }

  // 10. Add fork point edges for historical branches
  // Connect each historical branch's first commit to its base commit on main
  for (const [branchId] of historicalBranchInfo) {
    const branch = allBranches.find((b) => b.id === branchId)
    if (!branch?.baseCommitId) continue

    // Find the oldest commit on this historical branch
    const branchHistoryCommits = uniqueCommits.filter(
      (c) => c.branchId === branchId,
    )
    if (branchHistoryCommits.length === 0) continue

    // Sort by date ascending to find oldest (first) commit
    const sortedCommits = [...branchHistoryCommits].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    const oldestCommit = sortedCommits[0]

    // Add edge from fork point to first branch commit if not already connected
    if (includedCommitIds.has(branch.baseCommitId)) {
      const edgeId = `${branch.baseCommitId}-${oldestCommit.id}`
      if (!edges.find((e) => e.id === edgeId)) {
        edges.push({
          id: edgeId,
          source: branch.baseCommitId,
          target: oldestCommit.id,
          type: 'default',
          data: { edgeType: 'parent' },
        })
      }
    }
  }

  // 10b. Add fork point edges for open ECO branches
  // Connect each open ECO branch's first commit to its base commit on main
  for (const [branchId, branchInfo] of openEcoBranchInfo) {
    if (!branchInfo.baseCommitId) continue

    // Find the oldest commit on this open ECO branch
    const ecoBranchCommits = uniqueCommits.filter(
      (c) => c.branchId === branchId,
    )
    if (ecoBranchCommits.length === 0) continue

    // Sort by date ascending to find oldest (first) commit
    const sortedCommits = [...ecoBranchCommits].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    const oldestCommit = sortedCommits[0]

    // Add edge from fork point to first branch commit if not already connected
    if (includedCommitIds.has(branchInfo.baseCommitId)) {
      const edgeId = `${branchInfo.baseCommitId}-${oldestCommit.id}`
      if (!edges.find((e) => e.id === edgeId)) {
        edges.push({
          id: edgeId,
          source: branchInfo.baseCommitId,
          target: oldestCommit.id,
          type: 'default',
          data: { edgeType: 'parent' },
        })
      }
    }
  }

  // 11. Consolidate sequential similar commits
  const consolidated = consolidateCommits(nodes, edges)

  return {
    nodes: consolidated.nodes,
    edges: consolidated.edges,
    forkPoint,
    mainBranchId: mainBranch.id,
    selectedBranchId: selectedBranchId || undefined,
    selectedBranchName: selectedBranch?.name,
  }
}

const app = new Hono()

// =============================================
// Static routes MUST come before parameterized
// =============================================

// GET /api/designs/families
app.get(
  '/families',
  adapt(
    apiHandler({}, async ({ request }) => {
      const url = new URL(request.url, 'http://localhost')
      const programId = url.searchParams.get('programId')

      const families = await DesignService.getAvailableFamilies(programId)

      return { families }
    }),
  ),
)

// =============================================
// Parameterized routes with :id
// =============================================

// GET /api/designs - pagination, sorting, filtering, optional type counts
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url, 'http://localhost')
      const programId = url.searchParams.get('programId')
      const designType = url.searchParams.get('designType') as
        | 'Engineering'
        | 'Library'
        | 'Family'
        | null
      const includeArchived = url.searchParams.get('includeArchived') === 'true'
      const includeHierarchy =
        url.searchParams.get('includeHierarchy') === 'true'
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const sortField = url.searchParams.get('sortField') || undefined
      const sortDirection = (url.searchParams.get('sortDirection') ||
        undefined) as 'asc' | 'desc' | undefined
      const includeCounts = url.searchParams.get('includeCounts') === 'true'
      const globalSearch = url.searchParams.get('globalSearch') || undefined

      let columnFilters:
        | Record<
            string,
            string | Array<string> | { min?: number; max?: number }
          >
        | undefined
      const columnFiltersRaw = url.searchParams.get('columnFilters')
      if (columnFiltersRaw) {
        try {
          columnFilters = JSON.parse(columnFiltersRaw)
        } catch {
          // Invalid JSON — ignore
        }
      }

      // Hierarchy mode: no pagination, uses the hierarchy-aware method
      if (includeHierarchy) {
        const hierarchicalDesigns = await DesignService.listWithHierarchy({
          programId: programId || undefined,
          designType: designType || undefined,
          includeArchived,
        })

        const accessibleProgramIds =
          await AccessControlService.getAccessibleProgramIds(user.id)
        const isGlobalAdmin = await AccessControlService.isGlobalAdmin(user.id)

        const filteredDesigns = isGlobalAdmin
          ? hierarchicalDesigns
          : hierarchicalDesigns.filter(
              (d) =>
                d.programId === null ||
                accessibleProgramIds!.includes(d.programId),
            )

        return { designs: filteredDesigns }
      }

      // Accessible program IDs (null = admin, array = specific programs)
      let programIds = await AccessControlService.getAccessibleProgramIds(
        user.id,
      )

      const filterByProgram = !!programId
      if (programId) {
        if (programIds === null) {
          programIds = [programId]
        } else if (programIds.includes(programId)) {
          programIds = [programId]
        }
      }

      const includeGlobalLibraries = !filterByProgram
      const includeUnassigned = !filterByProgram

      const mergedFilters: Record<
        string,
        string | Array<string> | { min?: number; max?: number }
      > = { ...columnFilters }
      if (designType) {
        mergedFilters.designType = [designType]
      }

      const result = await DesignService.search({
        programIds,
        limit,
        offset,
        sortField,
        sortDirection,
        columnFilters:
          Object.keys(mergedFilters).length > 0 ? mergedFilters : undefined,
        globalSearch,
        includeGlobalLibraries,
        includeUnassigned,
      })

      const response: Record<string, unknown> = {
        designs: result.items,
        total: result.total,
      }

      if (includeCounts) {
        const [designCount, familyCount, libraryCount] = await Promise.all([
          DesignService.search({
            programIds,
            limit: 1,
            columnFilters: { designType: ['Engineering'] },
            includeGlobalLibraries,
            includeUnassigned,
          }),
          DesignService.search({
            programIds,
            limit: 1,
            columnFilters: { designType: ['Family'] },
            includeGlobalLibraries,
            includeUnassigned,
          }),
          DesignService.search({
            programIds,
            limit: 1,
            columnFilters: { designType: ['Library'] },
            includeGlobalLibraries,
            includeUnassigned,
          }),
        ])
        response.counts = {
          design: designCount.total,
          family: familyCount.total,
          library: libraryCount.total,
        }
      }

      return response
    }),
  ),
)

// POST /api/designs
app.post(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const data = await request.json()

      // If programId is provided, check user has permission in that program
      if (data.programId) {
        const member = await ProgramService.getMember(data.programId, user.id)
        if (!member || !member.canManageProducts) {
          throw new PermissionDeniedError('designs', 'create')
        }
      } else {
        // Creating design without program requires global permission
        await requirePermission(request, 'designs', 'create')
      }

      const design = await DesignService.create(data, user.id)

      return created({ design })
    }),
  ),
)

// GET /api/designs/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) throw new NotFoundError('Design', params.id)

      // Check access - Global Admin bypasses program membership check
      if (design.programId) {
        const isGlobalAdmin = await permissionService.hasRole(
          user.id,
          'Global Admin',
        )
        if (!isGlobalAdmin) {
          const canAccess = await ProgramService.canUserAccess(
            user.id,
            design.programId,
          )
          if (!canAccess) throw new PermissionDeniedError('design', 'read')
        }
      }

      // Get default branch info
      const defaultBranch = await DesignService.getDefaultBranch(params.id)

      return { design: { ...design, defaultBranch } }
    }),
  ),
)

// PUT /api/designs/:id
app.put(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) throw new NotFoundError('Design', params.id)

      // Check permission
      if (design.programId) {
        const member = await ProgramService.getMember(design.programId, user.id)
        if (!member || !member.canManageProducts) {
          await requirePermission(request, 'designs', 'update')
        }
      } else {
        await requirePermission(request, 'designs', 'update')
      }

      const data = await request.json()
      const updated = await DesignService.update(params.id, data, user.id)
      return { design: updated }
    }),
  ),
)

// DELETE /api/designs/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) throw new NotFoundError('Design', params.id)

      // Check permission
      if (design.programId) {
        const member = await ProgramService.getMember(design.programId, user.id)
        if (!member || !member.canManageProducts) {
          await requirePermission(request, 'designs', 'delete')
        }
      } else {
        await requirePermission(request, 'designs', 'delete')
      }

      await DesignService.archive(params.id, user.id)
      return { success: true }
    }),
  ),
)

// GET /api/designs/:id/details - Composite endpoint returning design with
// branches, tags, default branch, program, and parent design info.
app.get(
  '/:id/details',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) throw new NotFoundError('Design', params.id)

      await requireDesignAccess(user.id, params.id)

      const [branchList, tagList, programs] = await Promise.all([
        DesignService.getBranches(params.id).catch((err) => {
          serviceLogger.error(
            { err, designId: params.id },
            'Failed to fetch branches for design',
          )
          return []
        }),
        DesignService.listTags(params.id).catch((err) => {
          serviceLogger.error(
            { err, designId: params.id },
            'Failed to fetch tags for design',
          )
          return []
        }),
        ProgramService.listAll().catch((err) => {
          serviceLogger.error({ err }, 'Failed to fetch programs')
          return []
        }),
      ])

      const defaultBranch = await DesignService.getDefaultBranch(
        params.id,
      ).catch((err) => {
        serviceLogger.error(
          { err, designId: params.id },
          'Failed to fetch default branch for design',
        )
        return null
      })

      const program = design.programId
        ? programs.find((p: { id: string }) => p.id === design.programId)
        : null

      let parentDesign: { id: string; code: string; name: string } | null = null
      if (design.parentDesignId) {
        const parent = await DesignService.getById(design.parentDesignId).catch(
          () => null,
        )
        if (parent) {
          parentDesign = { id: parent.id, code: parent.code, name: parent.name }
        }
      }

      return {
        design: {
          ...design,
          defaultBranch,
          program,
          parentDesign,
        },
        branches: branchList,
        tags: tagList,
        programs,
      }
    }),
  ),
)

// GET /api/designs/:id/branches
app.get(
  '/:id/branches',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      const url = new URL(request.url, 'http://localhost')
      const includeArchived = url.searchParams.get('includeArchived') === 'true'

      const branchesList = await DesignService.getBranches(
        params.id,
        includeArchived,
      )

      return { branches: branchesList }
    }),
  ),
)

// POST /api/designs/:id/branches
app.post(
  '/:id/branches',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      const data = await request.json()

      let branch
      switch (data.branchType) {
        case 'eco':
          if (!data.changeOrderItemId) {
            throw new ValidationError(
              'changeOrderItemId is required for ECO branches',
            )
          }
          branch = await BranchService.createEcoBranch(
            params.id,
            data.changeOrderItemId,
            user.id,
          )
          break

        case 'workspace':
          if (!data.name) {
            throw new ValidationError('name is required for workspace branches')
          }
          branch = await BranchService.createWorkspaceBranch(
            params.id,
            user.id,
            data.name,
          )
          break

        case 'release':
          if (!data.name || !data.sourceTagId) {
            throw new ValidationError(
              'name and sourceTagId are required for release branches',
            )
          }
          branch = await BranchService.createReleaseBranch(
            params.id,
            data.name,
            data.sourceTagId,
            user.id,
          )
          break

        default:
          throw new ValidationError(
            'Invalid branchType. Must be eco, workspace, or release',
          )
      }

      return created({ branch })
    }),
  ),
)

// POST /api/designs/:id/clone
app.post(
  '/:id/clone',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      // Validate source design exists
      const sourceDesign = await DesignService.getById(params.id)
      if (!sourceDesign) {
        throw new NotFoundError('Design', params.id)
      }

      // Check read access to source design
      await requireDesignAccess(user.id, params.id)

      // Parse and validate input
      const body = await request.json()
      const input = cloneInputSchema.parse(body)

      // Determine target program
      const targetProgramId = input.programId ?? sourceDesign.programId

      // Check create permission in target program
      if (targetProgramId) {
        const isGlobalAdmin = await permissionService.hasRole(
          user.id,
          'Global Admin',
        )
        if (!isGlobalAdmin) {
          const member = await ProgramService.getMember(
            targetProgramId,
            user.id,
          )
          if (!member || !member.canManageProducts) {
            throw new PermissionDeniedError('design', 'create')
          }
        }
      }

      // Check for duplicate code
      const existing = await DesignService.getByCode(input.code)
      if (existing) {
        throw new ValidationError('Design code already exists', undefined, {
          field: 'code',
        })
      }

      // Cannot clone family or library designs
      if (sourceDesign.designType !== 'Engineering') {
        throw new ValidationError(
          `Cannot clone ${sourceDesign.designType} designs`,
        )
      }

      // Submit clone job
      const job = await JobService.submit(
        'design.clone',
        {
          sourceDesignId: params.id,
          targetCode: input.code,
          targetName: input.name,
          targetDescription: input.description,
          targetProgramId: targetProgramId,
          userId: user.id,
          suffixItemNumbers: input.suffixItemNumbers,
        },
        user.id,
        { priority: 'high' },
      )

      return jsonResponse({ jobId: job.id }, 202)
    }),
  ),
)

// GET /api/designs/:id/cross-references
app.get(
  '/:id/cross-references',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      const url = new URL(request.url, 'http://localhost')
      const branchId = url.searchParams.get('branch')

      const references =
        await CrossDesignReferenceService.getReferencesForDesign(
          params.id,
          branchId,
        )

      return { references }
    }),
  ),
)

// POST /api/designs/:id/cross-references
app.post(
  '/:id/cross-references',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      const body = await request.json()
      const {
        refId,
        branchId,
        suffixItemNumber,
        itemIds,
        parentBomRelationshipId,
      } = body

      // Validate: need either refId (legacy) or itemIds (chain)
      if (!refId && (!itemIds || itemIds.length === 0)) {
        throw new ValidationError('Either refId or itemIds is required')
      }

      // If branchId is provided, validate it exists
      if (branchId) {
        const branch = await BranchService.getById(branchId)
        if (!branch) {
          throw new NotFoundError('Branch', branchId)
        }
      }

      // If refId provided, pull in the XREF record (remove cross-design reference)
      // pullInReference returns null if the reference was already removed (idempotent)
      let referencedItemId: string | undefined
      if (refId) {
        const pullInResult = await CrossDesignReferenceService.pullInReference(
          refId,
          branchId || null,
          user.id,
        )
        referencedItemId = pullInResult?.referencedItemId
      }

      // Determine the list of items to pull in
      // Chain mode: itemIds provided (topmost ancestor first, target last)
      // Legacy mode: just the single referenced item
      const chainItemIds: Array<string> =
        itemIds ?? (referencedItemId ? [referencedItemId] : [])

      if (chainItemIds.length === 0) {
        throw new ValidationError('No items to pull in')
      }

      // Fetch all chain items and assert IDs exist (items from DB always have IDs)
      const chainItems = await Promise.all(
        chainItemIds.map(async (id: string) => {
          const item = await ItemService.findById(id)
          if (!item || !item.id) throw new NotFoundError('Item', id)
          return item as typeof item & { id: string; itemNumber: string }
        }),
      )

      const result = await db.transaction(async (tx) => {
        const targetMainBranch = await BranchService.getMainBranch(params.id)
        if (!targetMainBranch) {
          throw new ValidationError('Target design has no main branch')
        }

        // Create usage copies for each item in the chain
        const usageCopyMap = new Map<string, string>() // originalItemId -> usageCopyId
        const createdUsages: Array<{ id: string; masterId: string }> = []

        for (const chainItem of chainItems) {
          // Check if a usage already exists for this item in this design
          const existingUsages = await UsageService.getUsagesOfDefinition(
            chainItem.id,
            {
              designId: params.id,
            },
          )

          if (existingUsages.length > 0) {
            usageCopyMap.set(chainItem.id, existingUsages[0].id)
          } else {
            const overrides: { itemNumber?: string } = {}
            if (suffixItemNumber && design.code) {
              overrides.itemNumber = `${chainItem.itemNumber}-${design.code}`
            }

            const usageResult = await UsageService.createUsage(
              {
                definitionId: chainItem.id,
                targetDesignId: params.id,
                ...(overrides.itemNumber ? { overrides } : {}),
              },
              user.id,
              tx,
            )

            usageCopyMap.set(chainItem.id, usageResult.usage.id)
            createdUsages.push(usageResult.usage)

            await tx.insert(branchItems).values({
              branchId: targetMainBranch.id,
              itemMasterId: usageResult.usage.masterId,
              currentItemId: usageResult.usage.id,
              baseItemId: usageResult.usage.id,
              changeType: null,
            })
          }
        }

        let relationshipsCreated = 0
        const chainItemIdSet = new Set(chainItemIds)

        // Find all BOM relationships between chain items (handles any topology: linear, star, etc.)
        const intraChainRels = await db
          .select()
          .from(itemRelationships)
          .where(
            and(
              inArray(itemRelationships.sourceId, chainItemIds),
              inArray(itemRelationships.targetId, chainItemIds),
              eq(itemRelationships.relationshipType, 'BOM'),
            ),
          )

        for (const rel of intraChainRels) {
          const parentUsageId = usageCopyMap.get(rel.sourceId)
          const childUsageId = usageCopyMap.get(rel.targetId)
          if (parentUsageId && childUsageId) {
            await tx.insert(itemRelationships).values({
              sourceId: parentUsageId,
              targetId: childUsageId,
              relationshipType: rel.relationshipType,
              quantity: rel.quantity,
              findNumber: rel.findNumber,
              referenceDesignator: rel.referenceDesignator,
              metadata: rel.metadata,
              isComposite: rel.isComposite,
              isDirected: rel.isDirected,
              multiplicityLower: rel.multiplicityLower,
              multiplicityUpper: rel.multiplicityUpper,
              usageAttributes: rel.usageAttributes,
              createdBy: user.id,
              modifiedBy: user.id,
            })
            relationshipsCreated++
          }
        }

        // For each chain item, create BOM rels from its usage copy to non-chain children
        // (these point to the original external items, not usage copies)
        for (const chainItemId of chainItemIds) {
          const usageId = usageCopyMap.get(chainItemId)!

          const allChildRels = await db
            .select()
            .from(itemRelationships)
            .where(
              and(
                eq(itemRelationships.sourceId, chainItemId),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          for (const rel of allChildRels) {
            // Skip children that are part of the chain (already handled above)
            if (chainItemIdSet.has(rel.targetId)) continue

            await tx.insert(itemRelationships).values({
              sourceId: usageId,
              targetId: rel.targetId,
              relationshipType: rel.relationshipType,
              quantity: rel.quantity,
              findNumber: rel.findNumber,
              referenceDesignator: rel.referenceDesignator,
              metadata: rel.metadata,
              isComposite: rel.isComposite,
              isDirected: rel.isDirected,
              multiplicityLower: rel.multiplicityLower,
              multiplicityUpper: rel.multiplicityUpper,
              usageAttributes: rel.usageAttributes,
              createdBy: user.id,
              modifiedBy: user.id,
            })
            relationshipsCreated++
          }
        }

        // If parentBomRelationshipId provided, update that BOM rel to point to
        // the topmost chain item's usage copy
        if (parentBomRelationshipId) {
          const topmostUsageId = usageCopyMap.get(chainItemIds[0])
          if (topmostUsageId) {
            await tx
              .update(itemRelationships)
              .set({
                targetId: topmostUsageId,
                modifiedBy: user.id,
              })
              .where(eq(itemRelationships.id, parentBomRelationshipId))
            relationshipsCreated++
          }
        }

        return { items: createdUsages, relationshipsCreated }
      })

      return {
        pulledIn: true,
        items: result.items,
        relationshipsCreated: result.relationshipsCreated,
      }
    }),
  ),
)

// PUT /api/designs/:id/cross-references
app.put(
  '/:id/cross-references',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      const body = await request.json()
      const { referencedItemId, branchId: inputBranchId, notes } = body

      if (!referencedItemId) {
        throw new ValidationError('referencedItemId is required')
      }

      const ref = await CrossDesignReferenceService.createReference(
        {
          referencingDesignId: params.id,
          referencedItemId,
          branchId: inputBranchId || null,
          notes,
        },
        user.id,
      )

      return { reference: ref }
    }),
  ),
)

// DELETE /api/designs/:id/cross-references
app.delete(
  '/:id/cross-references',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      const url = new URL(request.url, 'http://localhost')
      const refId = url.searchParams.get('refId')
      const branchId = url.searchParams.get('branch')

      if (!refId) {
        throw new ValidationError('refId query parameter is required')
      }

      await CrossDesignReferenceService.removeReference(
        refId,
        branchId,
        user.id,
      )

      return { success: true }
    }),
  ),
)

// GET /api/designs/:id/ecos
app.get(
  '/:id/ecos',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      // Parse query params - use a base URL for relative paths
      const url = new URL(request.url, 'http://localhost')
      const statusFilter = url.searchParams.get('status')

      // Get all branches for this design
      const allBranches = await db
        .select()
        .from(branches)
        .where(eq(branches.designId, params.id))

      // Filter to ECO branches and get their change order item IDs
      const ecoItemIds = allBranches
        .filter((b) => b.branchType === 'eco')
        .map((b) => b.changeOrderItemId)
        .filter((id): id is string => id !== null)

      if (ecoItemIds.length === 0) {
        return { ecos: [], total: 0 }
      }

      // Get ECO items
      let ecoItems = await db
        .select()
        .from(items)
        .where(inArray(items.id, ecoItemIds))

      // Apply status filter if provided
      if (statusFilter) {
        ecoItems = ecoItems.filter((item) => item.state === statusFilter)
      }

      if (ecoItems.length === 0) {
        return { ecos: [], total: 0 }
      }

      const ecoIds = ecoItems.map((e) => e.id)

      // Get change order details
      const ecoDetails = await db
        .select()
        .from(changeOrders)
        .where(inArray(changeOrders.itemId, ecoIds))

      const detailsMap = new Map(ecoDetails.map((d) => [d.itemId, d]))

      // Get affected item counts
      const affectedCounts = await db
        .select({
          changeOrderId: changeOrderAffectedItems.changeOrderId,
          count: sql<number>`count(*)::int`,
        })
        .from(changeOrderAffectedItems)
        .where(inArray(changeOrderAffectedItems.changeOrderId, ecoIds))
        .groupBy(changeOrderAffectedItems.changeOrderId)

      const countMap = new Map(
        affectedCounts.map((c) => [c.changeOrderId, c.count]),
      )

      // Get owner info
      const ownerIds = ecoItems
        .map((e) => e.createdBy)
        .filter((id): id is string => !!id)
      const uniqueOwnerIds = [...new Set(ownerIds)]

      const ownersResult =
        uniqueOwnerIds.length > 0
          ? await db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, uniqueOwnerIds))
          : []

      const ownerMap = new Map(
        ownersResult.map((o) => [
          o.id,
          { id: o.id, name: o.name ?? 'Unknown' },
        ]),
      )

      // Build response
      const ecos: Array<ECOSummary> = ecoItems.map((eco) => {
        const details = detailsMap.get(eco.id)
        return {
          id: eco.id,
          itemNumber: eco.itemNumber,
          name: eco.name ?? '',
          state: eco.state,
          reasonForChange: details?.reasonForChange ?? '',
          itemCount: countMap.get(eco.id) ?? 0,
          owner: ownerMap.get(eco.createdBy || '') || {
            id: '',
            name: 'Unknown',
          },
          createdAt: eco.createdAt.toISOString(),
          submittedAt: details?.submittedAt?.toISOString(),
        }
      })

      return { ecos, total: ecos.length }
    }),
  ),
)

// GET /api/designs/:id/history/graph
app.get(
  '/:id/history/graph',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      // Check access via design access control (handles Global Admin bypass)
      await requireDesignAccess(user.id, design.id)

      // Parse query params
      const url = new URL(request.url, 'http://localhost')
      const selectedBranchId = url.searchParams.get('branchId')
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)

      // Build the graph data
      const graphData = await buildCommitGraph(
        params.id,
        selectedBranchId,
        limit,
      )

      return graphData
    }),
  ),
)

// GET /api/designs/:id/items
app.get(
  '/:id/items',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      // Parse query params
      const url = new URL(request.url, 'http://localhost')
      const search = url.searchParams.get('search')
      const type = url.searchParams.get('type')
      const stateFilter = url.searchParams.get('state')
      const limit = parseInt(url.searchParams.get('limit') || '100', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)

      // Parse version context params
      const tagId = url.searchParams.get('tag')
      const commitId = url.searchParams.get('commit')
      // Note: branch param available via url.searchParams.get('branch') for future use

      // Check if this is a historical view (tag or commit)
      const isHistoricalView = tagId || commitId

      let result: Array<Item> = []
      let total = 0

      if (isHistoricalView) {
        // Use VersionResolver for historical views
        const context = tagId
          ? { type: 'tag' as const, tagId }
          : { type: 'commit' as const, commitId: commitId! }

        const historicalResult = await VersionResolver.getItemsAtContext(
          params.id,
          context,
          {
            itemType: type || undefined,
            state: stateFilter || undefined,
            search: search || undefined,
            limit,
            offset,
          },
        )

        result = historicalResult.items.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          modifiedAt: item.modifiedAt.toISOString(),
        }))

        total = historicalResult.total
      } else {
        // Build query conditions for current/branch view
        const conditions = [
          eq(items.designId, params.id),
          eq(items.isCurrent, true),
        ]

        if (type) {
          conditions.push(eq(items.itemType, type))
        }

        if (stateFilter) {
          conditions.push(eq(items.state, stateFilter))
        }

        if (search) {
          conditions.push(
            or(
              like(items.itemNumber, `%${search}%`),
              like(items.name, `%${search}%`),
            )!,
          )
        }

        // Get total count
        const countResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(items)
          .where(and(...conditions))

        total = Number(countResult[0]?.count || 0)

        // Get items
        const itemList = await db
          .select({
            id: items.id,
            itemNumber: items.itemNumber,
            name: items.name,
            revision: items.revision,
            state: items.state,
            itemType: items.itemType,
            modifiedAt: items.modifiedAt,
          })
          .from(items)
          .where(and(...conditions))
          .orderBy(asc(items.itemNumber))
          .limit(limit)
          .offset(offset)

        result = itemList.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          modifiedAt: item.modifiedAt.toISOString(),
        }))
      }

      return { items: result, total }
    }),
  ),
)

// POST /api/designs/:id/items
app.post(
  '/:id/items',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      const body = await request.json()
      const {
        itemId,
        suffixItemNumber,
        mode = 'usage_copy',
        branchId: bodyBranchId,
      } = body

      if (!itemId) {
        throw new ValidationError('itemId is required')
      }

      // Verify the root item exists
      const rootItem = await ItemService.findById(itemId)
      if (!rootItem) {
        throw new NotFoundError('Item', itemId)
      }

      // Cross-design reference mode: create a lightweight link instead of copying
      if (mode === 'cross_design_ref') {
        const ref = await CrossDesignReferenceService.createReference(
          {
            referencingDesignId: params.id,
            referencedItemId: itemId,
            branchId: bodyBranchId || null,
          },
          user.id,
        )
        return {
          reference: {
            id: ref.id,
            referencedItemId: ref.referencedItemId,
            sourceDesignId: ref.sourceDesignId,
          },
        }
      }

      // Usage-copy mode (default): duplicate item and BOM subtree

      // Check if a usage of the root item already exists in this design
      const existingRootUsages = await UsageService.getUsagesOfDefinition(
        itemId,
        { designId: params.id },
      )
      if (existingRootUsages.length > 0) {
        throw new ValidationError(
          `A usage of ${rootItem.itemNumber} already exists in this design`,
        )
      }

      // =====================================================================
      // Step 1: Collect BOM subtree via BFS
      // =====================================================================
      const visited = new Set<string>()
      const queue: Array<string> = [itemId]
      const subtreeItemIds: Array<string> = []
      const bomRelationships: Array<typeof itemRelationships.$inferSelect> = []

      while (queue.length > 0) {
        const currentId = queue.shift()!
        if (visited.has(currentId)) continue
        visited.add(currentId)
        subtreeItemIds.push(currentId)

        // Get BOM children of this item
        const childRels = await db
          .select()
          .from(itemRelationships)
          .where(
            and(
              eq(itemRelationships.sourceId, currentId),
              eq(itemRelationships.relationshipType, 'BOM'),
            ),
          )

        for (const rel of childRels) {
          bomRelationships.push(rel)
          if (!visited.has(rel.targetId)) {
            queue.push(rel.targetId)
          }
        }
      }

      // Load full item records for all subtree items
      const subtreeItems =
        subtreeItemIds.length > 0
          ? await db
              .select()
              .from(items)
              .where(inArray(items.id, subtreeItemIds))
          : []

      // Validate suffixed item numbers won't exceed column length
      if (suffixItemNumber && design.code) {
        const suffix = `-${design.code}`
        const tooLong = subtreeItems.filter(
          (item) => item.itemNumber.length + suffix.length > 100,
        )
        if (tooLong.length > 0) {
          throw new ValidationError(
            `${tooLong.length} item number(s) would exceed 100 characters when suffixed (e.g., "${tooLong[0].itemNumber}${suffix}")`,
          )
        }
      }

      // =====================================================================
      // Step 2: Create usages in a transaction
      // =====================================================================
      const txResult = await db.transaction(async (tx) => {
        // When a branchId is provided (ECO branch), use it directly;
        // otherwise fall back to the design's main branch
        let trackingBranchId: string
        let isEcoBranch = false

        if (bodyBranchId) {
          trackingBranchId = bodyBranchId
          isEcoBranch = true
        } else {
          const targetMainBranch = await BranchService.getMainBranch(params.id)
          if (!targetMainBranch) {
            throw new ValidationError('Target design has no main branch')
          }
          trackingBranchId = targetMainBranch.id
        }

        const itemIdMap = new Map<string, string>() // sourceItemId -> newUsageId
        const createdUsages: Array<typeof items.$inferSelect> = []

        for (const sourceItem of subtreeItems) {
          // Check if a usage of this item already exists in the target design
          // (for subtree children that may already be present)
          const existingUsages = await UsageService.getUsagesOfDefinition(
            sourceItem.id,
            {
              designId: params.id,
            },
          )

          if (existingUsages.length > 0) {
            // Already exists — use the existing usage ID for relationship remapping
            itemIdMap.set(sourceItem.id, existingUsages[0].id)
            continue
          }

          // Compute overrides
          const overrides: { itemNumber?: string } = {}
          if (suffixItemNumber && design.code) {
            overrides.itemNumber = `${sourceItem.itemNumber}-${design.code}`
          }

          // Create usage
          const usageResult = await UsageService.createUsage(
            {
              definitionId: sourceItem.id,
              targetDesignId: params.id,
              ...(overrides.itemNumber ? { overrides } : {}),
            },
            user.id,
            tx,
          )

          itemIdMap.set(sourceItem.id, usageResult.usage.id)
          createdUsages.push(usageResult.usage)

          // Track on the appropriate branch
          await tx.insert(branchItems).values({
            branchId: trackingBranchId,
            itemMasterId: usageResult.usage.masterId,
            currentItemId: usageResult.usage.id,
            baseItemId: usageResult.usage.id,
            changeType: isEcoBranch ? 'added' : null,
          })
        }

        // ===================================================================
        // Step 3: Copy BOM relationships with remapped IDs
        // ===================================================================
        let relationshipsCreated = 0

        for (const rel of bomRelationships) {
          const newSourceId = itemIdMap.get(rel.sourceId)
          const newTargetId = itemIdMap.get(rel.targetId)

          if (newSourceId && newTargetId) {
            // Both ends are in the subtree — remap to new usage IDs
            await tx.insert(itemRelationships).values({
              sourceId: newSourceId,
              targetId: newTargetId,
              relationshipType: rel.relationshipType,
              quantity: rel.quantity,
              findNumber: rel.findNumber,
              referenceDesignator: rel.referenceDesignator,
              metadata: rel.metadata,
              isComposite: rel.isComposite,
              isDirected: rel.isDirected,
              multiplicityLower: rel.multiplicityLower,
              multiplicityUpper: rel.multiplicityUpper,
              usageAttributes: rel.usageAttributes,
              createdBy: user.id,
              modifiedBy: user.id,
            })
            relationshipsCreated++
          } else if (newSourceId && !newTargetId) {
            // Target is external (e.g., library item) — preserve reference
            await tx.insert(itemRelationships).values({
              sourceId: newSourceId,
              targetId: rel.targetId,
              relationshipType: rel.relationshipType,
              quantity: rel.quantity,
              findNumber: rel.findNumber,
              referenceDesignator: rel.referenceDesignator,
              metadata: rel.metadata,
              isComposite: rel.isComposite,
              isDirected: rel.isDirected,
              multiplicityLower: rel.multiplicityLower,
              multiplicityUpper: rel.multiplicityUpper,
              usageAttributes: rel.usageAttributes,
              createdBy: user.id,
              modifiedBy: user.id,
            })
            relationshipsCreated++
          }
        }

        return { items: createdUsages, relationshipsCreated }
      })

      return {
        items: txResult.items,
        relationshipsCreated: txResult.relationshipsCreated,
      }
    }),
  ),
)

// DELETE /api/designs/:id/items
app.delete(
  '/:id/items',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      // Get item ID from query params
      const url = new URL(request.url, 'http://localhost')
      const itemId = url.searchParams.get('itemId')

      if (!itemId) {
        throw new ValidationError('itemId query parameter is required')
      }

      // Verify the item exists and belongs to this design
      const item = await ItemService.findById(itemId)
      if (!item) {
        throw new NotFoundError('Item', itemId)
      }

      if (item.designId !== params.id) {
        throw new ValidationError('Item does not belong to this design')
      }

      // Remove from structure by setting inDesignStructure = false
      // The item remains in the design but moves to the orphan list
      await db
        .update(items)
        .set({
          inDesignStructure: false,
          modifiedBy: user.id,
          modifiedAt: new Date(),
        })
        .where(eq(items.id, itemId))

      return { success: true }
    }),
  ),
)

// PATCH /api/designs/:id/items
app.patch(
  '/:id/items',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      // Get item ID from request body
      const body = await request.json()
      const { itemId } = body

      if (!itemId) {
        throw new ValidationError('itemId is required')
      }

      // Verify the item exists and belongs to this design
      const item = await ItemService.findById(itemId)
      if (!item) {
        throw new NotFoundError('Item', itemId)
      }

      if (item.designId !== params.id) {
        throw new ValidationError('Item does not belong to this design')
      }

      // Add back to structure by setting inDesignStructure = true
      await db
        .update(items)
        .set({
          inDesignStructure: true,
          modifiedBy: user.id,
          modifiedAt: new Date(),
        })
        .where(eq(items.id, itemId))

      return { success: true }
    }),
  ),
)

// GET /api/designs/:id/members
app.get(
  '/:id/members',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      // Only family designs can have members
      if (design.designType !== 'Family') {
        throw new ValidationError('Only family designs can have members')
      }

      await requireDesignAccess(user.id, params.id)

      const members = await DesignService.getMembers(params.id)

      return { members }
    }),
  ),
)

// POST /api/designs/:id/members
app.post(
  '/:id/members',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const familyDesign = await DesignService.getById(params.id)
      if (!familyDesign) {
        throw new NotFoundError('Design', params.id)
      }

      // Only family designs can have members
      if (familyDesign.designType !== 'Family') {
        throw new ValidationError('Only family designs can have members')
      }

      // Check permission
      if (familyDesign.programId) {
        const member = await ProgramService.getMember(
          familyDesign.programId,
          user.id,
        )
        if (!member || !member.canManageProducts) {
          await requirePermission(request, 'designs', 'update')
        }
      } else {
        await requirePermission(request, 'designs', 'update')
      }

      const { designId } = await request.json()

      if (!designId) {
        throw new ValidationError('designId is required', undefined, {
          field: 'designId',
        })
      }

      // Verify the design to be added exists and is in the same program
      const designToAdd = await DesignService.getById(designId)
      if (!designToAdd) {
        throw new ValidationError('Design not found', undefined, {
          field: 'designId',
        })
      }

      // Use setParent which handles validation
      const updated = await DesignService.setParent(
        designId,
        params.id,
        user.id,
      )

      return { design: updated }
    }),
  ),
)

// DELETE /api/designs/:id/members
app.delete(
  '/:id/members',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const familyDesign = await DesignService.getById(params.id)
      if (!familyDesign) {
        throw new NotFoundError('Design', params.id)
      }

      // Check permission
      if (familyDesign.programId) {
        const member = await ProgramService.getMember(
          familyDesign.programId,
          user.id,
        )
        if (!member || !member.canManageProducts) {
          await requirePermission(request, 'designs', 'update')
        }
      } else {
        await requirePermission(request, 'designs', 'update')
      }

      // Get designId from query params or body
      const url = new URL(request.url, 'http://localhost')
      const designId = url.searchParams.get('designId')

      if (!designId) {
        throw new ValidationError(
          'designId query parameter is required',
          undefined,
          { field: 'designId' },
        )
      }

      // Verify the design exists and is a child of this family
      const childDesign = await DesignService.getById(designId)
      if (!childDesign) {
        throw new ValidationError('Design not found', undefined, {
          field: 'designId',
        })
      }

      if (childDesign.parentDesignId !== params.id) {
        throw new ValidationError(
          'Design is not a member of this family',
          undefined,
          {
            field: 'designId',
          },
        )
      }

      // Remove from family
      await DesignService.removeFromFamily(designId, user.id)

      return new Response(null, { status: 204 })
    }),
  ),
)

// GET /api/designs/:id/status
app.get(
  '/:id/status',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      // Get protection status
      const protection = await DesignService.getProtectionStatus(params.id)

      // Get available branch types based on protection
      const branchOptions = await BranchService.getAvailableBranchTypes(
        params.id,
      )

      return {
        protection,
        branchOptions,
      }
    }),
  ),
)

// GET /api/designs/:id/structure
app.get(
  '/:id/structure',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      // Parse version context from query params
      const url = new URL(request.url, 'http://localhost')
      const branchId = url.searchParams.get('branch')
      const tagId = url.searchParams.get('tag')
      const commitId = url.searchParams.get('commit')
      const expandExternal = url.searchParams.get('expandExternal') !== 'false' // default true

      // Get main branch for this design
      const mainBranch = await BranchService.getMainBranch(params.id)

      // Check if this is a historical view (tag or commit)
      // For historical views, use VersionResolver to get items at that point in time
      const isHistoricalView = tagId || commitId

      // Get items via branchItems to respect version context
      // For ECO branches, we need to merge ECO changes with main branch items
      let allItems: Array<{
        id: string
        itemNumber: string
        name: string | null
        revision: string
        state: string
        itemType: string
        inDesignStructure: boolean | null
        designId: string | null
        masterId: string
      }> = []

      // For ECO branches, we need to track main branch item IDs for relationship queries
      // and build a masterId -> resolvedItemId mapping for resolving relationships
      let mainBranchItemIds: Array<string> = []
      const masterIdToResolvedItemId = new Map<string, string>()
      // Map from main branch itemId -> masterId (for resolving relationships)
      const mainItemIdToMasterId = new Map<string, string>()

      // Handle historical views (tag or commit) using VersionResolver
      if (isHistoricalView) {
        const context = tagId
          ? { type: 'tag' as const, tagId }
          : { type: 'commit' as const, commitId: commitId! }

        const historicalResult = await VersionResolver.getItemsAtContext(
          params.id,
          context,
        )

        allItems = historicalResult.items.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          inDesignStructure: item.inDesignStructure,
          designId: item.designId,
          masterId: item.masterId,
        }))

        // Build masterId mappings for historical items so relationships can be resolved
        // BOM relationships are stored with main branch item IDs, so we need to:
        // 1. Get main branch item IDs for relationship queries
        // 2. Map masterId -> historical item ID for resolution
        if (mainBranch) {
          const mainBranchItemsResult = await db
            .select({
              currentItemId: branchItems.currentItemId,
              itemMasterId: branchItems.itemMasterId,
            })
            .from(branchItems)
            .where(eq(branchItems.branchId, mainBranch.id))

          mainBranchItemIds = mainBranchItemsResult
            .map((bi) => bi.currentItemId)
            .filter((id): id is string => id !== null)

          // Build mappings: main branch itemId -> masterId, masterId -> historical itemId
          for (const bi of mainBranchItemsResult) {
            if (bi.currentItemId && bi.itemMasterId) {
              mainItemIdToMasterId.set(bi.currentItemId, bi.itemMasterId)
            }
          }
          for (const item of allItems) {
            masterIdToResolvedItemId.set(item.masterId, item.id)
          }
        }
      } else {
        // Determine which branch to use for filtering
        // Default to main branch if no context specified
        let targetBranchId = branchId
        if (!targetBranchId && mainBranch) {
          targetBranchId = mainBranch.id
        }

        if (targetBranchId) {
          // Check if this is an ECO branch (not main)
          const isEcoBranch = mainBranch && targetBranchId !== mainBranch.id

          if (isEcoBranch) {
            // For ECO branches: merge ECO changes on top of main branch
            // 1. Get all items from main branch
            const mainBranchItemsResult = await db
              .select({
                currentItemId: branchItems.currentItemId,
                itemMasterId: branchItems.itemMasterId,
              })
              .from(branchItems)
              .where(eq(branchItems.branchId, mainBranch.id))

            // 2. Get items specific to this ECO branch (working copies)
            const ecoBranchItemsResult = await db
              .select({
                currentItemId: branchItems.currentItemId,
                itemMasterId: branchItems.itemMasterId,
              })
              .from(branchItems)
              .where(eq(branchItems.branchId, targetBranchId))

            // 3. Build a map of masterId -> itemId, preferring ECO versions
            // Also track main branch item IDs for relationship queries
            mainBranchItemIds = mainBranchItemsResult
              .map((bi) => bi.currentItemId)
              .filter((id): id is string => id !== null)

            // First add all main branch items to the resolution map
            // Also build mainItemIdToMasterId for resolving relationships
            for (const bi of mainBranchItemsResult) {
              if (bi.currentItemId && bi.itemMasterId) {
                masterIdToResolvedItemId.set(bi.itemMasterId, bi.currentItemId)
                mainItemIdToMasterId.set(bi.currentItemId, bi.itemMasterId)
              }
            }

            // Then override with ECO branch items (these take precedence)
            for (const bi of ecoBranchItemsResult) {
              if (bi.currentItemId && bi.itemMasterId) {
                masterIdToResolvedItemId.set(bi.itemMasterId, bi.currentItemId)
              }
            }

            // 4. Fetch all resolved items
            const resolvedItemIds = Array.from(
              masterIdToResolvedItemId.values(),
            )
            if (resolvedItemIds.length > 0) {
              allItems = await db
                .select({
                  id: items.id,
                  itemNumber: items.itemNumber,
                  name: items.name,
                  revision: items.revision,
                  state: items.state,
                  itemType: items.itemType,
                  inDesignStructure: items.inDesignStructure,
                  designId: items.designId,
                  masterId: items.masterId,
                })
                .from(items)
                .where(inArray(items.id, resolvedItemIds))
            }
          } else {
            // For main branch or non-ECO branches: get branch items and build mappings
            const branchItemsResult = await db
              .select({
                currentItemId: branchItems.currentItemId,
                itemMasterId: branchItems.itemMasterId,
              })
              .from(branchItems)
              .where(eq(branchItems.branchId, targetBranchId))

            const currentItemIds = branchItemsResult
              .map((bi) => bi.currentItemId)
              .filter((id): id is string => id !== null)

            // Build masterId mappings for relationship resolution
            mainBranchItemIds = currentItemIds
            for (const bi of branchItemsResult) {
              if (bi.currentItemId && bi.itemMasterId) {
                masterIdToResolvedItemId.set(bi.itemMasterId, bi.currentItemId)
                mainItemIdToMasterId.set(bi.currentItemId, bi.itemMasterId)
              }
            }

            if (currentItemIds.length > 0) {
              allItems = await db
                .select({
                  id: items.id,
                  itemNumber: items.itemNumber,
                  name: items.name,
                  revision: items.revision,
                  state: items.state,
                  itemType: items.itemType,
                  inDesignStructure: items.inDesignStructure,
                  designId: items.designId,
                  masterId: items.masterId,
                })
                .from(items)
                .where(inArray(items.id, currentItemIds))
            } else {
              // Fallback: branchItems is empty, use isCurrent items for the design
              // This handles legacy data or items not yet tracked in branchItems
              allItems = await db
                .select({
                  id: items.id,
                  itemNumber: items.itemNumber,
                  name: items.name,
                  revision: items.revision,
                  state: items.state,
                  itemType: items.itemType,
                  inDesignStructure: items.inDesignStructure,
                  designId: items.designId,
                  masterId: items.masterId,
                })
                .from(items)
                .where(
                  and(eq(items.designId, params.id), eq(items.isCurrent, true)),
                )

              // Build masterId mappings for these items
              for (const item of allItems) {
                masterIdToResolvedItemId.set(item.masterId, item.id)
                mainItemIdToMasterId.set(item.id, item.masterId)
              }
              mainBranchItemIds = allItems.map((i) => i.id)
            }
          }
        } else {
          // Fallback: get isCurrent items for the design (legacy behavior)
          allItems = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              masterId: items.masterId,
            })
            .from(items)
            .where(
              and(eq(items.designId, params.id), eq(items.isCurrent, true)),
            )
        }
      } // end else (!isHistoricalView)

      // Get all BOM relationships where source is in this design
      // If expandExternal=true, target can be from any design (cross-design references)
      const itemIds = allItems.map((i) => i.id)

      // Build a reverse map from itemId -> masterId for all items
      const itemIdToMasterId = new Map<string, string>()
      for (const item of allItems) {
        itemIdToMasterId.set(item.id, item.masterId)
      }

      // For historical views and ECO branches, relationships might be stored with
      // different item version IDs. We need to find all item versions that share
      // masterIds with our items, then query relationships using those IDs.
      const masterIds = allItems.map((i) => i.masterId)

      // Get ALL item versions that share these masterIds (to find relationships)
      const allVersionsWithMasterIds =
        masterIds.length > 0
          ? await db
              .select({ id: items.id, masterId: items.masterId })
              .from(items)
              .where(inArray(items.masterId, masterIds))
          : []

      // Build comprehensive ID lists for relationship queries
      const allItemIdsForRelationships = allVersionsWithMasterIds.map(
        (i) => i.id,
      )

      // Also add main branch IDs if available
      const relationshipQueryIds = [
        ...new Set([
          ...allItemIdsForRelationships,
          ...mainBranchItemIds,
          ...itemIds,
        ]),
      ]

      // Build masterId lookup for all item versions (for relationship resolution)
      for (const item of allVersionsWithMasterIds) {
        if (!mainItemIdToMasterId.has(item.id)) {
          mainItemIdToMasterId.set(item.id, item.masterId)
        }
      }

      let relationships =
        relationshipQueryIds.length > 0
          ? await db
              .select()
              .from(itemRelationships)
              .where(
                and(
                  inArray(itemRelationships.sourceId, relationshipQueryIds),
                  // Only filter targetId if NOT expanding external (legacy behavior)
                  ...(expandExternal
                    ? []
                    : [
                        inArray(
                          itemRelationships.targetId,
                          relationshipQueryIds,
                        ),
                      ]),
                  eq(itemRelationships.relationshipType, 'BOM'),
                ),
              )
          : []

      // Find external target IDs (items from other designs)
      const externalTargetIds = relationships
        .map((r) => r.targetId)
        .filter((id) => !itemIds.includes(id))

      // Fetch external items with their design info
      let externalItems =
        externalTargetIds.length > 0
          ? await db
              .select({
                id: items.id,
                itemNumber: items.itemNumber,
                name: items.name,
                revision: items.revision,
                state: items.state,
                itemType: items.itemType,
                inDesignStructure: items.inDesignStructure,
                designId: items.designId,
                designCode: designs.code,
                designName: designs.name,
              })
              .from(items)
              .leftJoin(designs, eq(items.designId, designs.id))
              .where(inArray(items.id, externalTargetIds))
          : []

      // Recursively expand external items' children (for cross-design BOM traversal)
      // This allows viewing the full tree when parts reference items from other designs
      if (expandExternal && externalItems.length > 0) {
        const allExternalItemIds = new Set(externalItems.map((i) => i.id))
        const allExternalItems = [...externalItems]
        let currentExternalIds = [...externalTargetIds]
        const maxDepth = 10 // Prevent infinite loops
        let depth = 0

        while (currentExternalIds.length > 0 && depth < maxDepth) {
          depth++

          // Fetch BOM relationships where source is one of the current external items
          const externalRelationships = await db
            .select()
            .from(itemRelationships)
            .where(
              and(
                inArray(itemRelationships.sourceId, currentExternalIds),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          if (externalRelationships.length === 0) break

          // Add these relationships to the main list
          relationships = [...relationships, ...externalRelationships]

          // Find new external targets we haven't seen yet
          const newExternalTargetIds = externalRelationships
            .map((r) => r.targetId)
            .filter(
              (id) => !itemIds.includes(id) && !allExternalItemIds.has(id),
            )

          if (newExternalTargetIds.length === 0) break

          // Fetch these new external items
          const newExternalItems = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              designCode: designs.code,
              designName: designs.name,
            })
            .from(items)
            .leftJoin(designs, eq(items.designId, designs.id))
            .where(inArray(items.id, newExternalTargetIds))

          // Add to our collections
          for (const item of newExternalItems) {
            allExternalItemIds.add(item.id)
            allExternalItems.push(item)
          }

          // Continue with these new external items in the next iteration
          currentExternalIds = newExternalTargetIds
        }

        // Update externalItems with all discovered external items
        externalItems = allExternalItems
      }

      // Build design map for external items
      const externalDesignMap = new Map(
        externalItems.map((item) => [
          item.id,
          { code: item.designCode, name: item.designName },
        ]),
      )

      // Build a map of children for each item
      // For ECO branches, we need to resolve relationship IDs through masterId mapping
      const childrenMap = new Map<
        string,
        Array<{
          childId: string
          relationshipId: string
          quantity?: number
          findNumber?: number
        }>
      >()
      const hasParent = new Set<string>()

      // Helper to resolve an item ID to the correct version (main or ECO working copy)
      const resolveItemId = (itemId: string): string => {
        // If we're viewing an ECO branch, resolve through masterId
        if (mainItemIdToMasterId.size > 0) {
          const masterId = mainItemIdToMasterId.get(itemId)
          if (masterId) {
            const resolvedId = masterIdToResolvedItemId.get(masterId)
            if (resolvedId) return resolvedId
          }
        }
        // Otherwise return the original ID
        return itemId
      }

      // Track which source-target pairs we've already added to avoid duplicates
      // (same relationship can exist across multiple item versions)
      const addedRelationships = new Set<string>()

      for (const rel of relationships) {
        const resolvedSourceId = resolveItemId(rel.sourceId)
        const resolvedTargetId = resolveItemId(rel.targetId)

        // Deduplicate by resolved source-target pair
        const relKey = `${resolvedSourceId}:${resolvedTargetId}`
        if (addedRelationships.has(relKey)) continue
        addedRelationships.add(relKey)

        if (!childrenMap.has(resolvedSourceId)) {
          childrenMap.set(resolvedSourceId, [])
        }
        childrenMap.get(resolvedSourceId)!.push({
          childId: resolvedTargetId,
          relationshipId: rel.id,
          quantity: rel.quantity ? Number(rel.quantity) : undefined,
          findNumber: rel.findNumber ?? undefined,
        })
        hasParent.add(resolvedTargetId)
      }

      // Create item lookup map (includes both local and external items)
      const itemMap = new Map([
        ...allItems.map(
          (i) =>
            [
              i.id,
              {
                ...i,
                designCode: undefined as string | undefined,
                designName: undefined as string | undefined,
              },
            ] as const,
        ),
        ...externalItems.map(
          (i) =>
            [
              i.id,
              {
                ...i,
                designCode: i.designCode ?? undefined,
                designName: i.designName ?? undefined,
              },
            ] as const,
        ),
      ])

      // Build tree nodes recursively
      const buildNode = (
        itemId: string,
        visitedSet: Set<string>,
      ): BOMTreeNode | null => {
        if (visitedSet.has(itemId)) return null // Prevent cycles
        const item = itemMap.get(itemId)
        if (!item) return null

        visitedSet.add(itemId)

        // Check if this is an external item (from a different design)
        const isExternal = item.designId !== params.id
        const designInfo = isExternal ? externalDesignMap.get(itemId) : null

        const children = childrenMap.get(itemId) || []
        const childNodes = children
          .map((c) => {
            const node = buildNode(c.childId, new Set(visitedSet))
            if (node) {
              node.quantity = c.quantity
              node.findNumber = c.findNumber
              node.relationshipId = c.relationshipId
            }
            return node
          })
          .filter((n): n is BOMTreeNode => n !== null)

        return {
          itemId: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
          children: childNodes.length > 0 ? childNodes : undefined,
          // Cross-design reference fields
          designId: item.designId,
          designCode: designInfo?.code ?? (item as any).designCode ?? undefined,
          designName: designInfo?.name ?? (item as any).designName ?? undefined,
          isExternal,
        }
      }

      // =====================================================================
      // Cross-design references: fetch and add as additional root items
      // =====================================================================
      const crossRefs =
        await CrossDesignReferenceService.getReferencesForDesign(
          params.id,
          branchId,
        )

      // Build a set of cross-ref item IDs and a map of itemId -> crossRefId
      const crossRefItemIds = new Set<string>()
      const crossRefIdMap = new Map<string, string>() // referencedItemId -> crossRef.id

      for (const ref of crossRefs) {
        if (ref.inDesignStructure !== false) {
          crossRefItemIds.add(ref.referencedItemId)
          crossRefIdMap.set(ref.referencedItemId, ref.id)
        }
      }

      // Fetch cross-referenced items with design info (if any exist)
      if (crossRefItemIds.size > 0) {
        // Resolve cross-ref items to their latest released version
        // (XREFs store specific item version IDs which may become stale)
        const resolvedCrossRefItems =
          await VersionResolver.resolveRelationshipTargets(
            Array.from(crossRefItemIds),
            { type: 'released', designId: params.id },
          )

        // Rebuild crossRefItemIds and crossRefIdMap with resolved IDs
        const originalCrossRefIdMap = new Map(crossRefIdMap)
        crossRefItemIds.clear()
        crossRefIdMap.clear()
        for (const [originalId, resolvedItem] of resolvedCrossRefItems) {
          crossRefItemIds.add(resolvedItem.id)
          const crossRefId = originalCrossRefIdMap.get(originalId)
          if (crossRefId) {
            crossRefIdMap.set(resolvedItem.id, crossRefId)
          }
        }

        // Fetch resolved items with design info
        const resolvedItemIds = Array.from(crossRefItemIds)
        if (resolvedItemIds.length > 0) {
          const crossRefItems = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              masterId: items.masterId,
              designCode: designs.code,
              designName: designs.name,
            })
            .from(items)
            .leftJoin(designs, eq(items.designId, designs.id))
            .where(inArray(items.id, resolvedItemIds))

          // Add to itemMap and externalDesignMap
          for (const item of crossRefItems) {
            itemMap.set(item.id, {
              ...item,
              designCode: item.designCode ?? undefined,
              designName: item.designName ?? undefined,
            })
            if (item.designCode || item.designName) {
              externalDesignMap.set(item.id, {
                code: item.designCode,
                name: item.designName,
              })
            }
          }
        }

        // Fetch BOM children of cross-referenced items for subtree expansion
        let crossRefCurrentIds = Array.from(crossRefItemIds)
        const allCrossRefExternalIds = new Set(crossRefItemIds)
        let depth = 0
        const maxCrossRefDepth = 10

        while (crossRefCurrentIds.length > 0 && depth < maxCrossRefDepth) {
          depth++

          const childRels = await db
            .select()
            .from(itemRelationships)
            .where(
              and(
                inArray(itemRelationships.sourceId, crossRefCurrentIds),
                eq(itemRelationships.relationshipType, 'BOM'),
              ),
            )

          if (childRels.length === 0) break

          // Add relationships
          for (const rel of childRels) {
            const relKey = `${rel.sourceId}:${rel.targetId}`
            if (!addedRelationships.has(relKey)) {
              addedRelationships.add(relKey)
              if (!childrenMap.has(rel.sourceId)) {
                childrenMap.set(rel.sourceId, [])
              }
              childrenMap.get(rel.sourceId)!.push({
                childId: rel.targetId,
                relationshipId: rel.id,
                quantity: rel.quantity ? Number(rel.quantity) : undefined,
                findNumber: rel.findNumber ?? undefined,
              })
              hasParent.add(rel.targetId)
            }
          }

          // Find new external targets
          const newTargetIds = childRels
            .map((r) => r.targetId)
            .filter(
              (id) => !itemIds.includes(id) && !allCrossRefExternalIds.has(id),
            )

          if (newTargetIds.length === 0) break

          const newItems = await db
            .select({
              id: items.id,
              itemNumber: items.itemNumber,
              name: items.name,
              revision: items.revision,
              state: items.state,
              itemType: items.itemType,
              inDesignStructure: items.inDesignStructure,
              designId: items.designId,
              masterId: items.masterId,
              designCode: designs.code,
              designName: designs.name,
            })
            .from(items)
            .leftJoin(designs, eq(items.designId, designs.id))
            .where(inArray(items.id, newTargetIds))

          for (const item of newItems) {
            allCrossRefExternalIds.add(item.id)
            itemMap.set(item.id, {
              ...item,
              designCode: item.designCode ?? undefined,
              designName: item.designName ?? undefined,
            })
            if (item.designCode || item.designName) {
              externalDesignMap.set(item.id, {
                code: item.designCode,
                name: item.designName,
              })
            }
          }

          crossRefCurrentIds = newTargetIds
        }
      }

      // Find root items: Parts with inDesignStructure=true and no parent
      const roots: Array<BOMTreeNode> = []
      for (const item of allItems) {
        // Root items are Parts that are marked as in-structure and have no parent BOM relationship
        if (
          !hasParent.has(item.id) &&
          item.itemType === 'Part' &&
          item.inDesignStructure !== false
        ) {
          const node = buildNode(item.id, new Set())
          if (node) {
            roots.push(node)
          }
        }
      }

      // Add cross-design references as roots
      for (const refItemId of crossRefItemIds) {
        const node = buildNode(refItemId, new Set())
        if (node) {
          node.isCrossDesignRef = true
          node.crossReferenceId = crossRefIdMap.get(refItemId)
          roots.push(node)
        }
      }

      // Sort roots by item number
      roots.sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

      // Find orphan items: Items not in the BOM structure
      // - Parts with inDesignStructure=false (removed from structure)
      // - Documents and Requirements (never in BOM structure)
      // Note: Child parts (those with a parent) are NOT orphans - they're managed via their parent
      const orphans: Array<OrphanItem> = allItems
        .filter((item) => {
          // Non-Part items are always orphans
          if (item.itemType !== 'Part') return true
          // Parts with inDesignStructure=false are orphans
          if (item.inDesignStructure === false) return true
          // Parts that are children (have a parent) are NOT orphans
          return false
        })
        .map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          revision: item.revision,
          state: item.state,
          itemType: item.itemType,
        }))
        .sort((a, b) => a.itemNumber.localeCompare(b.itemNumber))

      return { roots, orphans }
    }),
  ),
)

// GET /api/designs/:id/tags
app.get(
  '/:id/tags',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      await requireDesignAccess(user.id, params.id)

      const tagsList = await DesignService.listTags(params.id)

      return { tags: tagsList }
    }),
  ),
)

// POST /api/designs/:id/tags
app.post(
  '/:id/tags',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Design', params.id)
      }

      // Check permission - Global Admin or program admin/lead can create tags
      if (design.programId) {
        const isGlobalAdmin = await permissionService.hasRole(
          user.id,
          'Global Admin',
        )
        if (!isGlobalAdmin) {
          const role = await ProgramService.getUserRole(
            user.id,
            design.programId,
          )
          if (role !== 'admin' && role !== 'lead') {
            throw new PermissionDeniedError('design tags', 'create')
          }
        }
      }

      const data = await request.json()
      const tag = await DesignService.createTag(params.id, data, user.id)

      return created({ tag })
    }),
  ),
)

// =============================================
// Routes with :designId parameter
// =============================================

// POST /api/designs/:designId/gap-analysis
app.post(
  '/:designId/gap-analysis',
  adapt(
    apiHandler({}, async ({ request, params }) => {
      const { designId } = params
      const body = await request.json()

      // Validate request body
      const validated = gapAnalysisRequestSchema.parse(body)

      const result = await GapAnalysisService.analyze({
        designId,
        ...validated,
      })

      return result
    }),
  ),
)

// GET /api/designs/:designId/gap-analysis
app.get(
  '/:designId/gap-analysis',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { designId } = params

      // GET request runs with default settings
      const result = await GapAnalysisService.analyze({ designId })

      return result
    }),
  ),
)

// GET /api/designs/:designId/requirements-coverage
app.get(
  '/:designId/requirements-coverage',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { designId } = params
      const coverage = await RequirementService.getCoverage(designId)

      return coverage
    }),
  ),
)

// GET /api/designs/:designId/test-coverage
app.get(
  '/:designId/test-coverage',
  adapt(
    apiHandler({}, async ({ params }) => {
      const coverage = await VerificationService.getTestCoverage(
        params.designId,
      )

      return { coverage }
    }),
  ),
)

// GET /api/designs/:designId/verification-gaps
app.get(
  '/:designId/verification-gaps',
  adapt(
    apiHandler({}, async ({ params }) => {
      const gaps = await VerificationService.getVerificationGaps(
        params.designId,
      )

      return { gaps }
    }),
  ),
)

export default app
