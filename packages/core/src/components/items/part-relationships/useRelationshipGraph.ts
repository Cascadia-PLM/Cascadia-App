// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEdgesState, useNodesState } from '@xyflow/react'
import {
  computeReachableNodes,
  computeVisibleGraph,
  getLayoutedElements,
  processApiResponse,
} from './graph-shaping'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import type {
  CachedEdge,
  CachedNode,
  DirectionMode,
  ExpandState,
  FetchedState,
  ItemUsageInfo,
  Relationship,
} from './types'
import { GraphItemNode } from '@/components/items/GraphItemNode'
import { GraphFileNode } from '@/components/items/GraphFileNode'
import { RelationshipEdge } from '@/components/graph/RelationshipEdge'
import { withEdgeDirectionLabels } from '@/components/graph/edgeStyles'
import { itemGraphQuery } from '@/lib/query/options/relationships'

/**
 * The relationship graph: its query, its filters, its React Flow model, and
 * the expand/collapse machinery behind the node handles.
 *
 * **This is a hook and not a component on purpose.** The expansion state lives
 * in four refs — which nodes are open in which direction, which directions
 * have been fetched, and the node/edge caches those answers are computed
 * from. Radix unmounts an inactive `TabsContent`, so a `GraphView` component
 * owning those refs would lose every expansion the moment the user looked at
 * the BOM tab and came back. Keeping them in the panel, which stays mounted
 * across tab switches, is what preserves them.
 *
 * The view that consumes this is pure rendering.
 *
 * **Over the ~400-line guideline, with a named next seam.** The expand/collapse
 * machinery — `getExpandDisplayState`, `handleExpandNodeImpl`,
 * `handleCollapseNodeImpl` and the four caches they read — is about half this
 * file and is independent of the query, the filters and the React Flow model
 * above it. It splits into a `useGraphExpansion` hook the day either half
 * grows again; it has not been split yet only because doing it in the same
 * change as the panel's own split would have made both unreviewable.
 */
