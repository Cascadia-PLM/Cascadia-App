// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CheckCircle,
  Eye,
  FolderTree,
  GitBranch,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Table as TableIcon,
  Trash2,
} from 'lucide-react'
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import * as dagre from 'dagre'
import { EcoGraphItemNode } from './EcoGraphItemNode'
import { EcoDesignStructureTree } from './EcoDesignStructureTree'
import { AddToEcoDialog } from './AddToEcoDialog'
import { ParentPropagationDialog } from './ParentPropagationDialog'
import { AddDesignToEcoDialog } from './AddDesignToEcoDialog'
import { AddBomChildToEcoDialog } from './AddBomChildToEcoDialog'
import { BatchAddToEcoDialog } from './BatchAddToEcoDialog'
import type { Edge, Node } from '@xyflow/react'
import type { BOMTreeNode } from './EcoTreeTable'
import type { EcoAffectedItem } from '@/lib/query'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import { useTheme } from '@/lib/theme'
import {
  GRAPH_EDGE_COLORS,
  directionalMarker,
} from '@/components/graph/edgeStyles'
import { getItemDetailPath } from '@/lib/items/item-type-ui'
import {
  changeOrderAffectedItemsQuery,
  changeOrderDesignsQuery,
  changeOrderDetailQuery,
  useInvalidateResources,
} from '@/lib/query'
import {
  Badge,
  Button,
  Card,
  CardContent,
  ContextMenuItem,
  ContextMenuSeparator,
  FullscreenGraphWrapper,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { DataGrid } from '@/components/ui/DataGrid'
import { useLifecyclePhases } from '@/lib/hooks/useLifecyclePhases'

interface EcoAffectedItemsPanelProps {
  changeOrderId: string
  changeOrderState: string
  readOnly?: boolean
}

/** BOM edges between items the ECO does not touch — structural, so they sit
 * a step back from the cyan affected-item edges without washing out. */
const ECO_BOM_EDGE_COLOR = GRAPH_EDGE_COLORS.scope

const actionColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  release: 'success',
  revise: 'default',
  obsolete: 'destructive',
  replace: 'warning',
  add: 'success',
  remove: 'destructive',
  promote: 'warning',
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
  const nodeHeight = 140

  dagreGraph.setGraph({
    rankdir: direction,
    ranksep: 100,
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

export function EcoAffectedItemsPanel({
  changeOrderId,
  changeOrderState,
  readOnly = false,
}: EcoAffectedItemsPanelProps) {
  const { theme } = useTheme()
  const { alert } = useAlertDialog()
  const invalidate = useInvalidateResources()
  const [activeTab, setActiveTab] = useState<'tree' | 'table' | 'graph'>('tree')

  const { data: designScope, isLoading: loadingDesigns } = useQuery(
    changeOrderDesignsQuery(changeOrderId),
  )
  const designs = designScope?.designs ?? []
  const hasRestricted = designScope?.hasRestricted ?? false
  const { data: affectedItems = [], isLoading: loadingAffectedItems } =
    useQuery(changeOrderAffectedItemsQuery(changeOrderId))
  const { data: eco } = useQuery(changeOrderDetailQuery(changeOrderId))
  const loading = loadingDesigns || loadingAffectedItems

  // Dialog states
  const [addToEcoDialogOpen, setAddToEcoDialogOpen] = useState(false)
  const [parentPropagationDialogOpen, setParentPropagationDialogOpen] =
    useState(false)
  const [addDesignDialogOpen, setAddDesignDialogOpen] = useState(false)
  const [addBomChildDialogOpen, setAddBomChildDialogOpen] = useState(false)
  const [batchAddDialogOpen, setBatchAddDialogOpen] = useState(false)
  const [batchSelectedNodes, setBatchSelectedNodes] = useState<
    Array<BOMTreeNode>
  >([])
  const [selectedNode, setSelectedNode] = useState<BOMTreeNode | null>(null)
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null)

  // Graph view state
  const [graphNodes, setGraphNodes, onNodesChange] = useNodesState<Node>([])
  const [graphEdges, setGraphEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [graphLoading, setGraphLoading] = useState(false)

  const nodeTypes = useMemo(() => ({ ecoItemNode: EcoGraphItemNode }), [])

  // Editing stops when the change order's flow has ended - a final state of
  // its Driving workflow, whatever it is called. (The server additionally
  // locks scope once the order leaves its initial state.)
  const { data: coLifecycle } = useLifecyclePhases('ChangeOrder')
  const coStateIsFinal =
    coLifecycle?.states.find((st) => st.id === changeOrderState)?.isFinal ??
    false
  const isEditable = !readOnly && !coStateIsFinal

  // Build graph from design structures (hierarchical BOM view)
  const buildGraph = useCallback(async () => {
    if (designs.length === 0) {
      setGraphNodes([])
      setGraphEdges([])
      return
    }

    setGraphLoading(true)

    try {
      const nodes: Array<Node> = []
      const edges: Array<Edge> = []
      // Track added nodes by masterId (stable across revisions) to prevent duplicates
      // Maps masterId -> nodeId (the actual node ID used in the graph)
      const addedMasterIds = new Map<string, string>()

      // Add ECO node at top
      nodes.push({
        id: changeOrderId,
        type: 'ecoItemNode',
        data: {
          itemId: changeOrderId,
          itemNumber: eco?.itemNumber || 'ECO',
          revision: '-',
          itemType: 'ChangeOrder',
          name: eco?.name || '',
          state: eco?.state || changeOrderState,
          isEco: true,
        },
        position: { x: 0, y: 0 },
      })
      addedMasterIds.set(changeOrderId, changeOrderId)

      // Fetch structure for each design and add to graph
      for (const design of designs) {
        try {
          const response = await apiFetch<{
            data: {
              roots: Array<BOMTreeNode>
              affectedItemIds: Array<string>
            }
          }>(
            `/api/v1/change-orders/${changeOrderId}/designs/${design.designId}/structure`,
          )

          const { roots } = response.data

          // Recursive function to add nodes and edges from BOM tree
          const processNode = (node: BOMTreeNode, parentId: string | null) => {
            // Use masterId for deduplication, fall back to itemId if not available
            const dedupeKey = node.masterId || node.itemId

            // Check if already added (can happen with shared components across designs)
            const existingNodeId = addedMasterIds.get(dedupeKey)
            if (existingNodeId) {
              // Still add edge if parent exists, but target the existing node
              if (parentId) {
                const edgeId = `${parentId}-${existingNodeId}`
                // Only add if this exact edge doesn't already exist
                if (!edges.some((e) => e.id === edgeId)) {
                  edges.push({
                    id: edgeId,
                    source: parentId,
                    target: existingNodeId,
                    type: 'smoothstep',
                    animated: false,
                    style: {
                      stroke: node.isInEco ? '#22d3ee' : ECO_BOM_EDGE_COLOR,
                    },
                    markerEnd: directionalMarker(
                      node.isInEco ? '#22d3ee' : ECO_BOM_EDGE_COLOR,
                    ),
                  })
                }
              }
              return
            }

            // Mark as added using masterId -> itemId mapping
            addedMasterIds.set(dedupeKey, node.itemId)

            // Add node
            nodes.push({
              id: node.itemId,
              type: 'ecoItemNode',
              data: {
                itemId: node.itemId,
                itemNumber: node.itemNumber,
                revision: node.revision,
                itemType: node.itemType,
                name: node.name || '',
                state: node.state,
                isInEco: node.isInEco,
                changeAction: node.changeAction || undefined,
                designCode: node.isExternal ? node.designCode : undefined,
                branchId: design.branchId,
              },
              position: { x: 0, y: 0 },
            })

            // Add edge from parent (or from ECO for root nodes)
            const sourceId = parentId || changeOrderId
            const isAffected = node.isInEco

            edges.push({
              id: `${sourceId}-${node.itemId}`,
              source: sourceId,
              target: node.itemId,
              type: 'smoothstep',
              animated: false,
              label:
                parentId === null && isAffected
                  ? node.changeAction || undefined
                  : undefined,
              style: { stroke: isAffected ? '#22d3ee' : ECO_BOM_EDGE_COLOR },
              labelStyle: {
                fontSize: 10,
                fontWeight: 600,
              },
              // Label background follows React Flow's colorMode theme vars.
              // The arrowhead points parent -> child, so the BOM reads
              // downward even where the layout wraps.
              markerEnd: directionalMarker(
                isAffected ? '#22d3ee' : ECO_BOM_EDGE_COLOR,
              ),
            })

            // Process children
            if (node.children) {
              node.children.forEach((child) => processNode(child, node.itemId))
            }
          }

          // Process all root nodes
          roots.forEach((root) => processNode(root, null))
        } catch {
          // Skip this design's structure if fetch fails
        }
      }

      // Apply layout
      const { nodes: layoutedNodes, edges: layoutedEdges } =
        getLayoutedElements(nodes, edges)
      setGraphNodes(layoutedNodes)
      setGraphEdges(layoutedEdges)
    } catch {
      // Graph build failed - will show empty graph
    } finally {
      setGraphLoading(false)
    }
  }, [
    designs,
    changeOrderId,
    changeOrderState,
    eco,
    setGraphNodes,
    setGraphEdges,
  ])

  // Build graph when switching to graph tab
  useEffect(() => {
    if (
      activeTab === 'graph' &&
      graphNodes.length === 0 &&
      designs.length > 0
    ) {
      buildGraph()
    }
  }, [activeTab, graphNodes.length, designs.length, buildGraph])

  // Handle adding an item to ECO from tree
  const handleAddToEco = async (node: BOMTreeNode, designId: string) => {
    setSelectedNode(node)
    setSelectedDesignId(designId)

    // Check if item has released ancestors that need to be included
    try {
      const response = await apiFetch<{
        data: {
          ancestors: Array<{
            itemId: string
            state: string
          }>
          releasedCount: number
        }
      }>(
        `/api/v1/change-orders/${changeOrderId}/items/${node.itemId}/ancestors?designId=${designId}`,
      )

      if (response.data.releasedCount > 0) {
        // Show parent propagation dialog
        setParentPropagationDialogOpen(true)
      } else {
        // No released parents, show simple add dialog
        setAddToEcoDialogOpen(true)
      }
    } catch {
      // Fall back to simple add dialog on error
      setAddToEcoDialogOpen(true)
    }
  }

  // Handle successful add
  const handleAddSuccess = async () => {
    setAddToEcoDialogOpen(false)
    setParentPropagationDialogOpen(false)
    setAddBomChildDialogOpen(false)
    setSelectedNode(null)
    setSelectedDesignId(null)
    await invalidate('change-orders')
  }

  // Handle adding a BOM child
  const handleAddChild = (node: BOMTreeNode, designId: string) => {
    setSelectedNode(node)
    setSelectedDesignId(designId)
    setAddBomChildDialogOpen(true)
  }

  // Handle batch add to ECO from multi-select
  const handleBatchAddToEco = (
    nodes: Array<BOMTreeNode>,
    _designId: string,
  ) => {
    setBatchSelectedNodes(nodes)
    setBatchAddDialogOpen(true)
  }

  // Handle successful batch add
  const handleBatchAddSuccess = async () => {
    setBatchAddDialogOpen(false)
    setBatchSelectedNodes([])
    await invalidate('change-orders')
  }

  // Handle successful design add
  const handleDesignAdded = async () => {
    setAddDesignDialogOpen(false)
    await invalidate('change-orders')
  }

  // Handle remove affected item
  const handleRemoveItem = async (itemId: string) => {
    try {
      await apiFetch(
        `/api/v1/change-orders/${changeOrderId}/affected-items?itemId=${itemId}`,
        { method: 'DELETE' },
      )

      await invalidate('change-orders')
    } catch (error) {
      alert({
        title: 'Error',
        description: `Failed to remove affected item: ${(error as Error).message}`,
        variant: 'destructive',
      })
    }
  }

  // Table view: enriched data with design info baked in
  type AffectedItemRow = EcoAffectedItem & {
    designCode?: string
  }

  const affectedItemRows = useMemo<Array<AffectedItemRow>>(
    () =>
      affectedItems.map((item) => {
        const design = designs.find(
          (d) => item.affectedItemDetails?.designId === d.designId,
        )
        return {
          ...item,
          designCode: design?.designCode || design?.designName,
        }
      }),
    [affectedItems, designs],
  )

  const affectedItemColumns = useMemo<Array<DataGridColumn<AffectedItemRow>>>(
    () => [
      {
        id: 'itemNumber',
        header: 'Item Number',
        accessorFn: (row) => row.affectedItemDetails?.itemNumber || '(New)',
        enableSorting: true,
        enableFiltering: true,
        cell: ({ getValue }) => (
          <span className="font-medium dark:text-slate-300">
            {getValue() as string}
          </span>
        ),
        meta: { width: '140px' },
      },
      {
        id: 'name',
        header: 'Name',
        accessorFn: (row) => row.affectedItemDetails?.name || '-',
        enableSorting: true,
        enableFiltering: true,
        cell: ({ getValue }) => (
          <span className="text-slate-600 dark:text-slate-300">
            {getValue() as string}
          </span>
        ),
      },
      {
        id: 'itemType',
        header: 'Type',
        accessorFn: (row) => row.affectedItemDetails?.itemType || '-',
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect' as const,
        filterOptions: [
          ...new Set(
            affectedItems
              .map((i) => i.affectedItemDetails?.itemType)
              .filter(Boolean),
          ),
        ].map((t) => ({ label: t!, value: t! })),
        cell: ({ getValue }) => (
          <Badge variant="secondary">{getValue() as string}</Badge>
        ),
        meta: { width: '100px' },
      },
      {
        id: 'design',
        header: 'Design',
        accessorKey: 'designCode',
        enableSorting: true,
        enableFiltering: true,
        cell: ({ getValue }) => {
          const v = getValue() as string | undefined
          return v ? (
            <Badge variant="outline" className="text-xs">
              {v}
            </Badge>
          ) : (
            '-'
          )
        },
        meta: { width: '120px' },
      },
      {
        id: 'changeAction',
        header: 'Action',
        accessorKey: 'changeAction',
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect' as const,
        filterOptions: [
          { label: 'Release', value: 'release' },
          { label: 'Revise', value: 'revise' },
          { label: 'Obsolete', value: 'obsolete' },
          { label: 'Add', value: 'add' },
          { label: 'Remove', value: 'remove' },
        ],
        cell: ({ getValue }) => {
          const action = getValue() as string
          return <Badge variant={actionColors[action]}>{action}</Badge>
        },
        meta: { width: '100px' },
      },
      {
        id: 'current',
        header: 'Current',
        accessorFn: (row) =>
          row.currentState && row.currentRevision
            ? `${row.currentState} ${row.currentRevision}`
            : '-',
        enableSorting: true,
        meta: { width: '100px' },
      },
      {
        id: 'target',
        header: 'Target',
        accessorFn: (row) =>
          row.targetState && row.targetRevision
            ? `${row.targetState} ${row.targetRevision}`
            : row.targetRevision || row.targetState || '-',
        enableSorting: true,
        meta: { width: '100px' },
      },
      {
        id: 'status',
        header: 'Status',
        accessorFn: () => 'OK',
        cell: () => (
          <Badge variant="success">
            <CheckCircle className="h-3 w-3 mr-1" />
            OK
          </Badge>
        ),
        meta: { width: '80px' },
      },
    ],
    [affectedItems],
  )

  // Get count statistics
  const totalAffectedItems = affectedItems.length
  const totalDesigns = designs.length

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/*
        The one thing this notice must not do is stay quiet. A reviewer who
        cannot see that the change order reaches further than their own
        programs will read a short list as the whole change and sign off on
        it. It says that, and nothing else: no count and no program name —
        both would describe a program they have no access to.
      */}
      {hasRestricted && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
          data-testid="eco-restricted-notice"
        >
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This change order affects designs outside your programs. Those
            entries are not shown, and it cannot be submitted or released from
            here. Ask your administrator for access to the other programs this
            change order touches.
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Affected Items
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              {totalDesigns} design{totalDesigns !== 1 ? 's' : ''}
            </Badge>
            <Badge variant="outline">
              {totalAffectedItems} item{totalAffectedItems !== 1 ? 's' : ''}
            </Badge>
          </div>
        </div>
        {isEditable && (
          <Button onClick={() => setAddDesignDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Design
          </Button>
        )}
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'tree' | 'table' | 'graph')}
      >
        <TabsList>
          <TabsTrigger value="tree" className="gap-2">
            <FolderTree className="h-4 w-4" />
            Tree View
          </TabsTrigger>
          <TabsTrigger value="graph" className="gap-2">
            <GitBranch className="h-4 w-4" />
            Graph View
          </TabsTrigger>
          <TabsTrigger value="table" className="gap-2">
            <TableIcon className="h-4 w-4" />
            Table View
          </TabsTrigger>
        </TabsList>

        {/* Tree View Tab */}
        <TabsContent value="tree" className="mt-4">
          {designs.length > 0 ? (
            <div className="space-y-4">
              {designs.map((design) => (
                <EcoDesignStructureTree
                  key={design.designId}
                  designId={design.designId}
                  designName={design.designName}
                  designCode={design.designCode}
                  designType={design.designType}
                  branchId={design.branchId}
                  changeOrderId={changeOrderId}
                  readOnly={!isEditable}
                  onAddToEco={handleAddToEco}
                  onAddChild={isEditable ? handleAddChild : undefined}
                  onBatchAddToEco={isEditable ? handleBatchAddToEco : undefined}
                  onItemsAdded={() => {
                    void invalidate('change-orders')
                  }}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12">
                <div className="text-center text-slate-500 dark:text-slate-400">
                  <FolderTree className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p className="mb-4">
                    No designs are affected by this ECO yet.
                  </p>
                  {isEditable && (
                    <Button onClick={() => setAddDesignDialogOpen(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Design
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Graph View Tab */}
        <TabsContent value="graph" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {graphLoading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="h-6 w-6 animate-spin mr-2 text-slate-400" />
                  <span className="text-slate-500">
                    Loading structure graph...
                  </span>
                </div>
              ) : designs.length === 0 ? (
                <div className="text-center py-8">
                  <GitBranch className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
                  <p className="text-slate-500 dark:text-slate-400">
                    No designs added to this ECO yet
                  </p>
                  <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
                    Add a design to see the BOM structure graph
                  </p>
                </div>
              ) : (
                <FullscreenGraphWrapper
                  title="ECO Affected Items Graph"
                  subtitle={`${graphNodes.length - 1} item${graphNodes.length - 1 !== 1 ? 's' : ''} (${affectedItems.length} affected)`}
                  inlineHeight="600px"
                  headerControls={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={buildGraph}
                      disabled={graphLoading}
                    >
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Refresh
                    </Button>
                  }
                  footer={
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-slate-600 dark:text-slate-400">
                        <span>
                          Showing BOM structure with {graphNodes.length - 1}{' '}
                          item{graphNodes.length - 1 !== 1 ? 's' : ''}
                        </span>
                        <span className="ml-2 text-cyan-600 dark:text-cyan-400">
                          ({affectedItems.length} affected)
                        </span>
                        <span className="ml-2 text-slate-400">
                          • Greyed items are not in ECO
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Use mouse wheel to zoom, drag to pan. Click item numbers
                        to navigate.
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
                      colorMode={theme}
                      fitView
                      attributionPosition="bottom-right"
                      minZoom={0.05}
                      maxZoom={2}
                    >
                      <Background gap={16} />
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
          <DataGrid
            data={affectedItemRows}
            columns={affectedItemColumns}
            getRowId={(row) => row.id!}
            enableSorting
            enableFiltering
            enableGlobalFilter
            enableExport
            exportFilename={`eco-${eco?.itemNumber || changeOrderId}-affected-items`}
            enablePagination={affectedItemRows.length > 25}
            defaultPageSize={25}
            emptyMessage="No affected items yet"
            emptyDescription="Use the Tree View to browse designs and add items to this ECO"
            enableContextMenu
            renderContextMenuItems={(row) => {
              const details = row.original.affectedItemDetails
              const design = details?.designId
                ? designs.find((d) => d.designId === details.designId)
                : undefined
              const branchSuffix = design?.branchId
                ? `?branch=${design.branchId}`
                : ''
              const detailPath = details?.id
                ? getItemDetailPath(details.itemType, details.id)
                : null
              return (
                <>
                  {detailPath && (
                    <ContextMenuItem
                      onClick={() =>
                        window.open(detailPath + branchSuffix, '_blank')
                      }
                    >
                      <Eye className="mr-2 h-4 w-4" />
                      View
                    </ContextMenuItem>
                  )}
                  {isEditable && (
                    <>
                      {details?.id && <ContextMenuSeparator />}
                      <ContextMenuItem
                        className="text-red-600 dark:text-red-400"
                        onClick={() => handleRemoveItem(row.original.id!)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Remove
                      </ContextMenuItem>
                    </>
                  )}
                </>
              )
            }}
          />
        </TabsContent>
      </Tabs>

      {/* Add to ECO Dialog (simple, single item) */}
      {selectedNode && selectedDesignId && (
        <AddToEcoDialog
          open={addToEcoDialogOpen}
          onOpenChange={setAddToEcoDialogOpen}
          changeOrderId={changeOrderId}
          item={selectedNode}
          onSuccess={handleAddSuccess}
        />
      )}

      {/* Parent Propagation Dialog */}
      {selectedNode && selectedDesignId && (
        <ParentPropagationDialog
          open={parentPropagationDialogOpen}
          onOpenChange={setParentPropagationDialogOpen}
          changeOrderId={changeOrderId}
          designId={selectedDesignId}
          targetItem={selectedNode}
          onSuccess={handleAddSuccess}
        />
      )}

      {/* Add Design Dialog */}
      <AddDesignToEcoDialog
        open={addDesignDialogOpen}
        onOpenChange={setAddDesignDialogOpen}
        changeOrderId={changeOrderId}
        existingDesignIds={designs.map((d) => d.designId)}
        onSuccess={handleDesignAdded}
      />

      {/* Add BOM Child Dialog */}
      {selectedNode && selectedDesignId && (
        <AddBomChildToEcoDialog
          open={addBomChildDialogOpen}
          onOpenChange={setAddBomChildDialogOpen}
          ecoId={changeOrderId}
          parentItemId={selectedNode.itemId}
          parentItemNumber={selectedNode.itemNumber}
          currentDesignId={selectedDesignId}
          currentDesignCode={
            designs.find((d) => d.designId === selectedDesignId)?.designCode ||
            designs.find((d) => d.designId === selectedDesignId)?.designName ||
            ''
          }
          onSuccess={handleAddSuccess}
        />
      )}

      {/* Batch Add to ECO Dialog */}
      <BatchAddToEcoDialog
        open={batchAddDialogOpen}
        onOpenChange={setBatchAddDialogOpen}
        changeOrderId={changeOrderId}
        items={batchSelectedNodes}
        onSuccess={handleBatchAddSuccess}
      />
    </div>
  )
}
