// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import dagre from 'dagre'
import { Position } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import type { ThreadEdge, ThreadNode } from '@/lib/services/ThreadService'
import { directionalMarker } from '@/components/graph/edgeStyles'

type NodeData = Record<string, unknown>

const NODE_WIDTH = 280
const NODE_HEIGHT = 100
const DOMAIN_GAP = 200 // Gap between domains
const DOMAIN_HEADER_HEIGHT = 60

/**
 * Lanes rendered by the navigator, in stacking order. Validation sits
 * between requirements and engineering because test cases link both ways:
 * VERIFIED_BY up to requirements, VALIDATES down to parts.
 */
const LANES = [
  'requirements',
  'validation',
  'engineering',
  'manufacturing',
  'physical',
] as const
type LaneDomain = (typeof LANES)[number]

/**
 * Handle ids rendered by ThreadNode/ThreadNodeDiff. Every node exposes a
 * primary pair (source at the lane-flow side, target at the opposite side)
 * and an "alt" pair on the flipped sides, so edges that travel against the
 * lane stacking order (e.g. INSTANCE_OF: physical instance → EBOM part)
 * can leave from the side that faces their counterpart.
 */
export const THREAD_HANDLE_SOURCE = 'source'
export const THREAD_HANDLE_SOURCE_ALT = 'source-alt'
export const THREAD_HANDLE_TARGET = 'target'
export const THREAD_HANDLE_TARGET_ALT = 'target-alt'

interface LayoutOptions {
  nodeWidth?: number
  nodeHeight?: number
  domainGap?: number
  ranksep?: number
  nodesep?: number
  rankdir?: 'TB' | 'LR'
}

const laneOf = (domain: string): LaneDomain | undefined =>
  (LANES as ReadonlyArray<string>).includes(domain)
    ? (domain as LaneDomain)
    : undefined

const laneIndexOf = (domain: string): number =>
  (LANES as ReadonlyArray<string>).indexOf(domain)

/**
 * Applies a swim lane layout to thread nodes.
 * Nodes are organized into lanes by domain (Requirements | Validation |
 * Engineering | Manufacturing | Physical); empty lanes take no space.
 * Within each lane, nodes are laid out using dagre.
 *
 * Edges are pinned to handles that face their counterpart node: an edge
 * whose source sits in a later lane than its target (it travels against
 * the stacking order, like a physical instance linking up to its EBOM
 * part) connects source-top → target-bottom instead of the default
 * source-bottom → target-top (sides instead of top/bottom in LR mode).
 */
export function swimLaneLayout(
  nodes: Array<ThreadNode>,
  edges: Array<ThreadEdge>,
  options: LayoutOptions = {},
): { nodes: Array<Node>; edges: Array<Edge> } {
  const {
    nodeWidth = NODE_WIDTH,
    nodeHeight = NODE_HEIGHT,
    domainGap = DOMAIN_GAP,
    ranksep = 80,
    nodesep = 40,
    rankdir = 'TB',
  } = options

  const isHorizontal = rankdir === 'LR'

  // Group nodes and build one dagre graph per lane
  const laneNodes = new Map<LaneDomain, Array<ThreadNode>>()
  const laneGraphs = new Map<LaneDomain, dagre.graphlib.Graph>()
  for (const lane of LANES) {
    const graph = new dagre.graphlib.Graph()
    graph.setDefaultEdgeLabel(() => ({}))
    graph.setGraph({ rankdir, ranksep, nodesep })
    laneGraphs.set(lane, graph)
    laneNodes.set(lane, [])
  }

  nodes.forEach((node) => {
    const lane = laneOf(node.domain)
    if (!lane) return
    laneNodes.get(lane)!.push(node)
    laneGraphs.get(lane)!.setNode(node.id, {
      width: nodeWidth,
      height: nodeHeight,
    })
  })

  // Same-domain edges rank nodes within their lane's graph
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  edges
    .filter((e) => e.domain === 'same')
    .forEach((edge) => {
      const sourceNode = nodesById.get(edge.sourceId)
      const targetNode = nodesById.get(edge.targetId)
      if (!sourceNode || !targetNode) return
      const lane = laneOf(sourceNode.domain)
      if (!lane || lane !== laneOf(targetNode.domain)) return
      laneGraphs.get(lane)!.setEdge(edge.sourceId, edge.targetId)
    })

  // Lay out each lane, then stack lanes along the separation axis:
  // TB (vertical flow): lanes stacked vertically; LR: side-by-side.
  const sourcePos = isHorizontal ? Position.Right : Position.Bottom
  const targetPos = isHorizontal ? Position.Left : Position.Top

  const positionedNodes: Array<Node> = []
  let laneOffset = 0

  for (const lane of LANES) {
    const members = laneNodes.get(lane)!
    if (members.length === 0) continue

    const graph = laneGraphs.get(lane)!
    dagre.layout(graph)

    let extent = 0
    members.forEach((node) => {
      const pos = graph.node(node.id)
      extent = isHorizontal
        ? Math.max(extent, pos.x + nodeWidth / 2)
        : Math.max(extent, pos.y + nodeHeight / 2)
    })

    members.forEach((node) => {
      const pos = graph.node(node.id)
      positionedNodes.push({
        id: node.id,
        type: 'threadNode',
        sourcePosition: sourcePos,
        targetPosition: targetPos,
        position: {
          x: isHorizontal
            ? pos.x - nodeWidth / 2 + laneOffset
            : pos.x - nodeWidth / 2,
          y: isHorizontal
            ? pos.y - nodeHeight / 2 + DOMAIN_HEADER_HEIGHT
            : pos.y - nodeHeight / 2 + DOMAIN_HEADER_HEIGHT + laneOffset,
        },
        data: node as unknown as NodeData,
      })
    })

    laneOffset += extent + domainGap
  }

  // Drop edges whose endpoints are not rendered (e.g. nodes from domains
  // outside the lane set) so React Flow does not warn about them.
  const renderedIds = new Set(positionedNodes.map((n) => n.id))

  const positionedEdges: Array<Edge> = edges
    .filter((e) => renderedIds.has(e.sourceId) && renderedIds.has(e.targetId))
    .map((edge) => {
      // Edges that travel against the lane stacking order (source in a
      // later lane than its target) attach to the flipped handle pair so
      // they connect the facing sides of the two nodes.
      const sourceLane = laneIndexOf(nodesById.get(edge.sourceId)!.domain)
      const targetLane = laneIndexOf(nodesById.get(edge.targetId)!.domain)
      const againstFlow = sourceLane > targetLane
      const strokeColor = edge.domain === 'cross' ? '#f59e0b' : '#94a3b8'

      return {
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        sourceHandle: againstFlow
          ? THREAD_HANDLE_SOURCE_ALT
          : THREAD_HANDLE_SOURCE,
        targetHandle: againstFlow
          ? THREAD_HANDLE_TARGET_ALT
          : THREAD_HANDLE_TARGET,
        type: 'smoothstep',
        animated: edge.domain === 'cross',
        // Lanes stack in flow order, but edges routed against that order
        // (INSTANCE_OF, VERIFIED_BY) travel back up the canvas — so the
        // arrowhead, not the position, is what tells the reader which item
        // the relationship is stated on.
        markerEnd: directionalMarker(strokeColor),
        style: {
          stroke: strokeColor,
          strokeWidth: edge.domain === 'cross' ? 2 : 1,
          strokeDasharray: edge.domain === 'cross' ? '5,5' : undefined,
        },
        label:
          edge.domain === 'cross'
            ? edge.derivationMethod || edgeLabel(edge)
            : edge.relationshipType === 'Consumes' ||
                edge.relationshipType === 'Produces'
              ? edgeLabel(edge)
              : edge.quantity
                ? `qty: ${edge.quantity}`
                : undefined,
        labelStyle: {
          fontSize: 10,
          fontWeight: 500,
          fill: edge.domain === 'cross' ? '#f59e0b' : '#64748b',
        },
        // Label background is left to React Flow's theme variables so it
        // follows the ReactFlow colorMode (white in light, near-black in dark).
      }
    })

  return { nodes: positionedNodes, edges: positionedEdges }
}

