import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertCircle, Loader2 } from 'lucide-react'
import { DesignHeaderNode } from './DesignHeaderNode'
import type { Edge, Node } from '@xyflow/react'
import type {
  CommitGraphEdge,
  ProgramCommitGraphNode,
  ProgramCommitNodeData,
  ProgramGraphData,
  ProgramGraphResponse,
} from '@/lib/versioning/graph-types'
import type { MainHeadNodeType } from '@/components/versioning/MainHeadNode'
import { FullscreenGraphWrapper } from '@/components/ui'
import { CommitNode } from '@/components/versioning/CommitNode'
import { MainHeadNode } from '@/components/versioning/MainHeadNode'
import { SharedForkEdge } from '@/components/versioning/SharedForkEdge'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  computeBranchColumns,
  computeDagrePositions,
} from '@/components/versioning/graph-layout'
import { apiFetch } from '@/lib/api/client'

interface ProgramHistoryGraphViewProps {
  programId: string
  /** Optional list of design IDs to filter. Shows all if not provided. */
  designIds?: Array<string>
}

const nodeTypes = {
  commitNode: CommitNode,
  designHeader: DesignHeaderNode,
  mainHeadNode: MainHeadNode,
}

const edgeTypes = {
  sharedFork: SharedForkEdge,
}

// Layout constants
const BRANCH_COLUMN_WIDTH = 300 // Increased for better spacing
const DESIGN_COLUMN_GAP = 120 // Gap between design columns
const DESIGN_HEADER_HEIGHT = 80 // Space for design header
const HEAD_NODE_HEIGHT = 40 // Height of the main head node
const HEAD_NODE_WIDTH = 100
const HEAD_NODE_TOP_MARGIN = 60 // Space between HEAD node and topmost commit
// Total vertical offset: header + HEAD node + margins
const VERTICAL_OFFSET =
  DESIGN_HEADER_HEIGHT + HEAD_NODE_HEIGHT + HEAD_NODE_TOP_MARGIN

/**
 * Layout commits for a program-level view with multiple design columns.
 *
 * Strategy:
 * 1. Group commits by design
 * 2. First pass: count branches per design to calculate column widths
 * 3. For each design, use dagre to compute vertical (y) positions
 * 4. Assign horizontal (x) positions with cumulative offset based on actual branch count
 * 5. Offset y positions to account for design header
 */
