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
import { CommitNode } from './CommitNode'
import { MainHeadNode } from './MainHeadNode'
import { SharedForkEdge } from './SharedForkEdge'
import { NODE_WIDTH, layoutCommitGraph } from './graph-layout'
import type { MainHeadNodeType } from './MainHeadNode'
import type { Node } from '@xyflow/react'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type {
  CommitGraphData,
  CommitGraphNode,
  CommitGraphResponse,
} from '@/lib/versioning/graph-types'
import { FullscreenGraphWrapper } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

// ID for the main HEAD pseudo-node
const MAIN_HEAD_NODE_ID = 'main-head'

interface CommitGraphViewProps {
  designId: string
  branchId?: string
  onViewHistoricalState: (context: VersionContext) => void
}

const nodeTypes = {
  commitNode: CommitNode,
  mainHeadNode: MainHeadNode,
}

const edgeTypes = {
  sharedFork: SharedForkEdge,
}

// Layout constants (import shared ones, define component-specific ones)
const HEAD_NODE_WIDTH = 100
const HEAD_NODE_TOP_MARGIN = 80 // Space above the HEAD node

function CommitGraphViewInner({
  designId,
  branchId,
  onViewHistoricalState,
}: CommitGraphViewProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [graphData, setGraphData] = useState<CommitGraphData | null>(null)

  // Fetch graph data
  useEffect(() => {
    async function fetchGraph() {
      setLoading(true)
      setError(null)

      try {
        const params = new URLSearchParams()
        if (branchId) {
          params.set('branchId', branchId)
        }
        params.set('limit', '50')

        const response = await apiFetch<CommitGraphResponse>(
          `/api/designs/${designId}/history/graph?${params.toString()}`,
        )

        setGraphData(response.data)
      } catch {
        setError('Failed to load commit graph. Please try again.')
      } finally {
        setLoading(false)
      }
    }

    fetchGraph()
  }, [designId, branchId])

  // Handle commit click
  const handleCommitClick = useCallback(
    (commitId: string) => {
      onViewHistoricalState({
        type: 'commit',
        commitId,
      })
    },
    [onViewHistoricalState],
  )

  // Process nodes and edges
  const { nodes, edges } = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [] }

    // Add click handler to node data
    const nodesWithHandlers: Array<CommitGraphNode> = graphData.nodes.map(
      (node) => ({
        ...node,
        data: {
          ...node.data,
          onViewCommit: handleCommitClick,
        },
      }),
    )

    // Layout nodes using original edges (before source/target swap)
    const layoutedNodes = layoutCommitGraph(
      nodesWithHandlers,
      graphData.edges,
      graphData.mainBranchId,
    )

    // Find the latest (topmost) commit on main branch to connect HEAD node
    const mainBranchNodes = layoutedNodes.filter(
      (node) => node.data.branchId === graphData.mainBranchId,
    )
    const latestMainNode = mainBranchNodes.reduce(
      (latest, node) =>
        !latest || node.position.y < latest.position.y ? node : latest,
      null as CommitGraphNode | null,
    )

    // Find the topmost (minimum Y) position among non-main branch nodes (open ECOs)
    const nonMainNodes = layoutedNodes.filter(
      (node) => node.data.branchId !== graphData.mainBranchId,
    )
    const topNonMainY =
      nonMainNodes.length > 0
        ? Math.min(...nonMainNodes.map((n) => n.position.y))
        : null

    // Calculate HEAD position: place it at the top of the main branch column
    // aligned with the topmost nodes so ECOs visually branch from main
    const latestMainY = latestMainNode?.position.y ?? 0
    const topY =
      topNonMainY !== null ? Math.min(topNonMainY, latestMainY) : latestMainY

    // Position HEAD at the same vertical level as topmost nodes (or slightly above)
    // This creates the visual of main extending up alongside open ECOs
    const headY = topY - HEAD_NODE_TOP_MARGIN

    // Position HEAD on the main branch column (x=0), centered on node width
    // This creates the visual of main line extending upward
    const headX = (NODE_WIDTH - HEAD_NODE_WIDTH) / 2 // Center on main column

    const headNode: MainHeadNodeType = {
      id: MAIN_HEAD_NODE_ID,
      type: 'mainHeadNode',
      position: {
        x: headX,
        y: headY,
      },
      data: {
        label: 'main',
      },
    }

    // Build node lookup for cross-branch edge detection
    const nodeToBranch = new Map<string, string>()
    layoutedNodes.forEach((n) => nodeToBranch.set(n.id, n.data.branchId))

    // Identify cross-branch parent edges (fork-to-ECO edges) that share a fork point
    const forkPointBranches = new Map<string, Set<string>>()
    graphData.edges.forEach((edge) => {
      if (edge.data?.edgeType === 'parent') {
        const sourceBranch = nodeToBranch.get(edge.source)
        const targetBranch = nodeToBranch.get(edge.target)
        if (sourceBranch && targetBranch && sourceBranch !== targetBranch) {
          // This is a cross-branch parent edge (fork point is edge.source)
          if (!forkPointBranches.has(edge.source)) {
            forkPointBranches.set(edge.source, new Set())
          }
          forkPointBranches.get(edge.source)!.add(targetBranch)
        }
      }
    })

    // Style edges - use 'sharedFork' for cross-branch edges from shared fork points
    const styledEdges = graphData.edges.map((edge) => {
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
        edgeType = 'sharedFork' // Custom edge for shared fork points
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

    // Create edge from HEAD to latest main commit (no swap - edge goes from HEAD down to commit)
    if (latestMainNode) {
      styledEdges.push({
        id: `${MAIN_HEAD_NODE_ID}-${latestMainNode.id}`,
        source: MAIN_HEAD_NODE_ID,
        target: latestMainNode.id,
        type: 'straight',
        style: { stroke: '#64748b', strokeWidth: 2 },
      } as (typeof styledEdges)[number])
    }

    // Combine commit nodes with the HEAD node
    const allNodes: Array<CommitGraphNode | MainHeadNodeType> = [
      headNode,
      ...layoutedNodes,
    ]

    return { nodes: allNodes, edges: styledEdges }
  }, [graphData, handleCommitClick])

  // Get minimap node color based on branch type
  const getMinimapNodeColor = useCallback((node: Node) => {
    // Handle HEAD node
    if (node.id === MAIN_HEAD_NODE_ID) {
      return '#22c55e' // green for main HEAD
    }
    const branchType = (node.data as CommitGraphNode['data']).branchType
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
          <p className="text-sm text-slate-500">Loading commit graph...</p>
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
            Commits will appear here once changes are made
          </p>
        </div>
      </div>
    )
  }

  const legend = (
    <div className="flex items-center gap-4 text-xs">
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-green-500" />
        <span className="text-slate-600 dark:text-slate-400">main</span>
      </div>
      {branchId && graphData.selectedBranchName && (
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-orange-500" />
          <span className="text-slate-600 dark:text-slate-400">
            {graphData.selectedBranchName}
          </span>
        </div>
      )}
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

  // Count actual commits (not the HEAD node)
  const commitCount = graphData.nodes.length

  return (
    <FullscreenGraphWrapper
      title="Design History"
      subtitle={`${commitCount} commit${commitCount !== 1 ? 's' : ''}`}
      inlineHeight="600px"
      footer={legend}
    >
      <div className="h-full rounded-lg border border-slate-300 dark:border-slate-800 overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          attributionPosition="bottom-left"
          minZoom={0.25}
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
export function CommitGraphView(props: CommitGraphViewProps) {
  return (
    <ReactFlowProvider>
      <CommitGraphViewInner {...props} />
    </ReactFlowProvider>
  )
}
