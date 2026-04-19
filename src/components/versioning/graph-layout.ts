/**
 * Shared graph layout utilities for commit history visualization.
 *
 * Used by CommitGraphView, EcoHistoryGraphView, and ProgramHistoryGraphView
 * to avoid duplicating dagre layout, branch column assignment, and edge styling.
 */

import dagre from 'dagre'
import { MarkerType } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import type {
  CommitGraphEdge,
  CommitNodeData,
} from '@/lib/versioning/graph-types'

// Layout constants
export const NODE_WIDTH = 220
export const NODE_HEIGHT = 140
export const BRANCH_COLUMN_WIDTH = 280

interface DagreLayoutOptions {
  rankdir?: string
  ranksep?: number
  nodesep?: number
  marginx?: number
  marginy?: number
}

/**
 * Run dagre layout and return the graph with computed positions.
 */
export function computeDagrePositions<TNode extends Node>(
  nodes: Array<TNode>,
  edges: Array<{ source: string; target: string }>,
  nodeWidth: number,
  nodeHeight: number,
  options?: DagreLayoutOptions,
): dagre.graphlib.Graph {
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  dagreGraph.setGraph({
    rankdir: options?.rankdir ?? 'BT',
    ranksep: options?.ranksep ?? 100,
    nodesep: options?.nodesep ?? 60,
    marginx: options?.marginx ?? 50,
    marginy: options?.marginy ?? 50,
  })

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  })

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target)
  })

  dagre.layout(dagreGraph)

  return dagreGraph
}

export interface BranchColumnResult {
  /** Map of branchId -> column index (0 = main) */
  branchColumn: Map<string, number>
  /** Map of branchId -> sibling rank at its fork point */
  branchSiblingRank: Map<string, number>
  /** Map of branchId -> whether branch is open (unmerged) */
  branchIsOpen: Map<string, boolean>
  /** Map of branchId -> commit ID on parent branch where fork occurred */
  branchForkPoint: Map<string, string>
  /** Maximum column index used */
  maxColumn: number
}

/**
 * Compute branch column assignments using fork-point grouping and merge-time ordering.
 *
 * Strategy:
 * - Main branch: column 0 (leftmost)
 * - ECO branches: column = sibling rank at their fork point
 * - When multiple branches fork from same point, order by merge time (first merged = lower column)
 * - Open (unmerged) branches are pushed to the rightmost positions
 */
export function computeBranchColumns<TData extends CommitNodeData>(
  nodes: Array<Node<TData>>,
  edges: Array<CommitGraphEdge>,
  mainBranchId: string,
  dagreGraph: dagre.graphlib.Graph,
): BranchColumnResult {
  // Map each node to its branch
  const nodeToBranch = new Map<string, string>()
  nodes.forEach((n) => nodeToBranch.set(n.id, n.data.branchId))

  // Get unique branches
  const allBranches = new Set<string>()
  nodes.forEach((n) => allBranches.add(n.data.branchId))

  // Group nodes by branch
  const branchNodes = new Map<string, Array<Node<TData>>>()
  nodes.forEach((n) => {
    const branchId = n.data.branchId
    if (!branchNodes.has(branchId)) {
      branchNodes.set(branchId, [])
    }
    branchNodes.get(branchId)!.push(n)
  })

  // Find parent branch for each non-main branch by looking at parent edges
  const branchParent = new Map<string, string>()
  const branchForkPoint = new Map<string, string>()

  for (const branchId of allBranches) {
    if (branchId === mainBranchId) continue

    const branchCommits = branchNodes.get(branchId) || []
    for (const commit of branchCommits) {
      for (const edge of edges) {
        if (edge.target === commit.id && edge.data?.edgeType === 'parent') {
          const parentNodeBranch = nodeToBranch.get(edge.source)
          if (parentNodeBranch && parentNodeBranch !== branchId) {
            branchParent.set(branchId, parentNodeBranch)
            branchForkPoint.set(branchId, edge.source)
            break
          }
        }
      }
      if (branchParent.has(branchId)) break
    }
  }

  // Find merge information (Y position of merge commits on main/parent)
  const branchMergeY = new Map<string, number>()
  edges.forEach((edge) => {
    if (edge.data?.edgeType === 'merge') {
      const ecoBranch = nodeToBranch.get(edge.source)
      const mergeCommitPos = dagreGraph.node(edge.target)
      if (ecoBranch && ecoBranch !== mainBranchId) {
        if (
          !branchMergeY.has(ecoBranch) ||
          mergeCommitPos.y > branchMergeY.get(ecoBranch)!
        ) {
          branchMergeY.set(ecoBranch, mergeCommitPos.y)
        }
      }
    }
  })

  // Group branches by fork point
  const branchesByForkPoint = new Map<string, Array<string>>()
  for (const branchId of allBranches) {
    if (branchId === mainBranchId) continue
    const forkPoint = branchForkPoint.get(branchId) || 'unknown'
    if (!branchesByForkPoint.has(forkPoint)) {
      branchesByForkPoint.set(forkPoint, [])
    }
    branchesByForkPoint.get(forkPoint)!.push(branchId)
  }

  // Assign sibling ranks per fork point
  const branchSiblingRank = new Map<string, number>()
  const branchIsOpen = new Map<string, boolean>()

  for (const [, forkBranches] of branchesByForkPoint) {
    const merged: Array<string> = []
    const open: Array<string> = []

    for (const branchId of forkBranches) {
      if (branchMergeY.has(branchId)) {
        merged.push(branchId)
        branchIsOpen.set(branchId, false)
      } else {
        open.push(branchId)
        branchIsOpen.set(branchId, true)
      }
    }

    // Sort merged branches by merge time (higher Y = older = merged earlier in BT layout)
    merged.sort((a, b) => {
      const aMergeY = branchMergeY.get(a)!
      const bMergeY = branchMergeY.get(b)!
      return bMergeY - aMergeY
    })

    let rank = 1
    for (const branchId of merged) {
      branchSiblingRank.set(branchId, rank++)
    }
    for (const branchId of open) {
      branchSiblingRank.set(branchId, rank++)
    }
  }

  // Assign columns: main=0, others by sibling rank
  const branchColumn = new Map<string, number>()
  branchColumn.set(mainBranchId, 0)

  let maxColumn = 0
  for (const branchId of allBranches) {
    if (branchId === mainBranchId) continue
    const rank = branchSiblingRank.get(branchId) ?? 1
    branchColumn.set(branchId, rank)
    if (rank > maxColumn) maxColumn = rank
  }

  return {
    branchColumn,
    branchSiblingRank,
    branchIsOpen,
    branchForkPoint,
    maxColumn,
  }
}

