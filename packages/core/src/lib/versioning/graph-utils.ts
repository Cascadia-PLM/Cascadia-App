// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Commit-graph consolidation — the single implementation.
 *
 * Three graph pipelines call `consolidateCommits`: the design history graph,
 * the ECO branch history graph (`EcoBranchHistoryService`), and the program
 * history graph — the first and last both via `CommitGraphService`. Each used
 * to carry its own copy of this algorithm and they had already drifted.
 * Everything here is pure — no `@/lib/db` import — so it stays safe to reach
 * from client code.
 *
 * Two invariants the callers depend on; do not "simplify" either away:
 *
 *  - The consolidated node is built by spreading `firstCommit` and
 *    `firstCommit.data`, so subtype fields survive. The program graph's
 *    `ProgramCommitNodeData` carries `designId`/`designCode`/`designName`,
 *    and both the pipeline (which derives the active design list) and
 *    `ProgramHistoryGraphView` (which assigns design columns) read `designId`
 *    off consolidated nodes. Enumerating fields explicitly would blank the
 *    program graph.
 *  - `shouldGroup` is the caller's extra group boundary, applied on top of the
 *    standard branch/author/action/item-type/time-window checks.
 *
 * Edge remapping is keyed by `node.id`, because edge endpoints are node ids.
 * `data.consolidatedCommitIds` is display/provenance metadata — never a remap
 * key. Keying the map off it, as an earlier version of this function did,
 * silently required every producer to satisfy
 * `node.id === node.data.commitId`: a producer that
 * prefixed its ids (`eco-${commit.id}`) would have had every edge touching a
 * consolidated group dropped, with no throw and no type error, since both
 * fields are `string`. That requirement was removed deliberately. A producer
 * owns its node ids; do not reintroduce the coupling.
 */

import type { Node } from '@xyflow/react'
import type { CommitGraphEdge, CommitNodeData } from './graph-types'

/** Time window in milliseconds for consolidating commits (30 minutes) */
export const CONSOLIDATION_TIME_WINDOW_MS = 30 * 60 * 1000

/** Minimum number of commits to trigger consolidation */
export const MIN_COMMITS_TO_CONSOLIDATE = 2

/**
 * Check if a commit should NOT be consolidated (is "important")
 */
export function isImportantCommit(data: CommitNodeData): boolean {
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
export function extractActionType(message: string): string {
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
export function extractItemType(message: string): string {
  // Match patterns like "Part WA-1000 created" or "Document DOC-001 updated"
  const match = message.match(
    /^(Part|Document|ChangeOrder|Requirement|Task)\s+/i,
  )
  return match?.[1] ?? 'Item'
}

/**
 * Generate a consolidated message
 */
export function generateConsolidatedMessage(
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

export interface ConsolidateCommitsOptions<
  TData extends CommitNodeData,
  TNode extends Node<TData, 'commitNode'>,
> {
  /**
   * Additional grouping predicate beyond standard checks.
   * Return false to break the group (e.g., different designId in program graph).
   */
  shouldGroup?: (current: TNode, next: TNode) => boolean
}

/**
 * Consolidate sequential similar commits into grouped nodes.
 *
 * Groups consecutive commits that share the same branch, author, action type,
 * item type, and are within the consolidation time window. Important commits
 * (merges, ECOs, tagged, initial) are never consolidated.
 */
export function consolidateCommits<
  TData extends CommitNodeData,
  TNode extends Node<TData, 'commitNode'>,
>(
  nodes: Array<TNode>,
  edges: Array<CommitGraphEdge>,
  options?: ConsolidateCommitsOptions<TData, TNode>,
): { nodes: Array<TNode>; edges: Array<CommitGraphEdge> } {
  if (nodes.length < MIN_COMMITS_TO_CONSOLIDATE) {
    return { nodes, edges }
  }

  // Sort nodes by date (oldest first) for processing
  const sortedNodes = [...nodes].sort(
    (a, b) => new Date(a.data.date).getTime() - new Date(b.data.date).getTime(),
  )

  // Group commits that can be consolidated
  const consolidatedNodes: Array<TNode> = []
  const removedNodeIds = new Set<string>()
  // Original node id → the consolidated node that replaced it. Populated in
  // the same pass as `removedNodeIds` so the two cannot disagree.
  const nodeIdMapping = new Map<string, string>()
  let i = 0

  while (i < sortedNodes.length) {
    // Safe: the while condition guarantees i is in bounds
    const currentNode = sortedNodes[i]!

    // If this is an important commit, don't consolidate it
    if (isImportantCommit(currentNode.data)) {
      consolidatedNodes.push(currentNode)
      i++
      continue
    }

    // Try to find consecutive commits to consolidate
    const group: Array<TNode> = [currentNode]
    const currentAction = extractActionType(currentNode.data.message)
    const currentItemType = extractItemType(currentNode.data.message)
    const currentTime = new Date(currentNode.data.date).getTime()

    let j = i + 1
    while (j < sortedNodes.length) {
      // Safe: the while condition guarantees j is in bounds
      const nextNode = sortedNodes[j]!

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

      // Stop if caller-supplied grouping predicate says no
      if (options?.shouldGroup && !options.shouldGroup(currentNode, nextNode))
        break

      group.push(nextNode)
      j++
    }

    if (group.length >= MIN_COMMITS_TO_CONSOLIDATE) {
      // Create consolidated node
      // Safe: this branch only runs when group.length >= MIN_COMMITS_TO_CONSOLIDATE
      const firstCommit = group[0]!
      const lastCommit = group[group.length - 1]!

      // Aggregate stats
      const totalStats = group.reduce(
        (acc, n) => ({
          added: acc.added + (n.data.changeStats?.added || 0),
          modified: acc.modified + (n.data.changeStats?.modified || 0),
          deleted: acc.deleted + (n.data.changeStats?.deleted || 0),
        }),
        { added: 0, modified: 0, deleted: 0 },
      )

      const consolidatedNode = {
        ...firstCommit,
        id: `consolidated-${firstCommit.id}`,
        position: { x: 0, y: 0 },
        data: {
          ...firstCommit.data,
          message: generateConsolidatedMessage(
            group.length,
            currentAction,
            currentItemType,
          ),
          date: lastCommit.data.date, // Use latest date for display
          changeStats: totalStats,
          tags: [],
          isConsolidated: true,
          consolidatedCount: group.length,
          consolidatedCommitIds: group.map((n) => n.data.commitId),
          dateRangeStart: firstCommit.data.date,
          dateRangeEnd: lastCommit.data.date,
        },
      } as TNode

      consolidatedNodes.push(consolidatedNode)

      // Mark original nodes as removed, and point their edges at the
      // consolidated node. Both are keyed by `node.id` — see the docblock.
      for (const node of group) {
        removedNodeIds.add(node.id)
        nodeIdMapping.set(node.id, consolidatedNode.id)
      }

      i = j
    } else {
      // Not enough commits to consolidate, keep original
      consolidatedNodes.push(currentNode)
      i++
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