export function useRelationshipGraph({
  itemId,
  branchId,
  enabled,
  relationships,
  itemUsage,
}: {
  itemId: string
  branchId: string | undefined
  /** True only while the graph tab is showing — gates the query. */
  enabled: boolean
  /** The centre item's own relationships, for the type filter. */
  relationships: Array<Relationship>
  itemUsage: ItemUsageInfo | undefined
}) {
  const queryClient = useQueryClient()

  // Graph view state
  const [graphDepth, setGraphDepth] = useState(1)
  const [graphDirection, setGraphDirection] = useState<DirectionMode>('all')
  // Relationship types discovered from graph edges, which reach further than
  // the centre item's own relationships
  const [graphTypesSeen, setGraphTypesSeen] = useState<Array<string>>([])
  const [selectedGraphTypes, setSelectedGraphTypes] = useState<Array<string>>(
    [],
  )
  const [graphNodes, setGraphNodes, onNodesChange] = useNodesState<Node>([])
  const [graphEdges, setGraphEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [graphVersion, setGraphVersion] = useState(0)
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)

  const graphQuery = useQuery(
    itemGraphQuery(
      itemId,
      {
        depth: graphDepth,
        direction: graphDirection,
        types: selectedGraphTypes,
        branchId,
        includeFiles: true,
      },
      enabled,
    ),
  )
  const graphLoading = graphQuery.isPending || graphQuery.isFetching
  const graphError = graphQuery.error
    ? graphQuery.error.message || 'Failed to load graph data'
    : null

  // --- Graph cache state ---
  const nodeCacheRef = useRef<Map<string, CachedNode>>(new Map())
  const edgeCacheRef = useRef<Map<string, CachedEdge>>(new Map())
  const expandedMapRef = useRef<Map<string, ExpandState>>(new Map())
  const fetchedDirectionsRef = useRef<Map<string, FetchedState>>(new Map())
  // Ref (not state) so applyVisibleGraph can read it synchronously without stale closures
  const expandingNodeRef = useRef<{
    nodeId: string
    direction: 'upstream' | 'downstream'
  } | null>(null)

  const nodeTypes = useMemo(
    () => ({ itemNode: GraphItemNode, fileNode: GraphFileNode }),
    [],
  )
  const edgeTypes = useMemo(() => ({ relationship: RelationshipEdge }), [])

  // Stable ref for the waypoint change handler to avoid re-creating edges
  const handleEdgeWaypointChange = useCallback(
    (edgeId: string, waypoint: { x: number; y: number } | undefined) => {
      setGraphEdges((edges) =>
        edges.map((edge) =>
          edge.id === edgeId
            ? { ...edge, data: { ...edge.data, waypoint } }
            : edge,
        ),
      )
    },
    [setGraphEdges],
  )

  // Keep a stable ref so edge data doesn't cause re-renders
  const waypointChangeRef = useRef(handleEdgeWaypointChange)
  waypointChangeRef.current = handleEdgeWaypointChange

  const stableWaypointChange = useCallback(
    (edgeId: string, waypoint: { x: number; y: number } | undefined) => {
      waypointChangeRef.current(edgeId, waypoint)
    },
    [],
  )

  // --- Expand/collapse helpers ---

  // Plain function that reads from refs — always current, no stale closures
  const getExpandDisplayState = (
    nodeId: string,
    direction: 'upstream' | 'downstream',
  ): 'expanded' | 'collapsed' | 'leaf' => {
    const exp = expandedMapRef.current.get(nodeId)
    const fetched = fetchedDirectionsRef.current.get(nodeId)
    const isExpanded = exp?.[direction] ?? false
    const wasFetched = fetched?.[direction] ?? false

    if (isExpanded) {
      // Even though it's "expanded", if we fetched and found no neighbors, it's a leaf
      if (wasFetched) {
        let hasNeighbors = false
        for (const [, edge] of edgeCacheRef.current) {
          if (direction === 'downstream' && edge.source === nodeId) {
            hasNeighbors = true
            break
          }
          if (direction === 'upstream' && edge.target === nodeId) {
            hasNeighbors = true
            break
          }
        }
        if (!hasNeighbors) return 'leaf'
      }
      return 'expanded'
    }
    if (wasFetched) {
      // Was fetched but not expanded means either collapsed or leaf
      // Check if any edges connect in this direction
      let hasNeighbors = false
      for (const [, edge] of edgeCacheRef.current) {
        if (direction === 'downstream' && edge.source === nodeId) {
          hasNeighbors = true
          break
        }
        if (direction === 'upstream' && edge.target === nodeId) {
          hasNeighbors = true
          break
        }
      }
      return hasNeighbors ? 'collapsed' : 'leaf'
    }
    return 'collapsed'
  }

  // Placeholder — actual injectExpandData is assigned after stableOnExpand/stableOnCollapse are defined.
  // We use a ref so applyVisibleGraph (defined next) can always call the latest version.
  const injectExpandDataRef = useRef<(nodes: Array<Node>) => Array<Node>>(
    (n) => n,
  )

  const applyVisibleGraph = useCallback(() => {
    const visible = computeVisibleGraph(
      itemId,
      expandedMapRef.current,
      nodeCacheRef.current,
      edgeCacheRef.current,
    )
    const withExpandData = injectExpandDataRef.current(visible.nodes)
    const { nodes: layouted, edges: layoutedEdges } = getLayoutedElements(
      withExpandData,
      withEdgeDirectionLabels(withExpandData, visible.edges),
    )
    setGraphNodes(layouted)
    setGraphEdges(layoutedEdges)
    setGraphVersion((v) => v + 1)
  }, [itemId, setGraphNodes, setGraphEdges])

  // Stable expand handler ref
  const handleExpandNodeImpl = useCallback(
    async (nodeId: string, direction: 'upstream' | 'downstream') => {
      const exp = expandedMapRef.current.get(nodeId)
      const fetched = fetchedDirectionsRef.current.get(nodeId)

      // If already fetched, just toggle expansion and recompute
      if (fetched?.[direction]) {
        expandedMapRef.current.set(nodeId, {
          ...(exp || { upstream: false, downstream: false }),
          [direction]: true,
        })
        applyVisibleGraph()
        return
      }

      // Need to fetch from API — show loading spinner immediately
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
        // Find the actual itemId from the node data
        const cachedNode = nodeCacheRef.current.get(nodeId)
        const actualItemId = cachedNode?.data?.itemId || nodeId

        const apiDirection =
          direction === 'downstream' ? 'outgoing' : 'incoming'

        const data = await queryClient.fetchQuery(
          itemGraphQuery(actualItemId, {
            depth: 1,
            direction: apiDirection,
            types: selectedGraphTypes,
            branchId,
            includeFiles: true,
          }),
        )
        const { nodes: newNodes, edges: newEdges } = processApiResponse(
          data,
          stableWaypointChange,
        )

        // Merge into caches (don't overwrite existing nodes)
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

        // Mark this node as expanded + fetched
        expandedMapRef.current.set(nodeId, {
          ...(exp || { upstream: false, downstream: false }),
          [direction]: true,
        })
        fetchedDirectionsRef.current.set(nodeId, {
          ...(fetched || { upstream: false, downstream: false }),
          [direction]: true,
        })

        // Initialize newly added nodes as collapsed (not expanded, not fetched)
        for (const node of newNodes) {
          if (!expandedMapRef.current.has(node.id)) {
            expandedMapRef.current.set(node.id, {
              upstream: false,
              downstream: false,
            })
          }
          if (!fetchedDirectionsRef.current.has(node.id)) {
            fetchedDirectionsRef.current.set(node.id, {
              upstream: false,
              downstream: false,
            })
          }
        }

        // Update available types from new edges
        const newRelTypes = new Set<string>()
        for (const edge of newEdges) {
          if (edge.data?.relationshipType) {
            newRelTypes.add(edge.data.relationshipType)
          }
        }
        if (newRelTypes.size > 0) {
          setGraphTypesSeen((prev) => {
            const merged = new Set([...prev, ...newRelTypes])
            return Array.from(merged).sort()
          })
        }

        expandingNodeRef.current = null
        applyVisibleGraph()
      } catch {
        // Silently fail - node stays collapsed
        expandingNodeRef.current = null
        // Remove loading spinner from the node
        setGraphNodes((nodes) =>
          nodes.map((node) => ({
            ...node,
            data: { ...node.data, expandingDirection: null },
          })),
        )
      }
    },
    [
      branchId,
      queryClient,
      selectedGraphTypes,
      stableWaypointChange,
      applyVisibleGraph,
      setGraphNodes,
    ],
  )

  const handleCollapseNodeImpl = useCallback(
    (nodeId: string, direction: 'upstream' | 'downstream') => {
      const exp = expandedMapRef.current.get(nodeId)
      if (!exp) return

      // Set this node's direction to collapsed
      expandedMapRef.current.set(nodeId, {
        ...exp,
        [direction]: false,
      })

      // Cascade: clear expanded state for nodes that become unreachable
      const reachable = computeReachableNodes(
        itemId,
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
    [itemId, applyVisibleGraph],
  )

  // Stable refs for callbacks passed to nodes
  const expandRef = useRef(handleExpandNodeImpl)
  expandRef.current = handleExpandNodeImpl
  const collapseRef = useRef(handleCollapseNodeImpl)
  collapseRef.current = handleCollapseNodeImpl

  const stableOnExpand = useCallback(
    (nodeId: string, direction: 'upstream' | 'downstream') => {
      expandRef.current(nodeId, direction)
    },
    [],
  )
  const stableOnCollapse = useCallback(
    (nodeId: string, direction: 'upstream' | 'downstream') => {
      collapseRef.current(nodeId, direction)
    },
    [],
  )

  // Now that stableOnExpand/stableOnCollapse exist, wire up the injectExpandData ref.
  // Updated on every render so it always captures current getExpandDisplayState (which reads refs).
  injectExpandDataRef.current = (nodes: Array<Node>): Array<Node> => {
    const expanding = expandingNodeRef.current
    return nodes.map((node) => {
      // File nodes are leaves by construction — no expand/collapse controls
      if (node.type === 'fileNode') return node
      return {
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
      }
    })
  }

  // Types the centre item itself participates in
  const ownRelationshipTypes = useMemo(() => {
    const types = new Set(relationships.map((rel) => rel.relationshipType))
    // Either this item IS a usage (usageOf points at a definition) or it IS a
    // definition with usages pointing back at it.
    if (itemUsage?.usageOf || (itemUsage?.usageCount ?? 0) > 0) {
      types.add('UsageOf')
    }
    return types
  }, [relationships, itemUsage])

  const availableTypes = useMemo(
    () =>
      Array.from(new Set([...ownRelationshipTypes, ...graphTypesSeen])).sort(),
    [ownRelationshipTypes, graphTypesSeen],
  )

  const graphData = graphQuery.data
  useEffect(() => {
    if (!graphData) return

    // Extract all relationship types from edges (including UsageOf)
    const graphRelTypes = new Set<string>()
    for (const edge of graphData.edges) {
      if (edge.data?.relationshipType) {
        graphRelTypes.add(edge.data.relationshipType)
      }
    }

    setGraphTypesSeen((prev) => {
      const merged = new Set([...prev, ...graphRelTypes])
      return Array.from(merged).sort()
    })

    // Process response through shared helper
    const { nodes: flowNodes, edges: flowEdges } = processApiResponse(
      graphData,
      stableWaypointChange,
    )

    // --- Build fresh caches ---
    const newNodeCache = new Map<string, CachedNode>()
    for (const node of flowNodes) {
      newNodeCache.set(node.id, node)
    }
    const newEdgeCache = new Map<string, CachedEdge>()
    for (const edge of flowEdges) {
      newEdgeCache.set(edge.id, edge)
    }

    // Initialize expandedMap from node levels
    const newExpandedMap = new Map<string, ExpandState>()
    const newFetchedDirections = new Map<string, FetchedState>()

    for (const node of flowNodes) {
      const level = node.data?.level ?? 0
      const isInnerNode = level < graphDepth
      // For inner nodes, they were fetched by the full-depth query
      // For frontier nodes (level === graphDepth), they were NOT individually fetched

      if (graphDirection === 'all') {
        newExpandedMap.set(node.id, {
          upstream: isInnerNode,
          downstream: isInnerNode,
        })
        newFetchedDirections.set(node.id, {
          upstream: isInnerNode,
          downstream: isInnerNode,
        })
      } else if (graphDirection === 'outgoing') {
        newExpandedMap.set(node.id, {
          upstream: false,
          downstream: isInnerNode,
        })
        newFetchedDirections.set(node.id, {
          upstream: false,
          downstream: isInnerNode,
        })
      } else {
        // incoming
        newExpandedMap.set(node.id, {
          upstream: isInnerNode,
          downstream: false,
        })
        newFetchedDirections.set(node.id, {
          upstream: isInnerNode,
          downstream: false,
        })
      }
    }

    // Store in refs
    nodeCacheRef.current = newNodeCache
    edgeCacheRef.current = newEdgeCache
    expandedMapRef.current = newExpandedMap
    fetchedDirectionsRef.current = newFetchedDirections
    expandingNodeRef.current = null

    // Inject expand data and apply layout (visible = everything on initial load)
    const withExpandData = injectExpandDataRef.current(flowNodes)
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      withExpandData,
      withEdgeDirectionLabels(withExpandData, flowEdges),
    )

    setGraphNodes(layoutedNodes)
    setGraphEdges(layoutedEdges)
    setGraphVersion((v) => v + 1)
  }, [
    graphData,
    graphDepth,
    graphDirection,
    setGraphNodes,
    setGraphEdges,
    stableWaypointChange,
  ])

  // Fit viewport after graph data changes (depth/direction/type filter changes)
  useEffect(() => {
    if (graphVersion > 0 && reactFlowRef.current) {
      const timer = setTimeout(() => {
        reactFlowRef.current?.fitView({ padding: 0.2 })
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [graphVersion])

  const handleGraphTypeToggle = (type: string) => {
    setSelectedGraphTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    )
  }

  return {
    nodes: graphNodes,
    edges: graphEdges,
    onNodesChange,
    onEdgesChange,
    nodeTypes,
    edgeTypes,
    reactFlowRef,
    loading: graphLoading,
    error: graphError,
    refetch: () => void graphQuery.refetch(),
    depth: graphDepth,
    setDepth: setGraphDepth,
    direction: graphDirection,
    setDirection: setGraphDirection,
    availableTypes,
    selectedTypes: selectedGraphTypes,
    toggleType: handleGraphTypeToggle,
    clearTypes: () => {
      setSelectedGraphTypes([])
    },
    selectAllTypes: () => {
      setSelectedGraphTypes(availableTypes)
    },
  }
}
