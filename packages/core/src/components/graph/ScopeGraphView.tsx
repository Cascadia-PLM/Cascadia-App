// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import * as dagre from 'dagre'
import { GitBranch, RefreshCw } from 'lucide-react'
import { GraphScopeNode } from './GraphScopeNode'
import { RelationshipEdge } from './RelationshipEdge'
import { EdgeDirectionLegend } from './EdgeDirectionLegend'
import {
  USAGE_EDGE_LABEL,
  graphEdgeKind,
  graphEdgeVisuals,
  parallelEdgeOffsets,
  withEdgeDirectionLabels,
} from './edgeStyles'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import type { NodeExpandState } from './GraphExpandButton'
import { GraphItemNode } from '@/components/items/GraphItemNode'
import { GraphFileNode } from '@/components/items/GraphFileNode'
import { Button, FullscreenGraphWrapper } from '@/components/ui'
import { useTheme } from '@/lib/theme'
import {
  designScopeGraphQuery,
  itemGraphQuery,
  programScopeGraphQuery,
} from '@/lib/query'

/**
 * ScopeGraphView — drill-down graph over the organizational hierarchy:
 *
 *   Program → Designs → Items (Parts, Requirements, Documents, …)
 *           → related items (Work Instructions, Work Orders, Physical Parts, …)
 *
 * Rooted at a Program or a Design. Every node expands step by step:
 * program/design nodes through the scope graph endpoints, item nodes through
 * the existing item relationship graph endpoint — so the item-level portion
 * behaves exactly like the Graph View on a Part's Relationships tab.
 */

type ExpandDir = 'upstream' | 'downstream'
type NodeKind = 'program' | 'design' | 'item'

interface ScopeNodeData {
  [key: string]: unknown
  kind?: 'program' | 'design'
  entityId?: string
  itemId?: string
  itemType?: string
  level?: number
  expandState?: NodeExpandState
  expandingDirection?: ExpandDir | null
  onExpand?: (nodeId: string, direction: ExpandDir) => void
  onCollapse?: (nodeId: string, direction: ExpandDir) => void
}

interface CachedNode {
  id: string
  type: string
  data: ScopeNodeData
  position: { x: number; y: number }
}

interface CachedEdge {
  id: string
  source: string
  target: string
  label?: string
  type: string
  animated?: boolean
  markerEnd?: Edge['markerEnd']
  style?: Edge['style']
  data: Record<string, unknown>
}

interface DirectionState {
  upstream: boolean
  downstream: boolean
}

interface ItemTypeCount {
  itemType: string
  count: number
}

interface ScopeApiResponse {
  nodes: Array<{
    id: string
    type: string
    data: ScopeNodeData
    position: { x: number; y: number }
  }>
  edges: Array<{
    id: string
    source: string
    target: string
    label?: string
    data: Record<string, unknown>
  }>
  availableItemTypes: Array<ItemTypeCount>
}

interface ItemGraphApiResponse {
  nodes: Array<{
    id: string
    type: string
    data: ScopeNodeData
    position: { x: number; y: number }
  }>
  edges: Array<{
    id: string
    source: string
    target: string
    label?: string
    data: {
      isUsageRelationship?: boolean
      isPhysicalRelationship?: boolean
      isFileRelationship?: boolean
      [key: string]: unknown
    }
  }>
}

interface ScopeGraphViewProps {
  rootType: 'program' | 'design'
  rootId: string
  /** Title shown in the fullscreen dialog header */
  title?: string
  inlineHeight?: string
}

