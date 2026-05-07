import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpFromLine,
  ChevronDown,
  Download,
  ExternalLink,
  FolderTree,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Table as TableIcon,
  Trash2,
} from 'lucide-react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import * as dagre from 'dagre'
import { GraphItemNode } from './GraphItemNode'
import { RelationshipEdge } from './RelationshipEdge'
import { AddRelationshipDialog } from './AddRelationshipDialog'
import { NewRelationshipTypeDialog } from './NewRelationshipTypeDialog'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import type { Row } from '@tanstack/react-table'

import type { DataGridColumn } from '@/components/ui/DataGrid'
import type { BOMTreeNode } from '@/components/bom/types'
import type { ColumnDefinition } from '@/components/bom/BomTreeView'
import {
  Badge,
  Button,
  Card,
  CardContent,
  FullscreenGraphWrapper,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { DataGrid } from '@/components/ui/DataGrid'
import { ContextMenuItem } from '@/components/ui/ContextMenu'
import { BomTreeView } from '@/components/bom/BomTreeView'
import { exportBomTreeToCsv } from '@/components/bom/exportBomTree'
import { getItemRoute, getStateBadgeVariant } from '@/components/bom/helpers'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface Relationship {
  id: string
  sourceId: string
  targetId: string
  relationshipType: string
  quantity: string | null
  referenceDesignator: string | null
  findNumber: number | null
  targetItem: {
    id: string
    itemNumber: string
    revision: string
    itemType: string
    name: string
    state: string
  }
}

interface PartRelationshipsPanelProps {
  itemId: string
  itemType: string
  branchId?: string
}

type ViewMode = 'graph' | 'table' | 'bom' | 'where-used'
type DirectionMode = 'all' | 'outgoing' | 'incoming'

// --- Graph cache types ---
interface CachedNode {
  id: string
  type: string
  data: any
  position: { x: number; y: number }
}
interface CachedEdge {
  id: string
  source: string
  target: string
  label?: string
  type: string
  animated?: boolean
  markerEnd?: any
  style?: any
  data: any
}
interface ExpandState {
  upstream: boolean
  downstream: boolean
}
interface FetchedState {
  upstream: boolean
  downstream: boolean
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

// --- Pure graph helpers (defined outside component) ---

/**
 * BFS from rootId through expanded directions, returns set of visible node IDs.
 */
function computeReachableNodes(
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
function computeVisibleGraph(
  rootId: string,
  expandedMap: Map<string, ExpandState>,
  nodeCache: Map<string, CachedNode>,
  edgeCache: Map<string, CachedEdge>,
): { nodes: Array<Node>; edges: Array<Edge> } {
  const visibleIds = computeReachableNodes(rootId, expandedMap, edgeCache)

  const nodes: Array<Node> = []
  for (const id of visibleIds) {
    const cached = nodeCache.get(id)
    if (cached) nodes.push({ ...cached } as Node)
  }

  const edges: Array<Edge> = []
  for (const [, edge] of edgeCache) {
    if (visibleIds.has(edge.source) && visibleIds.has(edge.target)) {
      edges.push({ ...edge } as Edge)
    }
  }

  return { nodes, edges }
}

/**
 * Process raw API response into React Flow nodes and edges.
 * Handles UsageOf swap, parallel offset, and waypoint callback injection.
 */
function processApiResponse(
  data: { nodes: Array<any>; edges: Array<any> },
  stableWaypointChange: (
    edgeId: string,
    waypoint: { x: number; y: number } | undefined,
  ) => void,
): { nodes: Array<CachedNode>; edges: Array<CachedEdge> } {
  const flowEdges: Array<CachedEdge> = data.edges.map((edge: any) => {
    const isUsageEdge = edge.data?.isUsageRelationship === true

    // For UsageOf edges: swap to definition→usage so definition is above
    const source = isUsageEdge ? edge.target : edge.source
    const target = isUsageEdge ? edge.source : edge.target

    return {
      id: edge.id,
      source,
      target,
      label: edge.label,
      type: 'relationship',
      animated: isUsageEdge,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 20,
        height: 20,
        color: isUsageEdge ? '#a855f7' : undefined,
      },
      style: isUsageEdge
        ? { stroke: '#a855f7', strokeDasharray: '5,5' }
        : undefined,
      data: {
        ...edge.data,
        onWaypointChange: stableWaypointChange,
      },
    }
  })

  // Auto-offset parallel edges (same source-target pair)
  const pairGroups = new Map<string, Array<string>>()
  for (const edge of flowEdges) {
    const pairKey = [edge.source, edge.target].sort().join('|')
    if (!pairGroups.has(pairKey)) pairGroups.set(pairKey, [])
    pairGroups.get(pairKey)!.push(edge.id)
  }
  const PARALLEL_STEP = 50
  for (const [, edgeIds] of pairGroups) {
    if (edgeIds.length <= 1) continue
    const totalWidth = (edgeIds.length - 1) * PARALLEL_STEP
    edgeIds.forEach((edgeId, index) => {
      const edge = flowEdges.find((e) => e.id === edgeId)
      if (edge) {
        edge.data = {
          ...edge.data,
          parallelOffset: -totalWidth / 2 + index * PARALLEL_STEP,
        }
      }
    })
  }

  const flowNodes: Array<CachedNode> = data.nodes.map((node: any) => ({
    id: node.id,
    type: node.type,
    data: node.data,
    position: node.position,
  }))

  return { nodes: flowNodes, edges: flowEdges }
}

export function PartRelationshipsPanel({
  itemId,
  branchId,
}: PartRelationshipsPanelProps) {
  const { alert, confirm } = useAlertDialog()
  const [activeView, setActiveView] = useState<ViewMode>('bom')
  const [loading, setLoading] = useState(true)

  // Shared relationship data
  const [relationships, setRelationships] = useState<Array<Relationship>>([])

  // Table view state
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set())
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false)
  const [selectedType, setSelectedType] = useState<string | null>(null)

  // Where-used state
  const [whereUsedData, setWhereUsedData] = useState<
    Array<{
      itemId: string
      itemNumber: string
      revision: string
      name: string
      itemType: string
      state: string
      depth: number
      designName?: string | null
    }>
  >([])
  const [whereUsedLoading, setWhereUsedLoading] = useState(false)

  // Graph view state
  const [graphDepth, setGraphDepth] = useState(1)
  const [graphDirection, setGraphDirection] = useState<DirectionMode>('all')
  const [availableTypes, setAvailableTypes] = useState<Array<string>>([])
  const [selectedGraphTypes, setSelectedGraphTypes] = useState<Array<string>>(
    [],
  )
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [graphNodes, setGraphNodes, onNodesChange] = useNodesState<Node>([])
  const [graphEdges, setGraphEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [graphVersion, setGraphVersion] = useState(0)
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)

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

  // BOM tree view state
  const [bomNodes, setBomNodes] = useState<Array<BOMTreeNode>>([])
  const [expandedBomNodes, setExpandedBomNodes] = useState<Set<string>>(
    new Set(),
  )
  const [bomLoading, setBomLoading] = useState(false)

  const nodeTypes = useMemo(() => ({ itemNode: GraphItemNode }), [])
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
      visible.edges,
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
        const typesParam =
          selectedGraphTypes.length > 0
            ? `&types=${selectedGraphTypes.join(',')}`
            : ''
        const branchParam = branchId ? `&branch=${branchId}` : ''

        const response = await fetch(
          `/api/v1/items/${actualItemId}/graph?depth=1&direction=${apiDirection}${typesParam}${branchParam}`,
        )

        if (!response.ok) {
          throw new Error('Failed to expand node')
        }

        const data = await response.json()
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
          setAvailableTypes((prev) => {
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
      itemId,
      branchId,
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

  // Load relationships
  const loadRelationships = useCallback(async () => {
    try {
      const branchParam = branchId ? `?branch=${branchId}` : ''
      // Fetch relationships AND item details in parallel
      const [relResponse, itemResponse] = await Promise.all([
        fetch(`/api/v1/items/${itemId}/relationships${branchParam}`),
        fetch(`/api/v1/items/${itemId}`),
      ])

      if (relResponse.ok) {
        const json = await relResponse.json()
        const rels = json.data?.relationships ?? []
        setRelationships(rels)
        // Auto-expand all types by default
        const types = new Set<string>(
          rels.map((r: Relationship) => r.relationshipType),
        )

        // Check if item has usageOf relationship or is a definition with usages
        if (itemResponse.ok) {
          const itemJson = await itemResponse.json()
          const item = itemJson.data?.item

          // Case 1: This item IS a usage (has usageOf pointing to definition)
          // Case 2: This item IS a definition (has usages pointing to it)
          if (item?.usageOf || (item?.usageCount && item.usageCount > 0)) {
            types.add('UsageOf')
          }
        }

        setExpandedTypes(types)
        setAvailableTypes(Array.from(types).sort())
      }
    } catch {
      // Failed to load relationships
    } finally {
      setLoading(false)
    }
  }, [itemId, branchId])

  // Load graph data (full reload)
  const loadGraphData = useCallback(async () => {
    setGraphLoading(true)
    setGraphError(null)

    try {
      const typesParam =
        selectedGraphTypes.length > 0
          ? `&types=${selectedGraphTypes.join(',')}`
          : ''
      const branchParam = branchId ? `&branch=${branchId}` : ''
      const response = await fetch(
        `/api/v1/items/${itemId}/graph?depth=${graphDepth}&direction=${graphDirection}${typesParam}${branchParam}`,
      )

      if (!response.ok) {
        throw new Error('Failed to load graph data')
      }

      const data = await response.json()

      // Extract all relationship types from edges (including UsageOf)
      const graphRelTypes = new Set<string>()
      for (const edge of data.edges) {
        if (edge.data?.relationshipType) {
          graphRelTypes.add(edge.data.relationshipType)
        }
      }

      // Merge with existing available types
      setAvailableTypes((prev) => {
        const merged = new Set([...prev, ...graphRelTypes])
        return Array.from(merged).sort()
      })

      // Process response through shared helper
      const { nodes: flowNodes, edges: flowEdges } = processApiResponse(
        data,
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
      const withExpandData = injectExpandDataRef.current(
        flowNodes as Array<Node>,
      )
      const { nodes: layoutedNodes, edges: layoutedEdges } =
        getLayoutedElements(withExpandData, flowEdges as Array<Edge>)

      setGraphNodes(layoutedNodes)
      setGraphEdges(layoutedEdges)
      setGraphVersion((v) => v + 1)
    } catch (err) {
      setGraphError(
        err instanceof Error ? err.message : 'Failed to load graph data',
      )
    } finally {
      setGraphLoading(false)
    }
  }, [
    itemId,
    branchId,
    graphDepth,
    graphDirection,
    selectedGraphTypes,
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

  // Build BOM tree from relationships (outgoing "BOM" type relationships)
  const buildBomTree = useCallback(async () => {
    setBomLoading(true)

    try {
      // Fetch the current item details first
      const itemResponse = await fetch(`/api/v1/items/${itemId}`)
      if (!itemResponse.ok) return
      const { data: currentItem } = await itemResponse.json()

      // Recursive function to build BOM tree
      const buildTreeNode = async (
        id: string,
        itemData: any,
        visitedIds: Set<string>,
      ): Promise<BOMTreeNode> => {
        // Prevent infinite loops
        if (visitedIds.has(id)) {
          return {
            itemId: id,
            itemNumber: itemData.itemNumber,
            name: itemData.name || '',
            revision: itemData.revision,
            state: itemData.state,
            itemType: itemData.itemType,
            designId: itemData.designId,
            children: [],
          }
        }

        visitedIds.add(id)

        // Fetch children (outgoing BOM relationships)
        const bomBranchParam = branchId ? `&branch=${branchId}` : ''
        const relResponse = await fetch(
          `/api/v1/items/${id}/relationships?type=BOM${bomBranchParam}`,
        )
        let children: Array<BOMTreeNode> = []

        if (relResponse.ok) {
          const { data } = await relResponse.json()
          const bomRels = (data?.relationships ?? []).filter(
            (r: Relationship) => r.relationshipType === 'BOM',
          )

          // Build children recursively
          children = await Promise.all(
            bomRels.map(async (rel: Relationship) => {
              const childNode = await buildTreeNode(
                rel.targetItem.id,
                rel.targetItem,
                new Set(visitedIds),
              )
              return {
                ...childNode,
                quantity: rel.quantity ? parseFloat(rel.quantity) : undefined,
                findNumber: rel.findNumber ?? undefined,
                relationshipId: rel.id,
              }
            }),
          )
        }

        return {
          itemId: id,
          itemNumber: itemData.itemNumber,
          name: itemData.name || '',
          revision: itemData.revision,
          state: itemData.state,
          itemType: itemData.itemType,
          designId: itemData.designId,
          children: children.length > 0 ? children : undefined,
        }
      }

      const rootNode = await buildTreeNode(itemId, currentItem, new Set())
      setBomNodes([rootNode])

      // Auto-expand root node
      setExpandedBomNodes(new Set([itemId]))
    } catch {
      // Failed to build BOM tree
    } finally {
      setBomLoading(false)
    }
  }, [itemId, branchId])

  // Initial load
  useEffect(() => {
    loadRelationships()
  }, [loadRelationships])

  // Load view-specific data when tab changes
  const loadWhereUsed = useCallback(async () => {
    setWhereUsedLoading(true)
    try {
      const response = await fetch(`/api/v1/items/${itemId}/where-used`)
      if (response.ok) {
        const data = await response.json()
        setWhereUsedData(data.data?.whereUsed ?? [])
      }
    } catch {
      // Silently fail — panel will show empty state
    } finally {
      setWhereUsedLoading(false)
    }
  }, [itemId])

  useEffect(() => {
    if (activeView === 'graph') {
      loadGraphData()
    } else if (activeView === 'bom' && bomNodes.length === 0) {
      buildBomTree()
    } else if (activeView === 'where-used' && whereUsedData.length === 0) {
      loadWhereUsed()
    }
  }, [
    activeView,
    loadGraphData,
    buildBomTree,
    bomNodes.length,
    loadWhereUsed,
    whereUsedData.length,
  ])

  // Group relationships by type for table view
  const groupedRelationships = useMemo(() => {
    return relationships.reduce(
      (acc, rel) => {
        if (!(rel.relationshipType in acc)) {
          acc[rel.relationshipType] = []
        }
        acc[rel.relationshipType].push(rel)
        return acc
      },
      {} as Record<string, Array<Relationship>>,
    )
  }, [relationships])

  // Table view handlers
  const toggleType = (type: string) => {
    const newExpanded = new Set(expandedTypes)
    if (newExpanded.has(type)) {
      newExpanded.delete(type)
    } else {
      newExpanded.add(type)
    }
    setExpandedTypes(newExpanded)
  }

  const handleAddToExistingType = (type: string) => {
    setSelectedType(type)
    setAddDialogOpen(true)
  }

  const handleAddNewType = () => {
    setSelectedType(null)
    setNewTypeDialogOpen(true)
  }

  const handleRemoveRelationship = (relationshipId: string) => {
    confirm({
      title: 'Remove Relationship',
      description: 'Are you sure you want to remove this relationship?',
      actionLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          const response = await fetch(`/api/v1/relationships/${relationshipId}`, {
            method: 'DELETE',
          })

          if (response.ok) {
            await loadRelationships()
            // Refresh BOM tree if needed
            if (activeView === 'bom') {
              buildBomTree()
            }
          } else {
            alert({
              title: 'Error',
              description: 'Failed to remove relationship',
              variant: 'destructive',
            })
          }
        } catch {
          alert({
            title: 'Error',
            description: 'Failed to remove relationship',
            variant: 'destructive',
          })
        }
      },
    })
  }

  const handleRelationshipAdded = () => {
    loadRelationships()
    setAddDialogOpen(false)
    setNewTypeDialogOpen(false)
    // Refresh BOM tree if on that tab
    if (activeView === 'bom') {
      buildBomTree()
    }
  }

  // Graph view handlers
  const handleGraphTypeToggle = (type: string) => {
    setSelectedGraphTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    )
  }

  const handleBomToggle = (nodeItemId: string) => {
    setExpandedBomNodes((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(nodeItemId)) {
        newSet.delete(nodeItemId)
      } else {
        newSet.add(nodeItemId)
      }
      return newSet
    })
  }

  // Get unique states for filter options
  const stateOptions = useMemo(() => {
    const states = new Set(relationships.map((r) => r.targetItem.state))
    return Array.from(states).map((state) => ({ label: state, value: state }))
  }, [relationships])

  // Get unique item types for filter options
  const itemTypeOptions = useMemo(() => {
    const types = new Set(relationships.map((r) => r.targetItem.itemType))
    return Array.from(types).map((type) => ({ label: type, value: type }))
  }, [relationships])

  // Get URL for relationship row
  const getRowUrl = useCallback((row: Relationship) => {
    const itemTypePlural = row.targetItem.itemType.toLowerCase() + 's'
    return `/${itemTypePlural}/${row.targetItem.id}`
  }, [])

  // Context menu items
  const renderContextMenuItems = useCallback((row: Row<Relationship>) => {
    return (
      <ContextMenuItem
        onClick={() => handleRemoveRelationship(row.original.id)}
        className="text-red-600 focus:text-red-600"
      >
        <Trash2 className="mr-2 h-4 w-4" />
        Remove
      </ContextMenuItem>
    )
  }, [])

  // Table columns
  const columns: Array<DataGridColumn<Relationship>> = useMemo(
    () => [
      {
        id: 'findNumber',
        header: 'Find #',
        accessorFn: (row) => row.findNumber,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'range' as const,
        meta: { width: '70px', align: 'center' as const },
        cell: ({ getValue }) => {
          const value = getValue() as number | null
          return value ?? '-'
        },
      },
      {
        id: 'itemNumber',
        header: 'Item Number',
        accessorFn: (row) => row.targetItem.itemNumber,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text' as const,
        filterPlaceholder: 'Filter item number...',
        cell: ({ row }) => {
          const rel = row.original
          const itemTypePlural = rel.targetItem.itemType.toLowerCase() + 's'
          return (
            <Link
              to={`/${itemTypePlural}/${rel.targetItem.id}` as any}
              className="font-medium text-cyan-600 hover:text-cyan-700 hover:underline flex items-center gap-1"
            >
              {rel.targetItem.itemNumber}
              <ExternalLink className="h-3 w-3" />
            </Link>
          )
        },
      },
      {
        id: 'revision',
        header: 'Rev',
        accessorFn: (row) => row.targetItem.revision,
        enableSorting: true,
        enableFiltering: false,
        meta: { width: '60px', align: 'center' as const },
        cell: ({ getValue }) => (
          <Badge variant="outline" className="text-xs">
            {getValue() as string}
          </Badge>
        ),
      },
      {
        id: 'name',
        header: 'Name',
        accessorFn: (row) => row.targetItem.name,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text' as const,
        filterPlaceholder: 'Filter name...',
        cell: ({ getValue }) => {
          const value = getValue() as string | null
          return (
            <span className="text-slate-600 dark:text-slate-400">
              {value || '-'}
            </span>
          )
        },
      },
      {
        id: 'itemType',
        header: 'Type',
        accessorFn: (row) => row.targetItem.itemType,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect' as const,
        filterOptions: itemTypeOptions,
        meta: { width: '90px' },
        cell: ({ getValue }) => (
          <Badge variant="outline" className="text-xs">
            {getValue() as string}
          </Badge>
        ),
      },
      {
        id: 'state',
        header: 'State',
        accessorFn: (row) => row.targetItem.state,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect' as const,
        filterOptions: stateOptions,
        meta: { width: '100px' },
        cell: ({ getValue }) => {
          const state = getValue() as string
          return (
            <Badge
              variant={state === 'Released' ? 'default' : 'secondary'}
              className="text-xs"
            >
              {state}
            </Badge>
          )
        },
      },
      {
        id: 'quantity',
        header: 'Qty',
        accessorFn: (row) => (row.quantity ? parseFloat(row.quantity) : null),
        enableSorting: true,
        enableFiltering: true,
        filterType: 'range' as const,
        meta: { width: '70px', align: 'right' as const },
        cell: ({ row }) => {
          const qty = row.original.quantity
          return qty ?? '-'
        },
      },
      {
        id: 'referenceDesignator',
        header: 'Ref Designator',
        accessorFn: (row) => row.referenceDesignator,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text' as const,
        filterPlaceholder: 'Filter ref des...',
        cell: ({ getValue }) => {
          const value = getValue() as string | null
          return (
            <span className="font-mono text-sm text-slate-600 dark:text-slate-400">
              {value || '-'}
            </span>
          )
        },
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        enableFiltering: false,
        meta: { width: '50px', align: 'center' as const },
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => handleRemoveRelationship(row.original.id)}
            className="h-8 w-8 p-0"
          >
            <Trash2 className="h-4 w-4 text-red-600" />
          </Button>
        ),
      },
    ],
    [stateOptions, itemTypeOptions],
  )

  const navigate = useNavigate()

  // BOM tree columns
  const bomColumns: Array<ColumnDefinition> = [
    {
      id: 'item',
      label: 'Item',
      width: 'flex-[2] min-w-[200px]',
      renderCell: (node) => (
        <span className="font-medium text-slate-900 dark:text-white truncate">
          {node.itemNumber}
        </span>
      ),
    },
    {
      id: 'name',
      label: 'Name',
      width: 'flex-[2] min-w-[150px]',
      renderCell: (node) => (
        <span className="truncate text-slate-600 dark:text-slate-400">
          {node.name}
        </span>
      ),
    },
    {
      id: 'type',
      label: 'Type',
      width: 'w-20 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <Badge variant="outline" className="text-xs">
          {node.itemType}
        </Badge>
      ),
    },
    {
      id: 'qty',
      label: 'Qty',
      width: 'w-14 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <span className="text-xs text-slate-500">{node.quantity ?? '—'}</span>
      ),
    },
    {
      id: 'findNum',
      label: 'Find #',
      width: 'w-14 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <span className="text-xs text-slate-500">{node.findNumber ?? '—'}</span>
      ),
    },
    {
      id: 'rev',
      label: 'Rev',
      width: 'w-14 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <span className="text-xs text-slate-500">{node.revision}</span>
      ),
    },
    {
      id: 'state',
      label: 'State',
      width: 'w-24 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <Badge variant={getStateBadgeVariant(node.state)} className="text-xs">
          {node.state}
        </Badge>
      ),
    },
  ]

  // BOM tree context menu
  const renderBomContextMenu = (node: BOMTreeNode) => {
    const route = getItemRoute(node.itemType, node.itemId)
    return (
      <ContextMenuItem onClick={() => navigate({ to: route })}>
        <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
        View
      </ContextMenuItem>
    )
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header with count badges */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Relationships
            </h2>
            <Badge variant="outline">
              {relationships.length} relationship
              {relationships.length !== 1 ? 's' : ''}
            </Badge>
            <Badge variant="outline">
              {Object.keys(groupedRelationships).length} type
              {Object.keys(groupedRelationships).length !== 1 ? 's' : ''}
            </Badge>
          </div>
          <Button variant="outline" size="sm" onClick={handleAddNewType}>
            <Plus className="h-4 w-4 mr-1" />
            Add Relationship
          </Button>
        </div>

        {/* View Tabs */}
        <Tabs
          value={activeView}
          onValueChange={(v) => setActiveView(v as ViewMode)}
        >
          <TabsList>
            <TabsTrigger value="bom" className="gap-2">
              <FolderTree className="h-4 w-4" />
              BOM Structure
            </TabsTrigger>
            <TabsTrigger value="graph" className="gap-2">
              <GitBranch className="h-4 w-4" />
              Graph View
            </TabsTrigger>
            <TabsTrigger value="table" className="gap-2">
              <TableIcon className="h-4 w-4" />
              Table View
            </TabsTrigger>
            <TabsTrigger value="where-used" className="gap-2">
              <ArrowUpFromLine className="h-4 w-4" />
              Where Used
            </TabsTrigger>
          </TabsList>

          {/* BOM Structure Tab */}
          <TabsContent value="bom" className="mt-4">
            <Card>
              <CardContent className="pt-6">
                {bomLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                  </div>
                ) : bomNodes.length === 0 ? (
                  <div className="text-center py-8">
                    <FolderTree className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
                    <p className="text-slate-500 dark:text-slate-400">
                      No BOM structure found
                    </p>
                    <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
                      Add BOM relationships to see the hierarchy
                    </p>
                  </div>
                ) : (
                  <>
                    <BomTreeView
                      nodes={bomNodes}
                      expandedNodes={expandedBomNodes}
                      onToggle={handleBomToggle}
                      layout="grid"
                      columns={bomColumns}
                      renderContextMenu={renderBomContextMenu}
                    />
                    <div className="mt-4 flex items-center justify-between">
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        Showing BOM hierarchy with direct children
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            exportBomTreeToCsv(bomNodes, {
                              filename: 'bom-structure',
                            })
                          }
                        >
                          <Download className="h-4 w-4 mr-1" />
                          Export CSV
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={buildBomTree}
                          disabled={bomLoading}
                        >
                          <RefreshCw className="h-4 w-4 mr-1" />
                          Refresh
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Graph View Tab */}
          <TabsContent value="graph" className="mt-4">
            <Card>
              <CardContent className="pt-6">
                {/* Graph Controls */}
                <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-300 dark:border-slate-700">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-slate-600 dark:text-slate-400">
                        Mode:
                      </label>
                      <select
                        value={graphDirection}
                        onChange={(e) =>
                          setGraphDirection(e.target.value as DirectionMode)
                        }
                        disabled={graphLoading}
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
                        value={graphDepth}
                        onChange={(e) =>
                          setGraphDepth(parseInt(e.target.value, 10))
                        }
                        disabled={graphLoading}
                        className="text-sm rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      >
                        <option value={0}>This item only</option>
                        <option value={1}>1 level</option>
                        <option value={2}>2 levels</option>
                        <option value={3}>3 levels</option>
                        <option value={4}>4 levels</option>
                        <option value={5}>5 levels</option>
                      </select>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadGraphData}
                    disabled={graphLoading}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${graphLoading ? 'animate-spin' : ''}`}
                    />
                  </Button>
                </div>

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
                          onClick={() => setSelectedGraphTypes([])}
                          disabled={
                            graphLoading || selectedGraphTypes.length === 0
                          }
                          className="text-xs text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          All
                        </button>
                        <span className="text-xs text-slate-400">|</span>
                        <button
                          type="button"
                          onClick={() => setSelectedGraphTypes(availableTypes)}
                          disabled={
                            graphLoading ||
                            selectedGraphTypes.length === availableTypes.length
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
                          onClick={() => handleGraphTypeToggle(type)}
                          disabled={graphLoading}
                          className={`
                            px-3 py-1 text-xs rounded-full border transition-colors
                            ${
                              selectedGraphTypes.length === 0 ||
                              selectedGraphTypes.includes(type)
                                ? 'bg-cyan-100 dark:bg-cyan-900 border-cyan-500 text-cyan-700 dark:text-cyan-300'
                                : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400'
                            }
                            ${graphLoading ? 'opacity-50 cursor-not-allowed' : 'hover:border-cyan-600 cursor-pointer'}
                          `}
                        >
                          {type}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Graph Display */}
                {graphError ? (
                  <div className="text-center py-8">
                    <p className="text-red-500 dark:text-red-400">
                      {graphError}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={loadGraphData}
                    >
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Retry
                    </Button>
                  </div>
                ) : graphLoading && graphNodes.length === 0 ? (
                  <div className="flex items-center justify-center py-12 text-slate-500">
                    <RefreshCw className="h-6 w-6 animate-spin mr-2" />
                    Loading graph...
                  </div>
                ) : graphNodes.length === 0 ? (
                  <div className="text-center py-8">
                    <GitBranch className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
                    <p className="text-slate-500 dark:text-slate-400">
                      No relationships found
                    </p>
                  </div>
                ) : (
                  <FullscreenGraphWrapper
                    title="Relationship Graph"
                    subtitle={`${graphNodes.length} item${graphNodes.length !== 1 ? 's' : ''}, ${graphEdges.length} relationship${graphEdges.length !== 1 ? 's' : ''}`}
                    inlineHeight="500px"
                    headerControls={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={loadGraphData}
                        disabled={graphLoading}
                      >
                        <RefreshCw
                          className={`h-4 w-4 ${graphLoading ? 'animate-spin' : ''}`}
                        />
                      </Button>
                    }
                    footer={
                      <div className="text-sm text-slate-600 dark:text-slate-400">
                        <p>
                          Showing {graphNodes.length} item
                          {graphNodes.length !== 1 ? 's' : ''} and{' '}
                          {graphEdges.length} relationship
                          {graphEdges.length !== 1 ? 's' : ''}
                        </p>
                        <p className="mt-1 text-xs">
                          Use mouse wheel to zoom, drag to pan. Click item
                          numbers to navigate. Click +/- buttons to expand or
                          collapse neighbors. Drag edge labels to reposition,
                          double-click to reset.
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
                        fitView
                        attributionPosition="bottom-right"
                        minZoom={0.1}
                        maxZoom={2}
                      >
                        <Background color="#aaa" gap={16} />
                        <Controls />
                      </ReactFlow>
                    </div>
                  </FullscreenGraphWrapper>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Table View Tab */}
          <TabsContent value="table" className="mt-4">
            <Card>
              <CardContent className="pt-6">
                {Object.keys(groupedRelationships).length === 0 ? (
                  <div className="text-center py-8">
                    <TableIcon className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
                    <p className="text-slate-500 dark:text-slate-400 mb-4">
                      No relationships yet
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAddNewType}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add First Relationship
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {Object.entries(groupedRelationships).map(
                      ([type, rels]) => (
                        <div
                          key={type}
                          className="border rounded-lg overflow-hidden"
                        >
                          <div className="bg-slate-50 dark:bg-slate-900 px-4 py-3 flex items-center justify-between">
                            <button
                              type="button"
                              onClick={() => toggleType(type)}
                              className="flex items-center gap-2 text-sm font-medium hover:text-cyan-600 transition-colors"
                            >
                              <div
                                className={`chevron-rotate ${expandedTypes.has(type) ? 'chevron-rotate-down' : 'chevron-rotate-right'}`}
                              >
                                <ChevronDown className="h-4 w-4" />
                              </div>
                              {type}
                              <Badge
                                variant="secondary"
                                className="animate-badge-pulse"
                              >
                                {rels.length}
                              </Badge>
                            </button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleAddToExistingType(type)}
                            >
                              <Plus className="h-4 w-4 mr-1" />
                              Add
                            </Button>
                          </div>

                          {expandedTypes.has(type) && (
                            <div className="p-4 tree-expand-enter">
                              <DataGrid
                                data={rels}
                                columns={columns}
                                getRowId={(row) => row.id}
                                enablePagination={rels.length > 10}
                                defaultPageSize={10}
                                enableGlobalFilter={rels.length > 5}
                                enableContextMenu
                                getRowUrl={getRowUrl}
                                renderContextMenuItems={renderContextMenuItems}
                                emptyMessage="No relationships"
                                emptyDescription="Add items to this relationship type"
                                exportFilename={`relationships-${type.toLowerCase()}`}
                              />
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Where Used Tab */}
          <TabsContent value="where-used" className="mt-4">
            <Card>
              <CardContent className="pt-6">
                {whereUsedLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-muted-foreground">
                      Loading where-used data...
                    </span>
                  </div>
                ) : whereUsedData.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    This item is not used in any assemblies.
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground mb-4">
                      Found in {whereUsedData.length} parent assembl
                      {whereUsedData.length === 1 ? 'y' : 'ies'}
                    </p>
                    <div className="border rounded-md">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b bg-muted/50">
                            <th className="text-left p-3 font-medium">
                              Item Number
                            </th>
                            <th className="text-left p-3 font-medium">Name</th>
                            <th className="text-left p-3 font-medium">Type</th>
                            <th className="text-left p-3 font-medium">Rev</th>
                            <th className="text-left p-3 font-medium">State</th>
                            <th className="text-left p-3 font-medium">Depth</th>
                            <th className="text-left p-3 font-medium">
                              Design
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {whereUsedData.map((node) => (
                            <tr
                              key={`${node.itemId}-${node.depth}`}
                              className="border-b last:border-b-0 hover:bg-muted/30"
                            >
                              <td className="p-3">
                                <Link
                                  to={getItemRoute(node.itemType, node.itemId)}
                                  className="text-blue-600 hover:underline font-mono text-xs"
                                >
                                  {node.itemNumber}
                                </Link>
                              </td>
                              <td className="p-3">{node.name}</td>
                              <td className="p-3">
                                <Badge variant="outline">{node.itemType}</Badge>
                              </td>
                              <td className="p-3 font-mono text-xs">
                                {node.revision}
                              </td>
                              <td className="p-3">
                                <Badge
                                  variant={getStateBadgeVariant(node.state)}
                                >
                                  {node.state}
                                </Badge>
                              </td>
                              <td className="p-3 text-muted-foreground">
                                {node.depth}
                              </td>
                              <td className="p-3 text-muted-foreground text-xs">
                                {node.designName ?? '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialogs */}
      {addDialogOpen && selectedType && (
        <AddRelationshipDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          itemId={itemId}
          relationshipType={selectedType}
          onSuccess={handleRelationshipAdded}
        />
      )}

      {newTypeDialogOpen && (
        <NewRelationshipTypeDialog
          open={newTypeDialogOpen}
          onOpenChange={setNewTypeDialogOpen}
          itemId={itemId}
          onSuccess={handleRelationshipAdded}
        />
      )}
    </>
  )
}
