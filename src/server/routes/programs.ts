import { Hono } from 'hono'
import { desc, inArray } from 'drizzle-orm'
import { adapt } from '../adapter'
import type {
  CommitGraphEdge,
  CrossDesignEco,
  ProgramCommitGraphNode,
  ProgramCommitNodeData,
  ProgramGraphData,
  ProgramGraphDesign,
} from '@/lib/versioning/graph-types'
import { ProgramService } from '@/lib/services/ProgramService'
import { DesignService } from '@/lib/services/DesignService'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { requirePermission } from '@/lib/auth/server'
import { permissionService } from '@/lib/auth/permission-service'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { db } from '@/lib/db'
import { branches, commits, tags } from '@/lib/db/schema/versioning'
import { users } from '@/lib/db/schema/users'
import { changeOrderDesigns, items } from '@/lib/db/schema/items'
import { apiHandler, created } from '@/lib/api/handler'

// ============================================
// Commit Consolidation (shared from design graph)
// ============================================

const CONSOLIDATION_TIME_WINDOW_MS = 30 * 60 * 1000
const MIN_COMMITS_TO_CONSOLIDATE = 2

function isImportantCommit(data: ProgramCommitNodeData): boolean {
  if (data.isMergeCommit) return true
  if (data.changeOrderItemId || data.ecoNumber) return true
  if (data.tags && data.tags.length > 0) return true
  if (data.message === 'Initial commit') return true
  if (data.message.includes('ChangeOrder')) return true
  return false
}

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

function extractItemType(message: string): string {
  const match = message.match(
    /^(Part|Document|ChangeOrder|Requirement|Task)\s+/i,
  )
  if (match) return match[1]
  return 'Item'
}

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