// Dagre graph layout (same geometry as the item relationship graphs)
const getLayoutedElements = (nodes: Array<Node>, edges: Array<Edge>) => {
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  const nodeWidth = 280
  const nodeHeight = 120

  dagreGraph.setGraph({
    rankdir: 'TB',
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

/** BFS from rootId through expanded directions → set of visible node IDs. */
function computeReachableNodes(
  rootId: string,
  expandedMap: Map<string, DirectionState>,
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

/** Compute the visible subset of nodes and edges from caches + expandedMap. */
function computeVisibleGraph(
  rootId: string,
  expandedMap: Map<string, DirectionState>,
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

/** Convert a scope endpoint response into cached nodes/edges. */
function processScopeResponse(data: ScopeApiResponse): {
  nodes: Array<CachedNode>
  edges: Array<CachedEdge>
} {
  const nodes: Array<CachedNode> = data.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    data: node.data,
    position: node.position,
  }))

  const edges: Array<CachedEdge> = data.edges.map((edge) => {
    const visuals = graphEdgeVisuals(graphEdgeKind(edge.data))
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: 'relationship',
      markerEnd: visuals.markerEnd,
      style: visuals.style,
      data: edge.data,
    }
  })

  return { nodes, edges }
}

/**
 * Convert an item graph endpoint response into cached nodes/edges.
 * Mirrors the Part relationship graph: UsageOf edges are swapped so the
 * definition sits above its usages; usage/physical edges get their colors.
 */
function processItemGraphResponse(data: ItemGraphApiResponse): {
  nodes: Array<CachedNode>
  edges: Array<CachedEdge>
} {
  const edges: Array<CachedEdge> = data.edges.map((edge) => {
    const isUsageEdge = edge.data.isUsageRelationship === true
    const visuals = graphEdgeVisuals(graphEdgeKind(edge.data))

    // Flipping a UsageOf edge flips its wording too, so the label still reads
    // in the direction the arrow points (definition "used by" usage).
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

  const nodes: Array<CachedNode> = data.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    data: node.data,
    position: node.position,
  }))

  return { nodes, edges }
}