/**
 * Simple branch column assignment: main=0, others assigned incrementally by Y position.
 * Used by EcoHistoryGraphView which doesn't need fork-point grouping.
 */
export function computeSimpleBranchColumns<TData extends CommitNodeData>(
  nodes: Array<Node<TData>>,
  mainBranchId: string,
  dagreGraph: dagre.graphlib.Graph,
): Map<string, number> {
  const nodesByY = [...nodes].sort((a, b) => {
    const aPos = dagreGraph.node(a.id)
    const bPos = dagreGraph.node(b.id)
    return aPos.y - bPos.y
  })

  const branchColumns = new Map<string, number>()
  branchColumns.set(mainBranchId, 0)

  let nextColumn = 1
  for (const node of nodesByY) {
    const branchId = node.data.branchId
    if (!branchColumns.has(branchId)) {
      branchColumns.set(branchId, nextColumn)
      nextColumn++
    }
  }

  return branchColumns
}

/**
 * High-level layout for a single-design commit graph.
 * Combines dagre positioning with full branch column logic.
 */
export function layoutCommitGraph<TData extends CommitNodeData>(
  nodes: Array<Node<TData, 'commitNode'>>,
  edges: Array<CommitGraphEdge>,
  mainBranchId: string,
  options?: { branchColumnWidth?: number },
): Array<Node<TData, 'commitNode'>> {
  if (nodes.length === 0) return []

  const columnWidth = options?.branchColumnWidth ?? BRANCH_COLUMN_WIDTH

  const dagreGraph = computeDagrePositions(
    nodes,
    edges,
    NODE_WIDTH,
    NODE_HEIGHT,
  )

  const { branchColumn } = computeBranchColumns(
    nodes,
    edges,
    mainBranchId,
    dagreGraph,
  )

  return nodes.map((node) => {
    const dagrePos = dagreGraph.node(node.id)
    const col = branchColumn.get(node.data.branchId) ?? 0

    return {
      ...node,
      position: {
        x: col * columnWidth,
        y: dagrePos.y - NODE_HEIGHT / 2,
      },
    }
  })
}

/**
 * Style edges for bottom-to-top layout.
 * Swaps source/target so edges visually flow from old (bottom) to new (top).
 * Applies merge styling (dashed orange) vs parent styling (solid slate).
 */
export function styleEdges(
  edges: Array<CommitGraphEdge>,
  options?: {
    /** Edge type for parent edges. Default: 'step' */
    parentEdgeType?: string
    /** Edge type for merge edges. Default: 'smoothstep' */
    mergeEdgeType?: string
  },
): Array<Edge> {
  const parentType = options?.parentEdgeType ?? 'step'
  const mergeType = options?.mergeEdgeType ?? 'smoothstep'

  return edges.map((edge) => ({
    ...edge,
    source: edge.target,
    target: edge.source,
    type: edge.data?.edgeType === 'merge' ? mergeType : parentType,
    markerStart: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
      color: edge.data?.edgeType === 'merge' ? '#f97316' : '#64748b',
    },
    style:
      edge.data?.edgeType === 'merge'
        ? { strokeDasharray: '5,5', stroke: '#f97316', strokeWidth: 2 }
        : { stroke: '#64748b', strokeWidth: 2 },
    animated: false,
    className:
      edge.data?.edgeType === 'merge'
        ? 'react-flow__edge-animated-reverse'
        : undefined,
  }))
}