function layoutProgramGraph(
  nodes: Array<ProgramCommitGraphNode>,
  edges: Array<CommitGraphEdge>,
  designs: Array<{ id: string; code: string; columnIndex?: number }>,
): Array<ProgramCommitGraphNode> {
  if (nodes.length === 0) return []

  // Group nodes by design
  const nodesByDesign = new Map<string, Array<ProgramCommitGraphNode>>()
  for (const node of nodes) {
    const designId = node.data.designId
    const existing = nodesByDesign.get(designId) || []
    existing.push(node)
    nodesByDesign.set(designId, existing)
  }

  // Sort designs by columnIndex for consistent ordering
  const sortedDesigns = [...designs].sort(
    (a, b) => (a.columnIndex ?? 0) - (b.columnIndex ?? 0),
  )

  // First pass: calculate actual max column per design using branch column logic
  const maxColumnByDesign = new Map<string, number>()

  for (const design of sortedDesigns) {
    const designNodes = nodesByDesign.get(design.id) || []
    if (designNodes.length === 0) {
      maxColumnByDesign.set(design.id, 1)
      continue
    }

    const designNodeIds = new Set(designNodes.map((n) => n.id))
    const designEdges = edges.filter(
      (e) => designNodeIds.has(e.source) && designNodeIds.has(e.target),
    )

    const mainBranchId = designNodes.find((n) => n.data.branchType === 'main')
      ?.data.branchId
    if (!mainBranchId) {
      maxColumnByDesign.set(design.id, 1)
      continue
    }

    // Use shared branch column computation to find max column
    const dagreGraph = computeDagrePositions(
      designNodes,
      designEdges,
      NODE_WIDTH,
      NODE_HEIGHT,
      { ranksep: 120, nodesep: 80 },
    )
    const { maxColumn } = computeBranchColumns(
      designNodes,
      designEdges,
      mainBranchId,
      dagreGraph,
    )
    maxColumnByDesign.set(design.id, maxColumn + 1)
  }

  // Calculate cumulative X offsets for each design
  const designXOffsets = new Map<string, number>()
  let cumulativeX = 0
  for (const design of sortedDesigns) {
    designXOffsets.set(design.id, cumulativeX)
    const columnCount = maxColumnByDesign.get(design.id) || 1
    cumulativeX += columnCount * BRANCH_COLUMN_WIDTH + DESIGN_COLUMN_GAP
  }

  // Layout each design's nodes independently
  const layoutedNodes: Array<ProgramCommitGraphNode> = []

  for (const design of sortedDesigns) {
    const designNodes = nodesByDesign.get(design.id) || []
    if (designNodes.length === 0) continue

    const designNodeIds = new Set(designNodes.map((n) => n.id))
    const designEdges = edges.filter(
      (e) => designNodeIds.has(e.source) && designNodeIds.has(e.target),
    )

    const mainBranchId = designNodes.find((n) => n.data.branchType === 'main')
      ?.data.branchId

    // Use shared dagre + branch column computation
    const dagreGraph = computeDagrePositions(
      designNodes,
      designEdges,
      NODE_WIDTH,
      NODE_HEIGHT,
      { ranksep: 120, nodesep: 80 },
    )

    let branchColumnMap: Map<string, number>
    if (mainBranchId) {
      const result = computeBranchColumns(
        designNodes,
        designEdges,
        mainBranchId,
        dagreGraph,
      )
      branchColumnMap = result.branchColumn
    } else {
      branchColumnMap = new Map()
    }

    const designXOffset = designXOffsets.get(design.id) || 0

    for (const node of designNodes) {
      const dagrePos = dagreGraph.node(node.id)
      const branchCol = branchColumnMap.get(node.data.branchId) || 0

      layoutedNodes.push({
        ...node,
        position: {
          x: designXOffset + branchCol * BRANCH_COLUMN_WIDTH,
          y: dagrePos.y - NODE_HEIGHT / 2 + VERTICAL_OFFSET,
        },
      })
    }
  }

  return layoutedNodes
}

