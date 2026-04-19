import dagre from 'dagre'
import { Position } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import type { ThreadEdge, ThreadNode } from '@/lib/services/ThreadService'

type NodeData = Record<string, unknown>

const NODE_WIDTH = 280
const NODE_HEIGHT = 100
const DOMAIN_GAP = 200 // Gap between domains
const DOMAIN_HEADER_HEIGHT = 60

interface LayoutOptions {
  nodeWidth?: number
  nodeHeight?: number
  domainGap?: number
  ranksep?: number
  nodesep?: number
  rankdir?: 'TB' | 'LR'
}

/**
 * Applies a swim lane layout to thread nodes.
 * Nodes are organized into columns by domain (Engineering | Manufacturing).
 * Within each domain, nodes are laid out vertically using dagre.
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

  // Group nodes by domain
  const engineeringNodes = nodes.filter((n) => n.domain === 'engineering')
  const manufacturingNodes = nodes.filter((n) => n.domain === 'manufacturing')

  const isHorizontal = rankdir === 'LR'

  // Create dagre graphs for each domain
  const engineeringGraph = new dagre.graphlib.Graph()
  engineeringGraph.setDefaultEdgeLabel(() => ({}))
  engineeringGraph.setGraph({
    rankdir,
    ranksep,
    nodesep,
  })

  const manufacturingGraph = new dagre.graphlib.Graph()
  manufacturingGraph.setDefaultEdgeLabel(() => ({}))
  manufacturingGraph.setGraph({
    rankdir,
    ranksep,
    nodesep,
  })

  // Add nodes to their respective graphs
  engineeringNodes.forEach((node) => {
    engineeringGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  })

  manufacturingNodes.forEach((node) => {
    manufacturingGraph.setNode(node.id, {
      width: nodeWidth,
      height: nodeHeight,
    })
  })

  // Add BOM edges (same-domain) to their respective graphs
  const sameDomainEdges = edges.filter((e) => e.domain === 'same')
  sameDomainEdges.forEach((edge) => {
    const sourceNode = nodes.find((n) => n.id === edge.sourceId)
    if (!sourceNode) return

    if (sourceNode.domain === 'engineering') {
      engineeringGraph.setEdge(edge.sourceId, edge.targetId)
    } else {
      manufacturingGraph.setEdge(edge.sourceId, edge.targetId)
    }
  })

  // Apply dagre layout to each domain
  dagre.layout(engineeringGraph)
  dagre.layout(manufacturingGraph)

  // Calculate domain extent along the swim lane separation axis
  // TB (vertical flow): domains stacked vertically, separated along Y
  // LR (horizontal flow): domains side-by-side, separated along X
  let engineeringExtent = 0

  engineeringNodes.forEach((node) => {
    const pos = engineeringGraph.node(node.id)
    if (pos) {
      if (isHorizontal) {
        // LR: measure max X extent for side-by-side separation
        engineeringExtent = Math.max(engineeringExtent, pos.x + nodeWidth / 2)
      } else {
        // TB: measure max Y extent for vertical stacking
        engineeringExtent = Math.max(engineeringExtent, pos.y + nodeHeight / 2)
      }
    }
  })

  // Offset for the manufacturing domain along the separation axis
  const manufacturingOffset = engineeringExtent + domainGap

  // Handle positions for edge routing
  const sourcePos = isHorizontal ? Position.Right : Position.Bottom
  const targetPos = isHorizontal ? Position.Left : Position.Top

  // Build positioned nodes
  const positionedNodes: Array<Node> = []

  engineeringNodes.forEach((node) => {
    const pos = engineeringGraph.node(node.id)
    if (pos) {
      positionedNodes.push({
        id: node.id,
        type: 'threadNode',
        sourcePosition: sourcePos,
        targetPosition: targetPos,
        position: {
          x: pos.x - nodeWidth / 2,
          y: pos.y - nodeHeight / 2 + DOMAIN_HEADER_HEIGHT,
        },
        data: node as unknown as NodeData,
      })
    }
  })

  manufacturingNodes.forEach((node) => {
    const pos = manufacturingGraph.node(node.id)
    if (pos) {
      positionedNodes.push({
        id: node.id,
        type: 'threadNode',
        sourcePosition: sourcePos,
        targetPosition: targetPos,
        position: {
          x: isHorizontal
            ? pos.x - nodeWidth / 2 + manufacturingOffset
            : pos.x - nodeWidth / 2,
          y: isHorizontal
            ? pos.y - nodeHeight / 2 + DOMAIN_HEADER_HEIGHT
            : pos.y -
              nodeHeight / 2 +
              DOMAIN_HEADER_HEIGHT +
              manufacturingOffset,
        },
        data: node as unknown as NodeData,
      })
    }
  })

  // Build edges with appropriate styling
  const positionedEdges: Array<Edge> = edges.map((edge) => ({
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    type: 'smoothstep',
    animated: edge.domain === 'cross',
    style: {
      stroke: edge.domain === 'cross' ? '#f59e0b' : '#94a3b8',
      strokeWidth: edge.domain === 'cross' ? 2 : 1,
      strokeDasharray: edge.domain === 'cross' ? '5,5' : undefined,
    },
    label:
      edge.domain === 'cross'
        ? edge.derivationMethod || 'source'
        : edge.quantity
          ? `qty: ${edge.quantity}`
          : undefined,
    labelStyle: {
      fontSize: 10,
      fontWeight: 500,
      fill: edge.domain === 'cross' ? '#f59e0b' : '#64748b',
    },
    labelBgStyle: {
      fill: 'white',
      fillOpacity: 0.9,
    },
  }))

  return { nodes: positionedNodes, edges: positionedEdges }
}

/**
 * Get the domain bounds for drawing swim lane backgrounds
 */
export function getDomainBounds(
  nodes: Array<Node>,
  nodeWidth: number = NODE_WIDTH,
  _domainGap: number = DOMAIN_GAP,
): {
  engineering: { x: number; width: number; height: number } | null
  manufacturing: { x: number; width: number; height: number } | null
} {
  const engineeringNodes = nodes.filter(
    (n) => (n.data as unknown as ThreadNode).domain === 'engineering',
  )
  const manufacturingNodes = nodes.filter(
    (n) => (n.data as unknown as ThreadNode).domain === 'manufacturing',
  )

  let engineeringBounds = null
  let manufacturingBounds = null

  if (engineeringNodes.length > 0) {
    const minX = Math.min(...engineeringNodes.map((n) => n.position.x))
    const maxX = Math.max(
      ...engineeringNodes.map((n) => n.position.x + nodeWidth),
    )
    const maxY = Math.max(...engineeringNodes.map((n) => n.position.y + 100))

    engineeringBounds = {
      x: minX - 20,
      width: maxX - minX + 40,
      height: maxY + 40,
    }
  }

  if (manufacturingNodes.length > 0) {
    const minX = Math.min(...manufacturingNodes.map((n) => n.position.x))
    const maxX = Math.max(
      ...manufacturingNodes.map((n) => n.position.x + nodeWidth),
    )
    const maxY = Math.max(...manufacturingNodes.map((n) => n.position.y + 100))

    manufacturingBounds = {
      x: minX - 20,
      width: maxX - minX + 40,
      height: maxY + 40,
    }
  }

  return {
    engineering: engineeringBounds,
    manufacturing: manufacturingBounds,
  }
}