function consolidateCommits(
  nodes: Array<ProgramCommitGraphNode>,
  edges: Array<CommitGraphEdge>,
): { nodes: Array<ProgramCommitGraphNode>; edges: Array<CommitGraphEdge> } {
  if (nodes.length < MIN_COMMITS_TO_CONSOLIDATE) {
    return { nodes, edges }
  }

  const sortedNodes = [...nodes].sort(
    (a, b) => new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
  )

  const consolidatedNodes: Array<ProgramCommitGraphNode> = []
  const removedNodeIds = new Set<string>()
  let i = 0

  while (i < sortedNodes.length) {
    const currentNode = sortedNodes[i]

    if (isImportantCommit(currentNode.data)) {
      consolidatedNodes.push(currentNode)
      i++
      continue
    }

    const group: Array<ProgramCommitGraphNode> = [currentNode]
    const currentAction = extractActionType(currentNode.data.message)
    const currentItemType = extractItemType(currentNode.data.message)
    const currentTime = new Date(currentNode.data.date).getTime()

    let j = i + 1
    while (j < sortedNodes.length) {
      const nextNode = sortedNodes[j]
      if (isImportantCommit(nextNode.data)) break
      if (nextNode.data.branchId !== currentNode.data.branchId) break
      if (nextNode.data.designId !== currentNode.data.designId) break
      if (nextNode.data.author.id !== currentNode.data.author.id) break
      if (extractActionType(nextNode.data.message) !== currentAction) break
      if (extractItemType(nextNode.data.message) !== currentItemType) break
      const nextTime = new Date(nextNode.data.date).getTime()
      if (nextTime - currentTime > CONSOLIDATION_TIME_WINDOW_MS) break
      group.push(nextNode)
      j++
    }

    if (group.length >= MIN_COMMITS_TO_CONSOLIDATE) {
      const firstCommit = group[0]
      const lastCommit = group[group.length - 1]
      const totalStats = group.reduce(
        (acc, n) => ({
          added: acc.added + (n.data.changeStats?.added || 0),
          modified: acc.modified + (n.data.changeStats?.modified || 0),
          deleted: acc.deleted + (n.data.changeStats?.deleted || 0),
        }),
        { added: 0, modified: 0, deleted: 0 },
      )

      const consolidatedNode: ProgramCommitGraphNode = {
        id: `consolidated-${firstCommit.id}`,
        type: 'commitNode',
        position: { x: 0, y: 0 },
        data: {
          ...firstCommit.data,
          message: generateConsolidatedMessage(
            group.length,
            currentAction,
            currentItemType,
          ),
          date: lastCommit.data.date,
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
      for (const node of group) {
        removedNodeIds.add(node.id)
      }
      i = j
    } else {
      consolidatedNodes.push(currentNode)
      i++
    }
  }

  const nodeIdMapping = new Map<string, string>()
  for (const node of consolidatedNodes) {
    if (node.data.isConsolidated && node.data.consolidatedCommitIds) {
      for (const originalId of node.data.consolidatedCommitIds) {
        nodeIdMapping.set(originalId, node.id)
      }
    }
  }

  const consolidatedEdges: Array<CommitGraphEdge> = []
  const seenEdges = new Set<string>()

  for (const edge of edges) {
    let sourceId = edge.source
    let targetId = edge.target

    if (removedNodeIds.has(sourceId) && removedNodeIds.has(targetId)) {
      const newSourceId = nodeIdMapping.get(sourceId)
      const newTargetId = nodeIdMapping.get(targetId)
      if (newSourceId === newTargetId) continue
    }

    if (nodeIdMapping.has(sourceId)) {
      sourceId = nodeIdMapping.get(sourceId)!
    }
    if (nodeIdMapping.has(targetId)) {
      targetId = nodeIdMapping.get(targetId)!
    }

    if (removedNodeIds.has(edge.source) && !nodeIdMapping.has(edge.source))
      continue
    if (removedNodeIds.has(edge.target) && !nodeIdMapping.has(edge.target))
      continue

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

async function buildProgramGraph(
  programId: string,
  program: { id: string; code: string; name: string },
  filterDesignIds: Array<string> | undefined,
  limit: number,
): Promise<ProgramGraphData> {
  // 1. Get all designs in the program
  const allDesigns = await DesignService.listByProgram(programId)

  // Filter if specific designIds requested
  const targetDesigns = filterDesignIds
    ? allDesigns.filter((d) => filterDesignIds.includes(d.id))
    : allDesigns

  if (targetDesigns.length === 0) {
    return {
      nodes: [],
      edges: [],
      ecoConnectorEdges: [],
      designs: [],
      crossDesignEcos: [],
      program: { id: program.id, code: program.code, name: program.name },
    }
  }

  // Sort by code for consistent column ordering
  const sortedDesigns = [...targetDesigns].sort((a, b) =>
    a.code.localeCompare(b.code),
  )
  const designIds = sortedDesigns.map((d) => d.id)

  // 2. Get all branches for these designs
  const allBranches = await db
    .select()
    .from(branches)
    .where(inArray(branches.designId, designIds))

  // Map branches by design
  const branchesByDesign = new Map<string, typeof allBranches>()
  for (const branch of allBranches) {
    const list = branchesByDesign.get(branch.designId) || []
    list.push(branch)
    branchesByDesign.set(branch.designId, list)
  }

  // Build design info with main branch
  const programDesigns: Array<ProgramGraphDesign> = sortedDesigns.map(
    (d, idx) => {
      const designBranches = branchesByDesign.get(d.id) || []
      const mainBranch = designBranches.find((b) => b.branchType === 'main')
      return {
        id: d.id,
        code: d.code,
        name: d.name,
        mainBranchId: mainBranch?.id || '',
        columnIndex: idx,
      }
    },
  )

  // 3. For each design, get commits (main + ECO branches)
  const allNodes: Array<ProgramCommitGraphNode> = []
  const allEdges: Array<CommitGraphEdge> = []
  const allCommitIds = new Set<string>()

  for (const design of programDesigns) {
    const designBranches = branchesByDesign.get(design.id) || []
    const mainBranch = designBranches.find((b) => b.branchType === 'main')

    if (!mainBranch) continue

    // Get branch IDs to query (main + non-archived ECO branches)
    const openEcoBranches = designBranches.filter(
      (b) => b.branchType === 'eco' && !b.isArchived,
    )
    const branchIdsToQuery = [
      mainBranch.id,
      ...openEcoBranches.map((b) => b.id),
    ]

    // Get commits for these branches
    let designCommits = await db
      .select()
      .from(commits)
      .where(inArray(commits.branchId, branchIdsToQuery))
      .orderBy(desc(commits.createdAt))
      .limit(limit * branchIdsToQuery.length) // Scale limit by number of branches

    // Also fetch commits from historical merged branches (archived ECOs)
    // Look for merge commits on main and trace back to their source branches
    const mainCommits = designCommits.filter(
      (c) => c.branchId === mainBranch.id,
    )
    const mergeCommitsOnMain = mainCommits.filter(
      (c) => c.mergeParentId !== null,
    )

    if (mergeCommitsOnMain.length > 0) {
      const mergeParentIds = mergeCommitsOnMain
        .map((c) => c.mergeParentId)
        .filter((id): id is string => id !== null)

      if (mergeParentIds.length > 0) {
        // Fetch the merge parent commits to find their branches
        const mergeParentCommits = await db
          .select()
          .from(commits)
          .where(inArray(commits.id, mergeParentIds))

        // Get unique branch IDs from merge parents (excluding main)
        const historicalBranchIds = [
          ...new Set(
            mergeParentCommits
              .map((c) => c.branchId)
              .filter((id) => id !== mainBranch.id),
          ),
        ]

        if (historicalBranchIds.length > 0) {
          // Fetch all commits from these historical branches
          const historicalCommits = await db
            .select()
            .from(commits)
            .where(inArray(commits.branchId, historicalBranchIds))
            .orderBy(desc(commits.createdAt))

          // Add to designCommits (will dedupe later)
          designCommits = [...designCommits, ...historicalCommits]
        }
      }
    }

    // Deduplicate commits
    designCommits = Array.from(
      new Map(designCommits.map((c) => [c.id, c])).values(),
    )

    // Track commit IDs for this design
    const designCommitIds = new Set(designCommits.map((c) => c.id))
    designCommits.forEach((c) => allCommitIds.add(c.id))

    // Build nodes for this design
    for (const commit of designCommits) {
      const branch = designBranches.find((b) => b.id === commit.branchId)
      const branchType =
        (branch?.branchType as 'main' | 'eco' | 'workspace' | 'release') ||
        'main'

      allNodes.push({
        id: commit.id,
        type: 'commitNode',
        position: { x: 0, y: 0 },
        data: {
          commitId: commit.id,
          message: commit.message || 'No message',
          author: { id: commit.createdBy || '', name: '' },
          date: commit.createdAt.toISOString(),
          branchId: commit.branchId,
          branchName: branch?.name || 'Unknown',
          branchType,
          isMergeCommit: commit.mergeParentId !== null,
          changeStats: {
            added: commit.itemsAdded || 0,
            modified: commit.itemsChanged || 0,
            deleted: commit.itemsDeleted || 0,
          },
          tags: [],
          changeOrderItemId: commit.changeOrderItemId || undefined,
          revisionsAssigned: commit.revisionsAssigned as
            | Record<string, string>
            | undefined,
          designId: design.id,
          designCode: design.code,
          designName: design.name,
        },
      })

      // Parent edge
      if (commit.parentId && designCommitIds.has(commit.parentId)) {
        allEdges.push({
          id: `${commit.parentId}-${commit.id}`,
          source: commit.parentId,
          target: commit.id,
          type: 'default',
          data: { edgeType: 'parent' },
        })
      }

      // Merge edge
      if (commit.mergeParentId && designCommitIds.has(commit.mergeParentId)) {
        allEdges.push({
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

    // Add fork point edges for ECO branches (including archived ones for historical context)
    for (const branch of designBranches) {
      if (branch.branchType !== 'eco' || !branch.baseCommitId) continue

      const branchCommits = designCommits.filter(
        (c) => c.branchId === branch.id,
      )
      if (branchCommits.length === 0) continue

      const sortedBranchCommits = [...branchCommits].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      const oldestCommit = sortedBranchCommits[0]

      if (designCommitIds.has(branch.baseCommitId)) {
        const edgeId = `${branch.baseCommitId}-${oldestCommit.id}`
        if (!allEdges.find((e) => e.id === edgeId)) {
          allEdges.push({
            id: edgeId,
            source: branch.baseCommitId,
            target: oldestCommit.id,
            type: 'default',
            data: { edgeType: 'parent' },
          })
        }
      }
    }
  }

  // 4. Enrich nodes with author names and tags
  if (allCommitIds.size > 0) {
    const commitIdArray = Array.from(allCommitIds)

    // Get authors
    const authorIds = [
      ...new Set(allNodes.map((n) => n.data.author.id).filter(Boolean)),
    ]
    if (authorIds.length > 0) {
      const authors = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, authorIds))

      const authorMap = new Map(authors.map((a) => [a.id, a.name || 'Unknown']))
      for (const node of allNodes) {
        node.data.author.name = authorMap.get(node.data.author.id) || 'Unknown'
      }
    }

    // Get tags
    const commitTags = await db
      .select()
      .from(tags)
      .where(inArray(tags.commitId, commitIdArray))

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

    for (const node of allNodes) {
      node.data.tags = tagsByCommit.get(node.data.commitId) || []
    }

    // Get ECO numbers
    const changeOrderIds = [
      ...new Set(
        allNodes
          .map((n) => n.data.changeOrderItemId)
          .filter((id): id is string => !!id),
      ),
    ]
    if (changeOrderIds.length > 0) {
      const ecoItems = await db
        .select({ id: items.id, itemNumber: items.itemNumber })
        .from(items)
        .where(inArray(items.id, changeOrderIds))

      const ecoNumberMap = new Map(ecoItems.map((e) => [e.id, e.itemNumber]))
      for (const node of allNodes) {
        if (node.data.changeOrderItemId) {
          node.data.ecoNumber = ecoNumberMap.get(node.data.changeOrderItemId)
        }
      }
    }
  }

  // 5. Find cross-design ECOs
  const crossDesignEcos = await findCrossDesignEcos(designIds, programDesigns)

  // 6. Add synthetic "ChangeOrder created" nodes for cross-design ECOs
  // Each design affected by an ECO should show its own "ChangeOrder created" node
  // forking from its main branch, with only that design's commits above it
  for (const eco of crossDesignEcos) {
    for (const affectedDesign of eco.affectedDesigns) {
      const design = programDesigns.find(
        (d) => d.id === affectedDesign.designId,
      )
      if (!design) continue

      // Find the ECO branch for this design
      const designBranches = branchesByDesign.get(affectedDesign.designId) || []
      let ecoBranch = affectedDesign.branchId
        ? designBranches.find((b) => b.id === affectedDesign.branchId)
        : null

      // If branchId from changeOrderDesigns is null, try to find the ECO branch
      // by looking for ECO branches that have commits referencing this ECO
      let ecoBranchId = affectedDesign.branchId
      if (!ecoBranchId) {
        // Find commits for this design that reference this ECO's changeOrderItemId
        const ecoCommitsForDesign = allNodes.filter(
          (n) =>
            n.data.designId === affectedDesign.designId &&
            n.data.changeOrderItemId === eco.id &&
            n.data.branchType === 'eco',
        )
        if (ecoCommitsForDesign.length > 0) {
          ecoBranchId = ecoCommitsForDesign[0].data.branchId
          ecoBranch = designBranches.find((b) => b.id === ecoBranchId) || null
        }
      }

      // Find existing ECO commits for this design and this ECO's branch
      const designEcoNodes = ecoBranchId
        ? allNodes.filter(
            (n) =>
              n.data.designId === affectedDesign.designId &&
              n.data.branchId === ecoBranchId,
          )
        : []

      // Check if there's already a "ChangeOrder created" commit at the start of this branch
      // Be specific: only match the actual ECO creation commit, not just any commit with ChangeOrder in the message
      const hasChangeOrderNode = designEcoNodes.some((n) => {
        const msg = n.data.message.toLowerCase()
        return (
          (msg.includes('changeorder') && msg.includes('created')) ||
          n.data.message === `ChangeOrder ${eco.ecoNumber} created`
        )
      })

      if (!hasChangeOrderNode) {
        // Create a synthetic "ChangeOrder created" node for this design
        const syntheticNodeId = `eco-start-${eco.id}-${affectedDesign.designId}`

        // Find the fork point (baseCommitId from the ECO branch, or latest main commit)
        let forkPointId: string | null = ecoBranch?.baseCommitId || null
        if (!forkPointId) {
          // Fall back to latest main commit for this design
          const mainNodes = allNodes.filter(
            (n) =>
              n.data.designId === affectedDesign.designId &&
              n.data.branchType === 'main',
          )
          if (mainNodes.length > 0) {
            const sortedMain = [...mainNodes].sort(
              (a, b) =>
                new Date(b.data.date).getTime() -
                new Date(a.data.date).getTime(),
            )
            forkPointId = sortedMain[0].id
          }
        }

        // Determine the date for the synthetic node
        // Use the ECO creation date if we can find it, otherwise use earliest ECO commit date
        let nodeDate = new Date().toISOString()
        if (designEcoNodes.length > 0) {
          const sortedEcoNodes = [...designEcoNodes].sort(
            (a, b) =>
              new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
          )
          // Place synthetic node slightly before the oldest ECO commit
          const oldestDate = new Date(sortedEcoNodes[0].data.date)
          oldestDate.setSeconds(oldestDate.getSeconds() - 1)
          nodeDate = oldestDate.toISOString()
        }

        // Create the synthetic node
        const syntheticNode: ProgramCommitGraphNode = {
          id: syntheticNodeId,
          type: 'commitNode',
          position: { x: 0, y: 0 },
          data: {
            commitId: syntheticNodeId,
            message: `ChangeOrder ${eco.ecoNumber} created`,
            author: { id: '', name: 'System' },
            date: nodeDate,
            branchId: ecoBranchId || '',
            branchName:
              ecoBranch?.name || affectedDesign.branchName || eco.ecoNumber,
            branchType: 'eco',
            isMergeCommit: false,
            changeStats: { added: 0, modified: 0, deleted: 0 },
            tags: [],
            changeOrderItemId: eco.id,
            ecoNumber: eco.ecoNumber,
            designId: affectedDesign.designId,
            designCode: affectedDesign.designCode,
            designName: design.name,
          },
        }

        allNodes.push(syntheticNode)

        // Add fork edge from main to synthetic node
        if (forkPointId && allCommitIds.has(forkPointId)) {
          allEdges.push({
            id: `${forkPointId}-${syntheticNodeId}`,
            source: forkPointId,
            target: syntheticNodeId,
            type: 'default',
            data: { edgeType: 'parent' },
          })
        }

        // Find the oldest ECO commit that should be a child of the synthetic node
        if (designEcoNodes.length > 0) {
          const sortedEcoNodes = [...designEcoNodes].sort(
            (a, b) =>
              new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
          )
          const oldestEcoCommit = sortedEcoNodes[0]

          // Remove any existing fork edge to this commit and replace with edge from synthetic
          const existingForkEdgeIndex = allEdges.findIndex(
            (e) =>
              e.target === oldestEcoCommit.id &&
              e.data?.edgeType === 'parent' &&
              e.source !== syntheticNodeId,
          )
          if (existingForkEdgeIndex !== -1) {
            allEdges.splice(existingForkEdgeIndex, 1)
          }

          // Add edge from synthetic node to oldest ECO commit
          allEdges.push({
            id: `${syntheticNodeId}-${oldestEcoCommit.id}`,
            source: syntheticNodeId,
            target: oldestEcoCommit.id,
            type: 'default',
            data: { edgeType: 'parent' },
          })
        }
      }
    }
  }

  // 6b. Also check for ECO branches that span multiple designs but weren't in changeOrderDesigns
  // This catches cases where items from design B were checked out to an ECO created on design A
  // Group ECO nodes by branch name pattern (e.g., "eco/ECO-000008")
  const ecoBranchNameToDesigns = new Map<
    string,
    Map<string, Array<ProgramCommitGraphNode>>
  >()
  for (const node of allNodes) {
    if (node.data.branchType !== 'eco' || !node.data.branchName) continue
    const branchName = node.data.branchName
    const designId = node.data.designId

    if (!ecoBranchNameToDesigns.has(branchName)) {
      ecoBranchNameToDesigns.set(branchName, new Map())
    }
    const designMap = ecoBranchNameToDesigns.get(branchName)!
    if (!designMap.has(designId)) {
      designMap.set(designId, [])
    }
    designMap.get(designId)!.push(node)
  }

  // For each ECO branch name that spans multiple designs, check for missing "ChangeOrder created" nodes
  for (const [branchName, designMap] of ecoBranchNameToDesigns) {
    if (designMap.size < 2) continue // Only interested in cross-design ECOs

    // Extract ECO number from branch name (e.g., "eco/ECO-000008" -> "ECO-000008")
    const ecoNumberMatch = branchName.match(/eco\/(.+)/)
    const ecoNumber = ecoNumberMatch ? ecoNumberMatch[1] : branchName

    for (const [designId, designNodes] of designMap) {
      // Check if this design already has a "ChangeOrder created" node
      const hasCreatedNode = designNodes.some((n) => {
        const msg = n.data.message.toLowerCase()
        return msg.includes('changeorder') && msg.includes('created')
      })

      if (hasCreatedNode) continue // Already has a created node, skip

      // Check if we already added a synthetic node for this design+ECO
      const syntheticNodeId = `eco-branch-start-${branchName}-${designId}`
      if (allNodes.some((n) => n.id === syntheticNodeId)) continue

      const design = programDesigns.find((d) => d.id === designId)
      if (!design) continue

      // Find the ECO branch for this design
      const designBranches = branchesByDesign.get(designId) || []
      const ecoBranch = designBranches.find((b) => b.name === branchName)
      const ecoBranchId = designNodes[0]?.data.branchId || ''

      // Find fork point
      let forkPointId: string | null = ecoBranch?.baseCommitId || null
      if (!forkPointId) {
        const mainNodes = allNodes.filter(
          (n) => n.data.designId === designId && n.data.branchType === 'main',
        )
        if (mainNodes.length > 0) {
          const sortedMain = [...mainNodes].sort(
            (a, b) =>
              new Date(b.data.date).getTime() - new Date(a.data.date).getTime(),
          )
          forkPointId = sortedMain[0].id
        }
      }

      // Determine node date
      let nodeDate = new Date().toISOString()
      if (designNodes.length > 0) {
        const sortedNodes = [...designNodes].sort(
          (a, b) =>
            new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
        )
        const oldestDate = new Date(sortedNodes[0].data.date)
        oldestDate.setSeconds(oldestDate.getSeconds() - 1)
        nodeDate = oldestDate.toISOString()
      }

      // Create synthetic node
      const syntheticNode: ProgramCommitGraphNode = {
        id: syntheticNodeId,
        type: 'commitNode',
        position: { x: 0, y: 0 },
        data: {
          commitId: syntheticNodeId,
          message: `ChangeOrder ${ecoNumber} created`,
          author: { id: '', name: 'System' },
          date: nodeDate,
          branchId: ecoBranchId,
          branchName: branchName,
          branchType: 'eco',
          isMergeCommit: false,
          changeStats: { added: 0, modified: 0, deleted: 0 },
          tags: [],
          ecoNumber: ecoNumber,
          designId: designId,
          designCode: design.code,
          designName: design.name,
        },
      }

      allNodes.push(syntheticNode)

      // Add fork edge
      if (forkPointId && allCommitIds.has(forkPointId)) {
        allEdges.push({
          id: `${forkPointId}-${syntheticNodeId}`,
          source: forkPointId,
          target: syntheticNodeId,
          type: 'default',
          data: { edgeType: 'parent' },
        })
      }

      // Connect to oldest ECO commit
      if (designNodes.length > 0) {
        const sortedNodes = [...designNodes].sort(
          (a, b) =>
            new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
        )
        const oldestCommit = sortedNodes[0]

        // Remove existing fork edge
        const existingEdgeIndex = allEdges.findIndex(
          (e) =>
            e.target === oldestCommit.id &&
            e.data?.edgeType === 'parent' &&
            e.source !== syntheticNodeId,
        )
        if (existingEdgeIndex !== -1) {
          allEdges.splice(existingEdgeIndex, 1)
        }

        // Add edge from synthetic to oldest commit
        allEdges.push({
          id: `${syntheticNodeId}-${oldestCommit.id}`,
          source: syntheticNodeId,
          target: oldestCommit.id,
          type: 'default',
          data: { edgeType: 'parent' },
        })
      }
    }
  }

  // 7. Consolidate commits
  const consolidated = consolidateCommits(allNodes, allEdges)

  // 8. Filter designs to only those with commits (to match layout)
  const designsWithNodes = new Set(
    consolidated.nodes.map((n) => n.data.designId),
  )
  const activeDesigns = programDesigns
    .filter((d) => designsWithNodes.has(d.id))
    .map((d, idx) => ({ ...d, columnIndex: idx })) // Re-index columns

  return {
    nodes: consolidated.nodes,
    edges: consolidated.edges,
    ecoConnectorEdges: [], // Connector edges are no longer used - each design shows its own synthetic ECO node
    designs: activeDesigns,
    crossDesignEcos,
    program: { id: program.id, code: program.code, name: program.name },
  }
}

async function findCrossDesignEcos(
  designIds: Array<string>,
  programDesigns: Array<ProgramGraphDesign>,
): Promise<Array<CrossDesignEco>> {
  // Query changeOrderDesigns to find ECOs that affect multiple designs
  const ecoDesignLinks = await db
    .select({
      changeOrderId: changeOrderDesigns.changeOrderId,
      designId: changeOrderDesigns.designId,
      branchId: changeOrderDesigns.branchId,
    })
    .from(changeOrderDesigns)
    .where(inArray(changeOrderDesigns.designId, designIds))

  // Group by ECO
  const ecoMap = new Map<
    string,
    Array<{ designId: string; branchId: string | null }>
  >()
  for (const link of ecoDesignLinks) {
    const existing = ecoMap.get(link.changeOrderId) || []
    existing.push({ designId: link.designId, branchId: link.branchId })
    ecoMap.set(link.changeOrderId, existing)
  }

  // Filter to ECOs with 2+ designs in our set
  const crossDesignEcoIds = Array.from(ecoMap.entries())
    .filter(([, designs]) => designs.length >= 2)
    .map(([ecoId]) => ecoId)

  if (crossDesignEcoIds.length === 0) {
    return []
  }

  // Get ECO item details
  const ecoItems = await db
    .select({ id: items.id, itemNumber: items.itemNumber, name: items.name })
    .from(items)
    .where(inArray(items.id, crossDesignEcoIds))

  // Get branch names for affected designs
  const allBranchIds = ecoDesignLinks
    .filter((l) => l.branchId && crossDesignEcoIds.includes(l.changeOrderId))
    .map((l) => l.branchId!)

  let branchNameMap = new Map<string, string>()
  if (allBranchIds.length > 0) {
    const branchInfos = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(inArray(branches.id, allBranchIds))
    branchNameMap = new Map(branchInfos.map((b) => [b.id, b.name]))
  }

  // Build design code lookup
  const designCodeMap = new Map(programDesigns.map((d) => [d.id, d.code]))

  // Build result
  const result: Array<CrossDesignEco> = []
  for (const ecoItem of ecoItems) {
    const affectedDesigns = ecoMap.get(ecoItem.id) || []
    result.push({
      id: ecoItem.id,
      ecoNumber: ecoItem.itemNumber,
      ecoName: ecoItem.name || ecoItem.itemNumber,
      affectedDesigns: affectedDesigns.map((ad) => ({
        designId: ad.designId,
        designCode: designCodeMap.get(ad.designId) || 'Unknown',
        branchId: ad.branchId,
        branchName: ad.branchId ? branchNameMap.get(ad.branchId) || null : null,
      })),
    })
  }

  return result
}

const app = new Hono()

// GET /api/programs - pagination, sorting, filtering, optional status counts
app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const sortField = url.searchParams.get('sortField') || undefined
      const sortDirection =
        (url.searchParams.get('sortDirection') as 'asc' | 'desc') || undefined
      const includeCounts = url.searchParams.get('includeCounts') === 'true'
      const globalSearch = url.searchParams.get('globalSearch') || undefined

      let columnFilters:
        | Record<string, string | Array<string> | { min?: number; max?: number }>
        | undefined
      const columnFiltersRaw = url.searchParams.get('columnFilters')
      if (columnFiltersRaw) {
        try {
          columnFilters = JSON.parse(columnFiltersRaw)
        } catch {
          // Invalid JSON — ignore
        }
      }

      // Accessible program IDs: null = admin (all programs), array = specific
      const programIds = await AccessControlService.getAccessibleProgramIds(
        user.id,
      )

      const result = await ProgramService.search({
        programIds,
        limit,
        offset,
        sortField,
        sortDirection,
        columnFilters,
        globalSearch,
      })

      const response: Record<string, unknown> = {
        programs: result.items,
        total: result.total,
      }

      if (includeCounts) {
        const [activeCount, onHoldCount, completedCount] = await Promise.all([
          ProgramService.search({
            programIds,
            limit: 1,
            columnFilters: { status: ['Active'] },
          }),
          ProgramService.search({
            programIds,
            limit: 1,
            columnFilters: { status: ['On Hold'] },
          }),
          ProgramService.search({
            programIds,
            limit: 1,
            columnFilters: { status: ['Completed'] },
          }),
        ])
        response.counts = {
          active: activeCount.total,
          onHold: onHoldCount.total,
          completed: completedCount.total,
        }
      }

      return response
    }),
  ),
)

// POST /api/programs
app.post(
  '/',
  adapt(
    apiHandler(
      { permission: ['programs', 'create'] },
      async ({ request, user }) => {
        const data = await request.json()
        const program = await ProgramService.create(data, user.id)

        return created({ program })
      },
    ),
  ),
)

// GET /api/programs/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      // Check if user is a member (or has global permission)
      const canAccess = await ProgramService.canUserAccess(user.id, params.id)
      if (!canAccess) {
        await requirePermission(request, 'programs', 'read')
      }

      const program = await ProgramService.getById(params.id)
      if (!program) throw new NotFoundError('Program', params.id)

      // Include user's role if they're a member
      const userRole = await ProgramService.getUserRole(user.id, params.id)

      return { program: { ...program, userRole } }
    }),
  ),
)

