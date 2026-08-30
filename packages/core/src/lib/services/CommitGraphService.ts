// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Commit history graphs — build (DESIGNS-2).
 *
 * Both pipelines were extracted from route files where ~650 and ~700 lines of
 * graph assembly lived between handlers: the design graph
 * (GET /designs/:id/history/graph) and the program graph
 * (GET /programs/:id/history/graph). Neither route now does more than resolve
 * its query parameters and call in here.
 *
 * Commit consolidation is not defined here: it lives, once, in
 * `@/lib/versioning/graph-utils` and is covered by the invariants tests
 * alongside it.
 */

import { desc, eq, inArray } from 'drizzle-orm'
import { DesignService } from './DesignService'
import { BranchService } from './BranchService'
import type {
  CommitGraphData,
  CommitGraphEdge,
  CommitGraphNode,
  CrossDesignEco,
  ProgramCommitGraphNode,
  ProgramGraphData,
  ProgramGraphDesign,
} from '@/lib/versioning/graph-types'
import { consolidateCommits } from '@/lib/versioning/graph-utils'
import { db } from '@/lib/db'
import { changeOrderDesigns, items } from '@/lib/db/schema/items'
import { branches, commits, tags } from '@/lib/db/schema/versioning'
import { users } from '@/lib/db/schema/users'

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
      branchType = (selectedBranch.branchType || 'eco') as
        'eco' | 'workspace' | 'release'
    } else {
      // Look up from open ECO branches first, then historical branches
      const openEcoInfo = openEcoBranchInfo.get(commit.branchId)
      const histInfo = historicalBranchInfo.get(commit.branchId)
      const branchInfo = openEcoInfo || histInfo
      branchName = branchInfo?.name || 'Unknown Branch'
      branchType = (branchInfo?.branchType || 'eco') as
        'eco' | 'workspace' | 'release'
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
          Record<string, string> | undefined,
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
    // Safe: guarded by branchCommits.length > 0 above
    const oldestBranchCommit = branchCommits[branchCommits.length - 1]!

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
    // Safe: guarded by branchHistoryCommits.length === 0 continue above
    const oldestCommit = sortedCommits[0]!

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
    // Safe: guarded by ecoBranchCommits.length === 0 continue above
    const oldestCommit = sortedCommits[0]!

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
      const branchType = (branch?.branchType || 'main') as
        'main' | 'eco' | 'workspace' | 'release'

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
            Record<string, string> | undefined,
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
      const oldestCommit = sortedBranchCommits[0]!

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
          ecoBranchId = ecoCommitsForDesign[0]!.data.branchId
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
            forkPointId = sortedMain[0]!.id
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
          const oldestDate = new Date(sortedEcoNodes[0]!.data.date)
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
          const oldestEcoCommit = sortedEcoNodes[0]!

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
          forkPointId = sortedMain[0]!.id
        }
      }

      // Determine node date
      let nodeDate = new Date().toISOString()
      if (designNodes.length > 0) {
        const sortedNodes = [...designNodes].sort(
          (a, b) =>
            new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
        )
        const oldestDate = new Date(sortedNodes[0]!.data.date)
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
        const oldestCommit = sortedNodes[0]!

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

  // 7. Consolidate commits. A consolidated node must never span designs: the
  // active-design list below and the client's column layout both read
  // `designId` off the result.
  const consolidated = consolidateCommits(allNodes, allEdges, {
    shouldGroup: (current, next) =>
      next.data.designId === current.data.designId,
  })

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

export class CommitGraphService {
  /**
   * Build commit graph data for visualization.
   *
   * When viewing main branch: main commits plus historical merged branches.
   * When viewing another branch: main plus that branch's commits.
   */
  static buildCommitGraph(
    designId: string,
    selectedBranchId: string | null,
    limit: number,
  ): Promise<CommitGraphData> {
    return buildCommitGraph(designId, selectedBranchId, limit)
  }

  /**
   * Build the program-level history graph — every design in the program laid
   * out side by side, with each design's ECO branches drawn against it.
   */
  static buildProgramGraph(
    programId: string,
    program: { id: string; code: string; name: string },
    filterDesignIds: Array<string> | undefined,
    limit: number,
  ): Promise<ProgramGraphData> {
    return buildProgramGraph(programId, program, filterDesignIds, limit)
  }
}