function ProgramHistoryGraphViewInner({
  programId,
  designIds,
}: ProgramHistoryGraphViewProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [graphData, setGraphData] = useState<ProgramGraphData | null>(null)

  // Fetch graph data
  useEffect(() => {
    async function fetchGraph() {
      setLoading(true)
      setError(null)

      try {
        const params = new URLSearchParams()
        if (designIds && designIds.length > 0) {
          params.set('designIds', designIds.join(','))
        }
        params.set('limit', '50')

        const response = await apiFetch<ProgramGraphResponse>(
          `/api/programs/${programId}/history/graph?${params.toString()}`,
        )

        setGraphData(response.data)
      } catch {
        setError('Failed to load program history graph. Please try again.')
      } finally {
        setLoading(false)
      }
    }

    fetchGraph()
  }, [programId, designIds])

  // Process nodes and edges
  const { nodes, allEdges } = useMemo(() => {
    if (!graphData) return { nodes: [], allEdges: [] }

    // Layout commit nodes
    const layoutedNodes = layoutProgramGraph(
      graphData.nodes,
      graphData.edges,
      graphData.designs,
    )

    // Calculate design column bounds from actual node positions
    const bounds = new Map<
      string,
      { minX: number; maxX: number; minY: number }
    >()
    for (const node of layoutedNodes) {
      const designId = node.data.designId
      const existing = bounds.get(designId)
      if (!existing) {
        bounds.set(designId, {
          minX: node.position.x,
          maxX: node.position.x + NODE_WIDTH,
          minY: node.position.y,
        })
      } else {
        bounds.set(designId, {
          minX: Math.min(existing.minX, node.position.x),
          maxX: Math.max(existing.maxX, node.position.x + NODE_WIDTH),
          minY: Math.min(existing.minY, node.position.y),
        })
      }
    }

    // Create design header nodes positioned above each design column
    const headerNodes: Array<Node> = graphData.designs.map((design) => {
      const designBound = bounds.get(design.id)
      const x = designBound ? designBound.minX : 0
      const width = designBound
        ? designBound.maxX - designBound.minX
        : NODE_WIDTH
      const y = designBound ? designBound.minY - VERTICAL_OFFSET : 0 // Position above commits with room for HEAD nodes

      return {
        id: `header-${design.id}`,
        type: 'designHeader',
        position: { x, y },
        data: {
          designId: design.id,
          designCode: design.code,
          designName: design.name,
          width: Math.max(width, 200),
        },
        draggable: false,
        selectable: false,
      }
    })

    // Create MainHeadNode for each design and edges from HEAD to latest main commit
    const headNodes: Array<MainHeadNodeType> = []
    const headEdges: Array<Edge> = []

    for (const design of graphData.designs) {
      const designNodes = layoutedNodes.filter(
        (n) => n.data.designId === design.id,
      )
      if (designNodes.length === 0) continue

      // Find the main branch for this design
      const mainBranchNodes = designNodes.filter(
        (n) => n.data.branchType === 'main',
      )
      if (mainBranchNodes.length === 0) continue

      // Find the latest (topmost) commit on main branch
      const latestMainNode = mainBranchNodes.reduce(
        (latest, node) =>
          !latest || node.position.y < latest.position.y ? node : latest,
        null as ProgramCommitGraphNode | null,
      )
      if (!latestMainNode) continue

      // Find the topmost non-main node (open ECOs) for this design
      const nonMainNodes = designNodes.filter(
        (n) => n.data.branchType !== 'main',
      )
      const topNonMainY =
        nonMainNodes.length > 0
          ? Math.min(...nonMainNodes.map((n) => n.position.y))
          : null

      // Calculate HEAD position
      const latestMainY = latestMainNode.position.y
      const topY =
        topNonMainY !== null ? Math.min(topNonMainY, latestMainY) : latestMainY

      // Position HEAD at the same vertical level as topmost nodes (or above)
      const headY = topY - HEAD_NODE_TOP_MARGIN

      // Position HEAD centered on main column (which is at latestMainNode.position.x)
      const headX =
        latestMainNode.position.x + (NODE_WIDTH - HEAD_NODE_WIDTH) / 2

      const headNodeId = `main-head-${design.id}`
      headNodes.push({
        id: headNodeId,
        type: 'mainHeadNode',
        position: { x: headX, y: headY },
        data: { label: 'main' },
      })

      // Create edge from HEAD to latest main commit
      headEdges.push({
        id: `${headNodeId}-${latestMainNode.id}`,
        source: headNodeId,
        target: latestMainNode.id,
        type: 'straight',
        style: { stroke: '#64748b', strokeWidth: 2 },
      })
    }

    // Build node-to-branch lookup for shared fork edge detection
    const nodeToBranch = new Map<string, string>()
    layoutedNodes.forEach((n) => nodeToBranch.set(n.id, n.data.branchId))

    // Identify cross-branch parent edges that share a fork point (per design)
    const forkPointBranches = new Map<string, Set<string>>()
    graphData.edges.forEach((edge) => {
      if (edge.data?.edgeType === 'parent') {
        const sourceBranch = nodeToBranch.get(edge.source)
        const targetBranch = nodeToBranch.get(edge.target)
        if (sourceBranch && targetBranch && sourceBranch !== targetBranch) {
          if (!forkPointBranches.has(edge.source)) {
            forkPointBranches.set(edge.source, new Set())
          }
          forkPointBranches.get(edge.source)!.add(targetBranch)
        }
      }
    })

    // Style edges with SharedForkEdge detection
    const styledEdges: Array<Edge> = graphData.edges.map((edge) => {
      const sourceBranch = nodeToBranch.get(edge.source)
      const targetBranch = nodeToBranch.get(edge.target)
      const isCrossBranch =
        edge.data?.edgeType === 'parent' &&
        sourceBranch &&
        targetBranch &&
        sourceBranch !== targetBranch
      const isSharedFork =
        isCrossBranch && (forkPointBranches.get(edge.source)?.size ?? 0) >= 2

      // Determine edge type
      let edgeType: string
      if (edge.data?.edgeType === 'merge') {
        edgeType = 'smoothstep'
      } else if (isSharedFork) {
        edgeType = 'sharedFork'
      } else {
        edgeType = 'step'
      }

      return {
        ...edge,
        source: edge.target, // Swap for BT visual flow
        target: edge.source,
        type: edgeType,
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
      }
    })

    // Combine all edges (connector edges no longer used - each design shows its own synthetic ECO node)
    const combinedEdges = [...styledEdges, ...headEdges]

    // Combine all nodes: headers, head nodes, and commit nodes
    const allNodes = [...headerNodes, ...headNodes, ...layoutedNodes]

    return { nodes: allNodes, allEdges: combinedEdges }
  }, [graphData])

  // Get minimap node color based on branch type
  const getMinimapNodeColor = useCallback((node: Node) => {
    // Design header nodes are blue
    if (node.type === 'designHeader') {
      return '#3b82f6' // blue
    }
    // Main HEAD nodes are green
    if (node.type === 'mainHeadNode') {
      return '#22c55e' // green
    }
    const branchType = (node.data as ProgramCommitNodeData).branchType
    switch (branchType) {
      case 'main':
        return '#22c55e' // green
      case 'eco':
        return '#f97316' // orange
      case 'workspace':
        return '#3b82f6' // blue
      case 'release':
        return '#a855f7' // purple
      default:
        return '#94a3b8' // slate
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[500px] bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-300 dark:border-slate-800">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          <p className="text-sm text-slate-500">Loading program history...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[500px] bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-300 dark:border-slate-800">
        <div className="flex flex-col items-center gap-3 text-center px-4">
          <AlertCircle className="h-8 w-8 text-amber-500" />
          <p className="text-sm text-slate-600 dark:text-slate-400">{error}</p>
        </div>
      </div>
    )
  }

  if (!graphData || nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-[500px] bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-300 dark:border-slate-800">
        <div className="flex flex-col items-center gap-3 text-center px-4">
          <p className="text-slate-500 dark:text-slate-400">No commits yet</p>
          <p className="text-sm text-slate-400 dark:text-slate-500">
            Commits will appear here once changes are made to designs in this
            program
          </p>
        </div>
      </div>
    )
  }

  const legend = (
    <div className="flex items-center gap-4 text-xs flex-wrap">
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-green-500" />
        <span className="text-slate-600 dark:text-slate-400">main</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-orange-500" />
        <span className="text-slate-600 dark:text-slate-400">ECO</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-6 h-0.5 bg-slate-400" />
        <span className="text-slate-600 dark:text-slate-400">parent</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div
          className="w-6 h-0.5 bg-orange-500"
          style={{ borderStyle: 'dashed' }}
        />
        <span className="text-slate-600 dark:text-slate-400">merge</span>
      </div>
    </div>
  )

  const crossDesignInfo =
    graphData.crossDesignEcos.length > 0
      ? ` - ${graphData.crossDesignEcos.length} cross-design ECO${graphData.crossDesignEcos.length !== 1 ? 's' : ''}`
      : ''

  // Calculate commit count (exclude header nodes)
  const commitCount = nodes.filter(
    (n) => n.type !== 'designHeader' && n.type !== 'mainHeadNode',
  ).length
  const subtitle = `${graphData.designs.length} design${graphData.designs.length !== 1 ? 's' : ''}, ${commitCount} commit${commitCount !== 1 ? 's' : ''}${crossDesignInfo}`

  return (
    <FullscreenGraphWrapper
      title="Program History"
      subtitle={subtitle}
      inlineHeight="600px"
      footer={legend}
    >
      <div className="h-full rounded-lg border border-slate-300 dark:border-slate-800 overflow-hidden relative">
        <ReactFlow
          nodes={nodes}
          edges={allEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          attributionPosition="bottom-left"
          minZoom={0.15}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          className="bg-slate-50 dark:bg-slate-950"
        >
          <Background color="#94a3b8" gap={20} size={1} />
          <Controls
            showInteractive={false}
            className="!bg-white dark:!bg-slate-800 !border-slate-300 dark:!border-slate-700"
          />
          <MiniMap
            nodeColor={getMinimapNodeColor}
            maskColor="rgba(0, 0, 0, 0.1)"
            className="!bg-white dark:!bg-slate-900 !border-slate-300 dark:!border-slate-700"
          />
        </ReactFlow>
      </div>
    </FullscreenGraphWrapper>
  )
}

// Wrapper component that provides ReactFlow context
export function ProgramHistoryGraphView(props: ProgramHistoryGraphViewProps) {
  return (
    <ReactFlowProvider>
      <ProgramHistoryGraphViewInner {...props} />
    </ReactFlowProvider>
  )
}