// PUT /api/programs/:id
app.put(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      // Check if user is an admin of the program
      const userRole = await ProgramService.getUserRole(user.id, params.id)
      if (userRole !== 'admin') {
        await requirePermission(request, 'programs', 'update')
      }

      const data = await request.json()
      const program = await ProgramService.update(params.id, data, user.id)
      return { program }
    }),
  ),
)

// DELETE /api/programs/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      // Check if user is an admin of the program AND has org-level permission
      const userRole = await ProgramService.getUserRole(user.id, params.id)
      if (userRole !== 'admin') {
        await requirePermission(request, 'programs', 'delete')
      }

      await ProgramService.delete(params.id)
      return { success: true }
    }),
  ),
)

// GET /api/programs/:id/history/graph
app.get(
  '/:id/history/graph',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const program = await ProgramService.getById(params.id)
      if (!program) {
        throw new NotFoundError('Program', params.id)
      }

      // Check access
      const isGlobalAdmin = await permissionService.hasRole(
        user.id,
        'Global Admin',
      )
      if (!isGlobalAdmin) {
        const canAccess = await ProgramService.canUserAccess(user.id, params.id)
        if (!canAccess) {
          throw new PermissionDeniedError('program history', 'read')
        }
      }

      // Parse query params
      const url = new URL(request.url, 'http://localhost')
      const designIdsParam = url.searchParams.get('designIds')
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const designIds = designIdsParam
        ? designIdsParam.split(',').filter(Boolean)
        : undefined

      const graphData = await buildProgramGraph(
        params.id,
        program,
        designIds,
        limit,
      )

      return graphData
    }),
  ),
)

