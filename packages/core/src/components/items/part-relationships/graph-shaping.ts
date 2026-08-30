// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import * as dagre from 'dagre'
import type { Edge, Node } from '@xyflow/react'
import type { CachedEdge, CachedNode, ExpandState } from './types'
import {
  USAGE_EDGE_LABEL,
  graphEdgeKind,
  graphEdgeVisuals,
  parallelEdgeOffsets,
} from '@/components/graph/edgeStyles'

/**
 * Pure graph shaping for the relationships graph view: dagre layout,
 * reachability from the centre node, and the API-response → React Flow
 * translation.
 *
 * Nothing here touches React. That is the point — this half was the bulk of
 * the panel's module scope and none of it needs a component to live in.
 */

// Dagre graph layout
export const getLayoutedElements = (
  nodes: Array<Node>,
  edges: Array<Edge>,
  direction = 'TB',
) => {
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  const nodeWidth = 280
  const nodeHeight = 120

  dagreGraph.setGraph({
    rankdir: direction,
    ranksep: 80,
    nodesep: 60,
  })

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  })

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target)
  })

  dagre.layout(dagreGraph)

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id)
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    }
  })

  return { nodes: layoutedNodes, edges }
}

// --- Pure graph helpers (defined outside component) ---

/**
 * BFS from rootId through expanded directions, returns set of visible node IDs.
 */
export function computeReachableNodes(
  rootId: string,
  expandedMap: Map<string, ExpandState>,
  edgeCache: Map<string, CachedEdge>,
): Set<string> {
  const visible = new Set<string>([rootId])
  const queue = [rootId]

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    const exp = expandedMap.get(nodeId)
    if (!exp) continue

    for (const [, edge] of edgeCache) {
      if (
        exp.downstream &&
        edge.source === nodeId &&
        !visible.has(edge.target)
      ) {
        visible.add(edge.target)
        queue.push(edge.target)
      }
      if (exp.upstream && edge.target === nodeId && !visible.has(edge.source)) {
        visible.add(edge.source)
        queue.push(edge.source)
      }
    }
  }

  return visible
}

/**
 * Compute the visible subset of nodes and edges from caches + expandedMap.
 */
export function computeVisibleGraph(
  rootId: string,
  expandedMap: Map<string, ExpandState>,
  nodeCache: Map<string, CachedNode>,
  edgeCache: Map<string, CachedEdge>,
): { nodes: Array<Node>; edges: Array<Edge> } {
  const visibleIds = computeReachableNodes(rootId, expandedMap, edgeCache)

  const nodes: Array<Node> = []
  for (const id of visibleIds) {
    const cached = nodeCache.get(id)
    if (cached) nodes.push({ ...cached })
  }

  const edges: Array<Edge> = []
  for (const [, edge] of edgeCache) {
    if (visibleIds.has(edge.source) && visibleIds.has(edge.target)) {
      edges.push({ ...edge })
    }
  }

  return { nodes, edges }
}

/**
 * Process raw API response into React Flow nodes and edges.
 * Handles UsageOf swap, parallel offset, and waypoint callback injection.
 */
export function processApiResponse(
  data: { nodes: Array<any>; edges: Array<any> },
  stableWaypointChange: (
    edgeId: string,
    waypoint: { x: number; y: number } | undefined,
  ) => void,
): { nodes: Array<CachedNode>; edges: Array<CachedEdge> } {
  const flowEdges: Array<CachedEdge> = data.edges.map((edge: any) => {
    const isUsageEdge = edge.data?.isUsageRelationship === true
    const visuals = graphEdgeVisuals(graphEdgeKind(edge.data ?? {}))

    // For UsageOf edges: swap to definition→usage so definition is above.
    // The label flips with it so the wording still reads the way the arrow
    // points (definition "used by" usage).
    const source = isUsageEdge ? edge.target : edge.source
    const target = isUsageEdge ? edge.source : edge.target

    return {
      id: edge.id,
      source,
      target,
      label: isUsageEdge ? USAGE_EDGE_LABEL : edge.label,
      type: 'relationship',
      animated: isUsageEdge,
      markerEnd: visuals.markerEnd,
      style: visuals.style,
      data: {
        ...edge.data,
        onWaypointChange: stableWaypointChange,
      },
    }
  })

  // Auto-offset parallel edges (same source-target pair) so their labels —
  // and the direction arrows inside them — don't stack on top of each other
  const offsets = parallelEdgeOffsets(flowEdges)
  for (const edge of flowEdges) {
    const offset = offsets.get(edge.id)
    if (offset !== undefined) {
      edge.data = { ...edge.data, parallelOffset: offset }
    }
  }

  const flowNodes: Array<CachedNode> = data.nodes.map((node: any) => ({
    id: node.id,
    type: node.type,
    data: node.data,
    position: node.position,
  }))

  return { nodes: flowNodes, edges: flowEdges }
}
