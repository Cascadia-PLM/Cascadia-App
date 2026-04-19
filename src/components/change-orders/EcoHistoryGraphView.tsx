import { useCallback, useEffect, useMemo, useState } from 'react'
import '@xyflow/react/dist/style.css'
import { AlertCircle, GitBranch, Loader2 } from 'lucide-react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type {
  CommitGraphData,
  CommitGraphNode,
} from '@/lib/versioning/graph-types'
import { CommitNode } from '@/components/versioning/CommitNode'
import {
  BRANCH_COLUMN_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  computeDagrePositions,
  computeSimpleBranchColumns,
  styleEdges,
} from '@/components/versioning/graph-layout'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FullscreenGraphWrapper,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface EcoGraphData extends CommitGraphData {
  ecoNumber: string
  ecoName: string
  affectedDesigns: Array<{
    designId: string
    designName: string
    branchId: string
    branchName: string
  }>
}

interface EcoHistoryGraphViewProps {
  changeOrderId: string
}

const nodeTypes = {
  commitNode: CommitNode,
}

/**
 * Layout commit graph with simple branch-aware horizontal positioning
 */
function layoutEcoGraph(
  nodes: Array<CommitGraphNode>,
  edges: Array<{ source: string; target: string }>,
  mainBranchId: string,
): Array<CommitGraphNode> {
  if (nodes.length === 0) return []

  const dagreGraph = computeDagrePositions(
    nodes,
    edges,
    NODE_WIDTH,
    NODE_HEIGHT,
  )
  const branchColumns = computeSimpleBranchColumns(
    nodes,
    mainBranchId,
    dagreGraph,
  )

  return nodes.map((node) => {
    const dagrePos = dagreGraph.node(node.id)
    const column = branchColumns.get(node.data.branchId) ?? 0

    return {
      ...node,
      position: {
        x: column * BRANCH_COLUMN_WIDTH,
        y: dagrePos.y - NODE_HEIGHT / 2,
      },
    }
  })
}

function EcoHistoryGraphViewInner({ changeOrderId }: EcoHistoryGraphViewProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [graphData, setGraphData] = useState<EcoGraphData | null>(null)
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null)

  // Fetch graph data
  useEffect(() => {
    async function fetchGraph() {
      setLoading(true)
      setError(null)

      try {
        const params = new URLSearchParams()
        if (selectedDesignId) {
          params.set('designId', selectedDesignId)
        }
        params.set('limit', '50')

        const response = await apiFetch<{ data: EcoGraphData }>(
          `/api/change-orders/${changeOrderId}/branch-history/graph?${params.toString()}`,
        )

        setGraphData(response.data)

        // Auto-select first design if not selected
        if (!selectedDesignId && response.data.affectedDesigns.length > 0) {
          setSelectedDesignId(response.data.affectedDesigns[0].designId)
        }
      } catch {
        setError('Failed to load ECO history graph. Please try again.')
      } finally {
        setLoading(false)
      }
    }

    fetchGraph()
  }, [changeOrderId, selectedDesignId])

  // Handle commit click (no-op for now, could navigate to commit view)
  const handleCommitClick = useCallback((_commitId: string) => {
    // Could implement viewing historical state if needed
  }, [])

  // Process nodes and edges
  const { nodes, edges } = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [] }

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
    const layoutedNodes = layoutEcoGraph(
      nodesWithHandlers,
      graphData.edges,
      graphData.mainBranchId,
    )

    // Style edges after layout (includes source/target swap for BT visual flow)
    // Eco view uses smoothstep for all edges (parent and merge)
    const styledEdges = styleEdges(graphData.edges, {
      parentEdgeType: 'smoothstep',
    })

    return { nodes: layoutedNodes, edges: styledEdges }
  }, [graphData, handleCommitClick])

  // Get minimap node color
  const getMinimapNodeColor = useCallback((node: Node) => {
    const branchType = (node.data as CommitGraphNode['data']).branchType
    switch (branchType) {
      case 'main':
        return '#22c55e'
      case 'eco':
        return '#f97316'
      case 'workspace':
        return '#3b82f6'
      case 'release':
        return '#a855f7'
      default:
        return '#94a3b8'
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  if (error || !graphData) {
    return (
      <Card className="border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800">
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            <p className="text-amber-700 dark:text-amber-300">
              {error || 'No history data available'}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (graphData.affectedDesigns.length === 0 || nodes.length === 0) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center space-y-3">
            <GitBranch className="h-12 w-12 mx-auto text-slate-400" />
            <h3 className="text-lg font-medium text-slate-900 dark:text-white">
              No ECO Branches
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 max-w-md mx-auto">
              This ECO has not been submitted yet. ECO branches are created when
              the ECO is submitted for review.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const selectedDesign = graphData.affectedDesigns.find(
    (d) => d.designId === selectedDesignId,
  )

  const legend = (
    <div className="flex items-center gap-4 text-xs">
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-green-500" />
        <span className="text-slate-600 dark:text-slate-400">main</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-orange-500" />
        <span className="text-slate-600 dark:text-slate-400">
          {selectedDesign?.branchName || 'ECO branch'}
        </span>
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

  return (
    <div className="space-y-6">
      {/* Design selector if multiple designs */}
      {graphData.affectedDesigns.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Design Selection</CardTitle>
            <CardDescription>
              This ECO affects multiple designs. Select a design to view its
              branch history.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {graphData.affectedDesigns.map((design) => (
                <Button
                  key={design.designId}
                  variant={
                    selectedDesignId === design.designId ? 'default' : 'outline'
                  }
                  onClick={() => setSelectedDesignId(design.designId)}
                >
                  {design.designName}
                  <Badge variant="secondary" className="ml-2">
                    {design.branchName}
                  </Badge>
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Graph */}
      <FullscreenGraphWrapper
        title={`ECO Branch History: ${selectedDesign?.designName || ''}`}
        subtitle={`${nodes.length} commit${nodes.length !== 1 ? 's' : ''}`}
        inlineHeight="600px"
        footer={legend}
      >
        <div className="h-full rounded-lg border border-slate-300 dark:border-slate-800 overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
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
    </div>
  )
}

export function EcoHistoryGraphView(props: EcoHistoryGraphViewProps) {
  return (
    <ReactFlowProvider>
      <EcoHistoryGraphViewInner {...props} />
    </ReactFlowProvider>
  )
}