// GET /api/programs/:id/members
app.get(
  '/:id/members',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const canAccess = await ProgramService.canUserAccess(user.id, params.id)
      if (!canAccess) {
        throw new PermissionDeniedError('program members', 'read')
      }

      const members = await ProgramService.listMembers(params.id)
      return { members }
    }),
  ),
)

// POST /api/programs/:id/members
app.post(
  '/:id/members',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      // Check if user is an admin of the program
      const userRole = await ProgramService.getUserRole(user.id, params.id)
      if (userRole !== 'admin' && userRole !== 'lead') {
        throw new PermissionDeniedError('program members', 'add')
      }

      const data = await request.json()
      const { userId, role } = data

      if (!userId || !role) {
        throw new ValidationError('userId and role are required')
      }

      const member = await ProgramService.addMember(
        params.id,
        userId,
        role,
        user.id,
      )

      return created({ member })
    }),
  ),
)

// PUT /api/programs/:id/members/:userId
app.put(
  '/:id/members/:userId',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const userRole = await ProgramService.getUserRole(user.id, params.id)
      if (userRole !== 'admin') {
        throw new PermissionDeniedError('program member', 'update')
      }

      const data = await request.json()
      const member = await ProgramService.updateMember(
        params.id,
        params.userId,
        data,
      )
      return { member }
    }),
  ),
)

// DELETE /api/programs/:id/members/:userId
app.delete(
  '/:id/members/:userId',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const userRole = await ProgramService.getUserRole(user.id, params.id)
      if (userRole !== 'admin') {
        throw new PermissionDeniedError('program member', 'remove')
      }

      await ProgramService.removeMember(params.id, params.userId)
      return { success: true }
    }),
  ),
)

export default app
