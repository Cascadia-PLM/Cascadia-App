// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { GraphItemNode } from './GraphItemNode'
import type { Edge, Node } from '@xyflow/react'
import { Card, CardContent, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { FullscreenGraphWrapper } from '@/components/ui/FullscreenGraphWrapper'
import { RelationshipEdge } from '@/components/graph/RelationshipEdge'
import { EdgeDirectionLegend } from '@/components/graph/EdgeDirectionLegend'
import {
  USAGE_EDGE_LABEL,
  graphEdgeKind,
  graphEdgeVisuals,
  parallelEdgeOffsets,
  withEdgeDirectionLabels,
} from '@/components/graph/edgeStyles'
import { itemGraphQuery, itemRelationshipsQuery } from '@/lib/query'
import { useTheme } from '@/lib/theme'

interface GraphNavigatorProps {
  itemId: string
  itemType: string
  defaultExpanded?: boolean
  defaultDepth?: number
}

// Dagre graph layout
const getLayoutedElements = (
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

type DirectionMode = 'all' | 'outgoing' | 'incoming'

/** The only field of a relationship row the type chips read. */
interface RelationshipTypeRow {
  relationshipType: string
}

export function GraphNavigator({
  itemId,
  defaultExpanded = false,
  defaultDepth = 2,
}: GraphNavigatorProps) {
  const { theme } = useTheme()
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [depth, setDepth] = useState(defaultDepth)
  const [direction, setDirection] = useState<DirectionMode>('all')
  const [selectedTypes, setSelectedTypes] = useState<Array<string>>([])
  // Types seen only as graph edges — derived INSTANCE_OF/BUILDS links, edges
  // deeper than the direct ring. Accumulated rather than derived from the
  // current answer, so filtering a type out does not remove its own chip.
  const [graphTypesSeen, setGraphTypesSeen] = useState<Array<string>>([])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const nodeTypes = useMemo(() => ({ itemNode: GraphItemNode }), [])
  const edgeTypes = useMemo(() => ({ relationship: RelationshipEdge }), [])

  // UsageOf is not a row in item_relationships — the graph walk synthesises
  // it — so it is filtered out of the `types` param and expressed as
  // `includeUsages` instead. No selection at all means "everything", usages
  // included.
  const regularTypes = useMemo(
    () => selectedTypes.filter((type) => type !== 'UsageOf'),
    [selectedTypes],
  )
  const includeUsages =
    selectedTypes.length === 0 || selectedTypes.includes('UsageOf')

  // Every read below is gated on the panel being open, so a collapsed
  // navigator costs nothing; re-opening it within staleTime is served from
  // the cache rather than refetched.
  const graphQuery = useQuery(
    itemGraphQuery(
      itemId,
      { depth, direction, types: regularTypes, includeUsages },
      isExpanded,
    ),
  )
  const loading = graphQuery.isPending || graphQuery.isFetching
  const error = graphQuery.error
    ? graphQuery.error.message || 'Failed to load graph data'
    : null

  // The item's own edges, for the chips — the same cache entry the
  // relationship table reads, not a second fetch of it.
  const relationshipsQuery = useQuery(
    itemRelationshipsQuery<RelationshipTypeRow>(itemId, {}, isExpanded),
  )

  // A depth-1 walk with usages forced on, purely to answer whether a UsageOf
  // chip belongs on screen at all: the main query cannot answer that once the
  // user has filtered usages away. It collapses onto the main query's cache
  // entry whenever the two happen to ask for the same thing.
  const usageProbeQuery = useQuery(
    itemGraphQuery(itemId, { depth: 1, includeUsages: true }, isExpanded),
  )

  const ownTypes = useMemo(() => {
    const types = new Set<string>()
    for (const relationship of relationshipsQuery.data ?? []) {
      types.add(relationship.relationshipType)
    }
    const probeEdges = usageProbeQuery.data?.edges ?? []
    if (probeEdges.some((edge) => edge.data?.isUsageRelationship === true)) {
      types.add('UsageOf')
    }
    return types
  }, [relationshipsQuery.data, usageProbeQuery.data])

  const availableTypes = useMemo(
    () => Array.from(new Set([...ownTypes, ...graphTypesSeen])).sort(),
    [ownTypes, graphTypesSeen],
  )

  const graphData = graphQuery.data
  useEffect(() => {
    if (!graphData) return

    // Surface relationship types only present as graph edges so the filter
    // chips cover everything on screen.
    const graphRelTypes = new Set<string>()
    for (const edge of graphData.edges) {
      if (edge.data?.relationshipType) {
        graphRelTypes.add(edge.data.relationshipType)
      }
    }
    if (graphRelTypes.size > 0) {
      setGraphTypesSeen((prev) => {
        const merged = new Set([...prev, ...graphRelTypes])
        return Array.from(merged).sort()
      })
    }

    // Convert to React Flow format with markers
    const flowEdges: Array<Edge> = graphData.edges.map((edge: any) => {
      const isUsageEdge = edge.data?.isUsageRelationship === true
      const visuals = graphEdgeVisuals(graphEdgeKind(edge.data ?? {}))

      // For UsageOf edges: swap to definition→usage so definition is above.
      // The label flips with it ("used by") so the wording still reads the
      // way the arrow points.
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
        data: edge.data,
      }
    })

    // Spread edges that share a node pair so their labels stay readable
    const offsets = parallelEdgeOffsets(flowEdges)
    const spreadEdges = flowEdges.map((edge) => {
      const offset = offsets.get(edge.id)
      return offset === undefined
        ? edge
        : { ...edge, data: { ...edge.data, parallelOffset: offset } }
    })

    const flowNodes: Array<Node> = graphData.nodes.map((node: any) => ({
      id: node.id,
      type: node.type,
      data: node.data,
      position: node.position,
    }))

    // Apply layout
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      flowNodes,
      withEdgeDirectionLabels(flowNodes, spreadEdges),
    )

    setNodes(layoutedNodes)
    setEdges(layoutedEdges)
  }, [graphData, setNodes, setEdges])

  const handleTypeToggle = (type: string) => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    )
  }

  const handleSelectAllTypes = () => {
    setSelectedTypes([])
  }

  const handleDeselectAllTypes = () => {
    setSelectedTypes(availableTypes)
  }

  const handleRefresh = () => {
    void graphQuery.refetch()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 text-lg font-semibold hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="h-5 w-5" />
            ) : (
              <ChevronRight className="h-5 w-5" />
            )}
            <span>Relationship Graph</span>
          </button>
          {isExpanded && (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600 dark:text-slate-400">
                  Mode:
                </label>
                <select
                  value={direction}
                  onChange={(e) =>
                    setDirection(e.target.value as DirectionMode)
                  }
                  disabled={loading}
                  className="text-sm rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value="all">All relationships</option>
                  <option value="outgoing">Uses (outgoing)</option>
                  <option value="incoming">Where-used (incoming)</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600 dark:text-slate-400">
                  Depth:
                </label>
                <select
                  value={depth}
                  onChange={(e) => setDepth(parseInt(e.target.value, 10))}
                  disabled={loading}
                  className="text-sm rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value={1}>1 level</option>
                  <option value={2}>2 levels</option>
                  <option value={3}>3 levels</option>
                  <option value={4}>4 levels</option>
                  <option value={5}>5 levels</option>
                </select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={loading}
              >
                <RefreshCw
                  className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent>
          {/* Relationship Type Filter */}
          {availableTypes.length > 0 && (
            <div className="mb-4 pb-4 border-b border-slate-300 dark:border-slate-700">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Relationship Types:
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSelectAllTypes}
                    disabled={loading || selectedTypes.length === 0}
                    className="text-xs text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    All
                  </button>
                  <span className="text-xs text-slate-400">|</span>
                  <button
                    type="button"
                    onClick={handleDeselectAllTypes}
                    disabled={
                      loading || selectedTypes.length === availableTypes.length
                    }
                    className="text-xs text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {availableTypes.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleTypeToggle(type)}
                    disabled={loading}
                    className={`
                      px-3 py-1 text-xs rounded-full border transition-colors
                      ${
                        selectedTypes.length === 0 ||
                        selectedTypes.includes(type)
                          ? 'bg-cyan-100 dark:bg-cyan-900 border-cyan-500 text-cyan-700 dark:text-cyan-300'
                          : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400'
                      }
                      ${loading ? 'opacity-50 cursor-not-allowed' : 'hover:border-cyan-600 cursor-pointer'}
                    `}
                  >
                    {type}
                  </button>
                ))}
              </div>
              {selectedTypes.length > 0 && (
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                  Showing {availableTypes.length - selectedTypes.length} of{' '}
                  {availableTypes.length} types
                </p>
              )}
            </div>
          )}

          {loading && nodes.length === 0 && (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <RefreshCw className="h-6 w-6 animate-spin mr-2" />
              Loading graph...
            </div>
          )}

          {error && (
            <div className="text-center py-8 text-red-600 dark:text-red-400">
              Error: {error}
            </div>
          )}

          {!loading && !error && nodes.length === 0 && (
            <div className="text-center py-8 text-slate-500">
              No relationships found
            </div>
          )}

          {nodes.length > 0 && (
            <FullscreenGraphWrapper
              title="Relationship Graph"
              subtitle={`${nodes.length} item${nodes.length !== 1 ? 's' : ''}, ${edges.length} relationship${edges.length !== 1 ? 's' : ''}`}
              inlineHeight="600px"
              headerControls={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={loading}
                >
                  <RefreshCw
                    className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                  />
                </Button>
              }
              footer={
                <div className="text-sm text-slate-600 dark:text-slate-400">
                  <p>
                    Showing {nodes.length} item{nodes.length !== 1 ? 's' : ''}{' '}
                    and {edges.length} relationship
                    {edges.length !== 1 ? 's' : ''} (
                    {direction === 'incoming' && 'where-used, '}
                    {direction === 'outgoing' && 'uses, '}
                    {selectedTypes.length > 0 &&
                      `${availableTypes.length - selectedTypes.length} of ${availableTypes.length} types, `}
                    up to {depth} level{depth !== 1 ? 's' : ''} deep)
                  </p>
                  {/* Legend for Definition/Usage */}
                  {availableTypes.includes('UsageOf') &&
                    (selectedTypes.length === 0 ||
                      selectedTypes.includes('UsageOf')) && (
                      <div className="mt-2 flex flex-wrap gap-4 text-xs">
                        <div className="flex items-center gap-1">
                          <span className="inline-block w-4 h-3 border-2 border-dashed border-blue-500 rounded" />
                          <span>Definition</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="inline-block w-4 h-3 border-2 border-dashed border-purple-500 rounded" />
                          <span>Usage</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="inline-block w-6 h-0 border-t-2 border-dashed border-purple-500" />
                          <span className="text-purple-500">→</span>
                          <span>Definition used by usage</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="inline-block w-4 h-3 ring-2 ring-offset-1 ring-amber-400 rounded" />
                          <span>Cross-design</span>
                        </div>
                      </div>
                    )}
                  <div className="mt-2">
                    <EdgeDirectionLegend example="a Part that Satisfies a Requirement points at the Requirement" />
                  </div>
                  <p className="mt-1 text-xs">
                    Use mouse wheel to zoom, drag to pan. Click item numbers to
                    navigate.
                  </p>
                </div>
              }
            >
              <div className="h-full border rounded-lg bg-slate-50 dark:bg-slate-950">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  colorMode={theme}
                  fitView
                  attributionPosition="bottom-right"
                  minZoom={0.1}
                  maxZoom={2}
                >
                  <Background gap={16} />
                  <Controls />
                </ReactFlow>
              </div>
            </FullscreenGraphWrapper>
          )}
        </CardContent>
      )}
    </Card>
  )
}