/**
 * Display-direction neighbors of every thread node. "Down" follows the
 * on-screen flow: same-lane edges run source → target (dagre rank order),
 * cross-lane edges run from the earlier lane to the later lane regardless
 * of which endpoint the service emitted as the edge source (INSTANCE_OF
 * edges are physical → part, but display with the part on top).
 */
export interface ThreadAdjacency {
  up: Map<string, Set<string>>
  down: Map<string, Set<string>>
}

export function buildThreadAdjacency(
  nodes: Array<ThreadNode>,
  edges: Array<ThreadEdge>,
): ThreadAdjacency {
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  const up = new Map<string, Set<string>>()
  const down = new Map<string, Set<string>>()

  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    let set = map.get(key)
    if (!set) {
      set = new Set()
      map.set(key, set)
    }
    set.add(value)
  }

  for (const edge of edges) {
    const source = nodesById.get(edge.sourceId)
    const target = nodesById.get(edge.targetId)
    if (!source || !target) continue
    const sourceLane = laneIndexOf(source.domain)
    const targetLane = laneIndexOf(target.domain)
    if (sourceLane < 0 || targetLane < 0) continue

    const parent = sourceLane > targetLane ? target.id : source.id
    const child = sourceLane > targetLane ? source.id : target.id
    add(down, parent, child)
    add(up, child, parent)
  }

  return { up, down }
}

/** Per-node collapsed state; a missing entry means fully expanded. */
export type ThreadCollapsedMap = ReadonlyMap<
  string,
  { up: boolean; down: boolean }
>

/**
 * Nodes visible under the given per-node collapse state: everything
 * reachable from the focal item, walking down from nodes whose "down" is
 * expanded and up from nodes whose "up" is expanded. Falls back to showing
 * every node when the focal item is not part of the rendered graph.
 */
export function computeVisibleThreadIds(
  focalId: string,
  nodes: Array<ThreadNode>,
  adjacency: ThreadAdjacency,
  collapsed: ThreadCollapsedMap,
): Set<string> {
  if (!nodes.some((n) => n.id === focalId)) {
    return new Set(nodes.map((n) => n.id))
  }

  const visible = new Set<string>([focalId])
  const queue = [focalId]

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    const state = collapsed.get(nodeId)

    if (!state?.down) {
      for (const child of adjacency.down.get(nodeId) ?? []) {
        if (!visible.has(child)) {
          visible.add(child)
          queue.push(child)
        }
      }
    }
    if (!state?.up) {
      for (const parent of adjacency.up.get(nodeId) ?? []) {
        if (!visible.has(parent)) {
          visible.add(parent)
          queue.push(parent)
        }
      }
    }
  }

  return visible
}

/** Human label for cross-domain edges without a derivation method. */
function edgeLabel(edge: ThreadEdge): string {
  switch (edge.relationshipType) {
    case 'Consumes':
      return edge.quantity ? `consumes ×${edge.quantity}` : 'consumes'
    case 'Produces':
      return 'produces'
    case 'INSTANCE_OF':
      return 'instance of'
    case 'BUILDS':
      return 'builds'
    case 'Evidences':
      return 'evidences'
    default:
      return 'source'
  }
}