export function ScopeGraphView({
  rootType,
  rootId,
  title,
  inlineHeight = '600px',
}: ScopeGraphViewProps) {
  const { theme } = useTheme()
  const queryClient = useQueryClient()
  const rootNodeId = `${rootType}:${rootId}`
  const graphTitle =
    title ?? (rootType === 'program' ? 'Program Graph' : 'Design Graph')

  const [availableItemTypes, setAvailableItemTypes] = useState<
    Array<ItemTypeCount>
  >([])
  // Empty selection = show every item type
  const [selectedItemTypes, setSelectedItemTypes] = useState<Array<string>>([])
  const [graphNodes, setGraphNodes, onNodesChange] = useNodesState<Node>([])
  const [graphEdges, setGraphEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [graphVersion, setGraphVersion] = useState(0)
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)

  // The root read. Both factories are declared unconditionally — hooks have to
  // be — and the one that does not match `rootType` stays disabled, so exactly
  // one request is in flight. Keyed under `programs`/`designs`, so a write that
  // names either resource refreshes a mounted graph.
  const isProgramRoot = rootType === 'program'
  const programRootQuery = useQuery(
    programScopeGraphQuery<ScopeApiResponse>(rootId, isProgramRoot),
  )
  const designRootQuery = useQuery(
    designScopeGraphQuery<ScopeApiResponse>(
      rootId,
      { itemTypes: selectedItemTypes },
      !isProgramRoot,
    ),
  )
  const rootQuery = isProgramRoot ? programRootQuery : designRootQuery
  const loading = rootQuery.isPending || rootQuery.isFetching
  const rootError = rootQuery.error
  const error = rootError ? rootError.message || 'Failed to load graph' : null

  // Graph caches: everything ever fetched; visibility derives from expandedMap
  const nodeCacheRef = useRef<Map<string, CachedNode>>(new Map())
  const edgeCacheRef = useRef<Map<string, CachedEdge>>(new Map())
  const expandedMapRef = useRef<Map<string, DirectionState>>(new Map())
  const fetchedMapRef = useRef<Map<string, DirectionState>>(new Map())
  const expandingNodeRef = useRef<{
    nodeId: string
    direction: ExpandDir
  } | null>(null)

  const nodeTypes = useMemo(
    () => ({
      itemNode: GraphItemNode,
      scopeNode: GraphScopeNode,
      fileNode: GraphFileNode,
    }),
    [],
  )
  const edgeTypes = useMemo(() => ({ relationship: RelationshipEdge }), [])

  const getNodeKind = (nodeId: string): NodeKind => {
    const kind = nodeCacheRef.current.get(nodeId)?.data.kind
    return kind === 'program' || kind === 'design' ? kind : 'item'
  }

  // Plain function reading refs — always current, no stale closures
  const getExpandDisplayState = (
    nodeId: string,
    direction: ExpandDir,
  ): 'expanded' | 'collapsed' | 'leaf' => {
    // Programs are the top of the hierarchy — nothing above them
    if (direction === 'upstream' && getNodeKind(nodeId) === 'program') {
      return 'leaf'
    }

    const isExpanded = expandedMapRef.current.get(nodeId)?.[direction] ?? false
    const wasFetched = fetchedMapRef.current.get(nodeId)?.[direction] ?? false

    const hasNeighbors = (): boolean => {
      for (const [, edge] of edgeCacheRef.current) {
        if (direction === 'downstream' && edge.source === nodeId) return true
        if (direction === 'upstream' && edge.target === nodeId) return true
      }
      return false
    }

    if (isExpanded) {
      if (wasFetched && !hasNeighbors()) return 'leaf'
      return 'expanded'
    }
    if (wasFetched) {
      return hasNeighbors() ? 'collapsed' : 'leaf'
    }
    return 'collapsed'
  }

  // Wired below (needs the stable expand/collapse callbacks); ref so
  // applyVisibleGraph always calls the latest version.
  const injectExpandDataRef = useRef<(nodes: Array<Node>) => Array<Node>>(
    (n) => n,
  )

  const applyVisibleGraph = useCallback(() => {
    const visible = computeVisibleGraph(
      rootNodeId,
      expandedMapRef.current,
      nodeCacheRef.current,
      edgeCacheRef.current,
    )
    const withExpandData = injectExpandDataRef.current(visible.nodes)

    // Direction naming and parallel spreading run over the whole visible set,
    // not one API response, so edges spanning two separate expansions still
    // get a readable "A Satisfies B" tooltip and a label that stands clear of
    // its siblings.
    const offsets = parallelEdgeOffsets(visible.edges)
    const spreadEdges = visible.edges.map((edge) => {
      const offset = offsets.get(edge.id)
      return offset === undefined
        ? edge
        : { ...edge, data: { ...edge.data, parallelOffset: offset } }
    })
    const namedEdges = withEdgeDirectionLabels(withExpandData, spreadEdges)

    const { nodes: layouted, edges: layoutedEdges } = getLayoutedElements(
      withExpandData,
      namedEdges,
    )
    setGraphNodes(layouted)
    setGraphEdges(layoutedEdges)
    setGraphVersion((v) => v + 1)
  }, [rootNodeId, setGraphNodes, setGraphEdges])

  const mergeAvailableItemTypes = useCallback(
    (incoming: Array<ItemTypeCount>) => {
      setAvailableItemTypes((prev) => {
        const merged = new Map(prev.map((t) => [t.itemType, t.count]))
        for (const t of incoming) {
          if (!merged.has(t.itemType)) merged.set(t.itemType, t.count)
        }
        return Array.from(merged, ([itemType, count]) => ({
          itemType,
          count,
        })).sort((a, b) => a.itemType.localeCompare(b.itemType))
      })
    },
    [],
  )

  /** The program/design row a scope node was built from. */
  const scopeEntityId = (nodeId: string): string => {
    const entityId = nodeCacheRef.current.get(nodeId)?.data.entityId
    if (!entityId) throw new Error('Scope node carries no entity id')
    return entityId
  }

  /**
   * Fetch the expansion for a node in a direction, returning new graph data.
   *
   * Reads go through the shared cache: re-expanding a node the user collapsed
   * and reopened after a full graph reset costs nothing, and a write that
   * invalidates the resource reaches these entries too.
   */
  const fetchExpansion = useCallback(
    async (
      nodeId: string,
      direction: ExpandDir,
    ): Promise<{ nodes: Array<CachedNode>; edges: Array<CachedEdge> }> => {
      const kind = getNodeKind(nodeId)

      if (kind === 'program') {
        // Upstream is a leaf; only downstream (designs) can be fetched
        const data = await queryClient.fetchQuery(
          programScopeGraphQuery<ScopeApiResponse>(scopeEntityId(nodeId)),
        )
        mergeAvailableItemTypes(data.availableItemTypes)
        return processScopeResponse(data)
      }

      if (kind === 'design') {
        const data = await queryClient.fetchQuery(
          designScopeGraphQuery<ScopeApiResponse>(scopeEntityId(nodeId), {
            direction: direction === 'downstream' ? 'down' : 'up',
            itemTypes: selectedItemTypes,
          }),
        )
        mergeAvailableItemTypes(data.availableItemTypes)
        return processScopeResponse(data)
      }

      // Item node: expand through the item relationship graph endpoint
      // (includeFiles matches the Part relationship graph, so attached vault
      // files hang below their item as leaf nodes)
      const data = await queryClient.fetchQuery(
        itemGraphQuery(nodeId, {
          depth: 1,
          direction: direction === 'downstream' ? 'outgoing' : 'incoming',
          includeFiles: true,
        }),
      )
      return processItemGraphResponse(data)
    },
    [queryClient, selectedItemTypes, mergeAvailableItemTypes],
  )

  const handleExpandNodeImpl = useCallback(
    async (nodeId: string, direction: ExpandDir) => {
      const exp = expandedMapRef.current.get(nodeId)
      const fetched = fetchedMapRef.current.get(nodeId)

      // Already fetched: just toggle expansion and recompute visibility
      if (fetched?.[direction]) {
        expandedMapRef.current.set(nodeId, {
          ...(exp ?? { upstream: false, downstream: false }),
          [direction]: true,
        })
        applyVisibleGraph()
        return
      }

      // Show the loading spinner on the node being expanded
      expandingNodeRef.current = { nodeId, direction }
      setGraphNodes((nodes) =>
        nodes.map((node) => ({
          ...node,
          data: {
            ...node.data,
            expandingDirection: node.id === nodeId ? direction : null,
          },
        })),
      )

      try {
        const { nodes: newNodes, edges: newEdges } = await fetchExpansion(
          nodeId,
          direction,
        )

        // Merge into caches without overwriting what's already there
        for (const node of newNodes) {
          if (!nodeCacheRef.current.has(node.id)) {
            nodeCacheRef.current.set(node.id, node)
          }
        }
        for (const edge of newEdges) {
          if (!edgeCacheRef.current.has(edge.id)) {
            edgeCacheRef.current.set(edge.id, edge)
          }
        }

        expandedMapRef.current.set(nodeId, {
          ...(exp ?? { upstream: false, downstream: false }),
          [direction]: true,
        })
        fetchedMapRef.current.set(nodeId, {
          ...(fetched ?? { upstream: false, downstream: false }),
          [direction]: true,
        })

        // Newly discovered nodes start collapsed and unfetched
        for (const node of newNodes) {
          if (!expandedMapRef.current.has(node.id)) {
            expandedMapRef.current.set(node.id, {
              upstream: false,
              downstream: false,
            })
          }
          if (!fetchedMapRef.current.has(node.id)) {
            fetchedMapRef.current.set(node.id, {
              upstream: false,
              downstream: false,
            })
          }
        }

        expandingNodeRef.current = null
        applyVisibleGraph()
      } catch {
        // Node stays collapsed; clear the spinner
        expandingNodeRef.current = null
        setGraphNodes((nodes) =>
          nodes.map((node) => ({
            ...node,
            data: { ...node.data, expandingDirection: null },
          })),
        )
      }
    },
    [fetchExpansion, applyVisibleGraph, setGraphNodes],
  )

  const handleCollapseNodeImpl = useCallback(
    (nodeId: string, direction: ExpandDir) => {
      const exp = expandedMapRef.current.get(nodeId)
      if (!exp) return

      expandedMapRef.current.set(nodeId, { ...exp, [direction]: false })

      // Cascade: clear expanded state for nodes that became unreachable
      const reachable = computeReachableNodes(
        rootNodeId,
        expandedMapRef.current,
        edgeCacheRef.current,
      )
      for (const [id] of expandedMapRef.current) {
        if (!reachable.has(id)) {
          expandedMapRef.current.set(id, { upstream: false, downstream: false })
        }
      }

      applyVisibleGraph()
    },
    [rootNodeId, applyVisibleGraph],
  )

  // Stable callback identities for node data
  const expandRef = useRef(handleExpandNodeImpl)
  expandRef.current = handleExpandNodeImpl
  const collapseRef = useRef(handleCollapseNodeImpl)
  collapseRef.current = handleCollapseNodeImpl

  const stableOnExpand = useCallback((nodeId: string, direction: ExpandDir) => {
    void expandRef.current(nodeId, direction)
  }, [])
  const stableOnCollapse = useCallback(
    (nodeId: string, direction: ExpandDir) => {
      collapseRef.current(nodeId, direction)
    },
    [],
  )

  // Reassigned every render so it always sees current refs and callbacks
  injectExpandDataRef.current = (nodes: Array<Node>): Array<Node> => {
    const expanding = expandingNodeRef.current
    return nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        expandState: {
          upstream: getExpandDisplayState(node.id, 'upstream'),
          downstream: getExpandDisplayState(node.id, 'downstream'),
        },
        expandingDirection:
          expanding?.nodeId === node.id ? expanding.direction : null,
        onExpand: stableOnExpand,
        onCollapse: stableOnCollapse,
      },
    }))
  }

  // Rebuild the caches from the root read.
  //
  // `selectedItemTypes` is a dependency even though the query supplies the
  // data: for a design root the filter is part of the key, so a toggle brings
  // a different response, but a program's scope graph takes no filter and its
  // response is identical across toggles. The filter still shapes what a
  // *design* expansion returns, so the graph must reset either way rather than
  // keep expansions fetched under the previous filter.
  const rootGraphData = rootQuery.data
  useEffect(() => {
    if (!rootGraphData) return

    const { nodes: flowNodes, edges: flowEdges } =
      processScopeResponse(rootGraphData)

    const newNodeCache = new Map<string, CachedNode>()
    for (const node of flowNodes) newNodeCache.set(node.id, node)
    const newEdgeCache = new Map<string, CachedEdge>()
    for (const edge of flowEdges) newEdgeCache.set(edge.id, edge)

    // The root arrives expanded in both directions; everything else starts
    // collapsed and unfetched.
    const newExpandedMap = new Map<string, DirectionState>()
    const newFetchedMap = new Map<string, DirectionState>()
    for (const node of flowNodes) {
      const isRoot = node.id === rootNodeId
      newExpandedMap.set(node.id, { upstream: isRoot, downstream: isRoot })
      newFetchedMap.set(node.id, { upstream: isRoot, downstream: isRoot })
    }

    // All four refs land before applyVisibleGraph, which reads every one of
    // them to decide what is visible.
    nodeCacheRef.current = newNodeCache
    edgeCacheRef.current = newEdgeCache
    expandedMapRef.current = newExpandedMap
    fetchedMapRef.current = newFetchedMap
    expandingNodeRef.current = null

    setAvailableItemTypes(
      [...rootGraphData.availableItemTypes].sort((a, b) =>
        a.itemType.localeCompare(b.itemType),
      ),
    )
    applyVisibleGraph()
  }, [rootGraphData, rootNodeId, selectedItemTypes, applyVisibleGraph])

  // Re-fit the viewport after the visible graph changes
  useEffect(() => {
    if (graphVersion > 0 && reactFlowRef.current) {
      const timer = setTimeout(() => {
        void reactFlowRef.current?.fitView({ padding: 0.2 })
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [graphVersion])

  const handleTypeToggle = (type: string) => {
    setSelectedItemTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    )
  }

  return (
    <div>
      {/* Item type filter */}
      {availableItemTypes.length > 0 && (
        <div className="mb-4 pb-4 border-b border-slate-300 dark:border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Item Types:
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {selectedItemTypes.length === 0
                  ? 'Showing all types'
                  : `${selectedItemTypes.length} of ${availableItemTypes.length} types selected`}
              </span>
              <button
                type="button"
                onClick={() => setSelectedItemTypes([])}
                disabled={loading || selectedItemTypes.length === 0}
                className="text-xs text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                All
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {availableItemTypes.map(({ itemType, count }) => (
              <button
                key={itemType}
                type="button"
                onClick={() => handleTypeToggle(itemType)}
                disabled={loading}
                className={`
                  px-3 py-1 text-xs rounded-full border transition-colors
                  ${
                    selectedItemTypes.length === 0 ||
                    selectedItemTypes.includes(itemType)
                      ? 'bg-cyan-100 dark:bg-cyan-900 border-cyan-500 text-cyan-700 dark:text-cyan-300'
                      : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400'
                  }
                  ${loading ? 'opacity-50 cursor-not-allowed' : 'hover:border-cyan-600 cursor-pointer'}
                `}
              >
                {itemType} ({count})
              </button>
            ))}
          </div>
        </div>
      )}

      {/* A failed *refetch* keeps the graph that is already on screen. Every
          expansion the user drilled into lives in the caches above, not in the
          query cache, so swapping in the error pane would throw a hand-built
          drill-down away over a background failure — and its Retry would reset
          those caches again on success. This banner is how the user learns the
          refresh did not land; the pane below still owns the case where there
          is nothing to show. */}
      {error && graphNodes.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
          <p className="text-sm text-red-600 dark:text-red-400">
            {error} — showing the last version that loaded.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void rootQuery.refetch()}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`}
            />
            Retry
          </Button>
        </div>
      )}

      {/* Graph */}
      {error && graphNodes.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-red-500 dark:text-red-400">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void rootQuery.refetch()}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Retry
          </Button>
        </div>
      ) : loading && graphNodes.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-slate-500">
          <RefreshCw className="h-6 w-6 animate-spin mr-2" />
          Loading graph...
        </div>
      ) : graphNodes.length === 0 ? (
        <div className="text-center py-8">
          <GitBranch className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
          <p className="text-slate-500 dark:text-slate-400">Nothing to show</p>
        </div>
      ) : (
        <FullscreenGraphWrapper
          title={graphTitle}
          subtitle={`${graphNodes.length} node${graphNodes.length !== 1 ? 's' : ''}, ${graphEdges.length} connection${graphEdges.length !== 1 ? 's' : ''}`}
          inlineHeight={inlineHeight}
          headerControls={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void rootQuery.refetch()}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              />
            </Button>
          }
          footer={
            <div className="text-sm text-slate-600 dark:text-slate-400">
              <div className="flex flex-wrap gap-4 text-xs">
                <div className="flex items-center gap-1">
                  <span className="inline-block w-4 h-3 rounded border-2 border-indigo-500 bg-indigo-100 dark:bg-indigo-950" />
                  <span>Program</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="inline-block w-4 h-3 rounded border-2 border-violet-500 bg-violet-100 dark:bg-violet-950" />
                  <span>Design</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="inline-block w-4 h-3 rounded border-2 border-slate-400 bg-slate-100 dark:bg-slate-800" />
                  <span>Item</span>
                </div>
              </div>
              <div className="mt-2">
                <EdgeDirectionLegend example="a Part that Satisfies a Requirement points at the Requirement" />
              </div>
              <p className="mt-2 text-xs">
                Click +/− buttons to drill down step by step: program → designs
                → items → related items (work instructions, work orders,
                physical parts, …). Designs show their top-level items; expand
                an item to reveal what sits beneath it. The type filter applies
                when expanding designs. Click a code to open its page.
              </p>
            </div>
          }
        >
          <div className="h-full border rounded-lg bg-slate-50 dark:bg-slate-950">
            <ReactFlow
              nodes={graphNodes}
              edges={graphEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={(instance) => {
                reactFlowRef.current = instance
              }}
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
    </div>
  )
}
