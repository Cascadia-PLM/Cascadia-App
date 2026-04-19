import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  Filter,
  Loader2,
  Plus,
  X,
} from 'lucide-react'
import { EcoTreeTable } from './EcoTreeTable'
import { AddPartFromDesignDialog } from './AddPartFromDesignDialog'
import type { BOMTreeNode } from './EcoTreeTable'
import { useTreeSelection } from '@/components/bom/useTreeSelection'
import { Badge, Button, Card, CardContent } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface OrphanItem {
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
  isInEco?: boolean
  changeAction?: string | null
}

interface EcoBranch {
  id: string
  mergeStatus: string
  itemsAffected: number
}

interface StructureResponse {
  data: {
    roots: Array<BOMTreeNode>
    orphans: Array<OrphanItem>
    ecoBranch: EcoBranch | null
    design: {
      id: string
      name: string
      description: string | null
    }
  }
}

interface EcoDesignStructureTreeProps {
  designId: string
  designName: string
  designCode?: string
  designType?: string
  branchId?: string | null
  changeOrderId: string
  readOnly?: boolean
  onAddToEco: (node: BOMTreeNode, designId: string) => void
  onAddChild?: (node: BOMTreeNode, designId: string) => void
  onBatchAddToEco?: (nodes: Array<BOMTreeNode>, designId: string) => void
  onItemsAdded?: () => void
}

export function EcoDesignStructureTree({
  designId,
  designName,
  designCode,
  designType,
  branchId,
  changeOrderId,
  readOnly = false,
  onAddToEco,
  onAddChild,
  onBatchAddToEco,
  onItemsAdded,
}: EcoDesignStructureTreeProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [roots, setRoots] = useState<Array<BOMTreeNode>>([])
  const [orphans, setOrphans] = useState<Array<OrphanItem>>([])
  const [ecoBranch, setEcoBranch] = useState<EcoBranch | null>(null)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [addFromDesignOpen, setAddFromDesignOpen] = useState(false)

  // Column filter state
  const [columnFilters, setColumnFilters] = useState<Record<string, unknown>>(
    {},
  )

  const handleColumnFilterChange = useCallback(
    (columnId: string, value: unknown) => {
      setColumnFilters((prev) => {
        const next = { ...prev }
        // Remove filter if empty
        const isEmpty =
          value === '' ||
          value === undefined ||
          value === null ||
          (Array.isArray(value) && value.length === 0)
        if (isEmpty) {
          delete next[columnId]
        } else {
          next[columnId] = value
        }
        return next
      })
    },
    [],
  )

  const clearAllFilters = useCallback(() => {
    setColumnFilters({})
  }, [])

  const hasActiveFilters = Object.keys(columnFilters).length > 0

  // Selection hook — only eligible items can be selected
  const isEligible = useCallback(
    (node: BOMTreeNode) => !node.isInEco && node.state !== 'Obsolete',
    [],
  )
  const selection = useTreeSelection({ isEligible })

  // Node matching function for filters
  const nodeMatchesFilters = useCallback(
    (
      node: {
        itemNumber: string
        name: string
        revision: string
        state: string
        isInEco?: boolean
        changeAction?: string | null
      },
      filters: Record<string, unknown>,
    ): boolean => {
      for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === null || value === '') continue
        if (Array.isArray(value) && value.length === 0) continue

        switch (key) {
          case 'item': {
            const search = (value as string).toLowerCase()
            if (!node.itemNumber.toLowerCase().includes(search)) return false
            break
          }
          case 'name': {
            const search = (value as string).toLowerCase()
            if (!node.name.toLowerCase().includes(search)) return false
            break
          }
          case 'rev': {
            const search = (value as string).toLowerCase()
            if (!node.revision.toLowerCase().includes(search)) return false
            break
          }
          case 'state': {
            const selected = value as Array<string>
            if (!selected.includes(node.state)) return false
            break
          }
          case 'action': {
            const selected = value as Array<string>
            let matches = false
            for (const s of selected) {
              if (s === '__not_in_eco__') {
                if (!node.isInEco) {
                  matches = true
                  break
                }
              } else if (s === '__in_eco__') {
                if (node.isInEco && !node.changeAction) {
                  matches = true
                  break
                }
              } else {
                if (node.isInEco && node.changeAction === s) {
                  matches = true
                  break
                }
              }
            }
            if (!matches) return false
            break
          }
        }
      }
      return true
    },
    [],
  )

  // Flatten entire tree into a list of leaf-level nodes (no children)
  const flattenTree = useCallback(
    (nodes: Array<BOMTreeNode>): Array<BOMTreeNode> => {
      const result: Array<BOMTreeNode> = []
      const walk = (items: Array<BOMTreeNode>) => {
        for (const node of items) {
          // Push a shallow copy without children so it renders as a flat row
          result.push({ ...node, children: undefined })
          if (node.children?.length) walk(node.children)
        }
      }
      walk(nodes)
      return result
    },
    [],
  )

  // Compute filtered data
  const { filteredRoots, filteredOrphans, filteredResultCount } =
    useMemo(() => {
      if (!hasActiveFilters) {
        return {
          filteredRoots: roots,
          filteredOrphans: orphans,
          filteredResultCount: -1, // sentinel: not filtered
        }
      }

      // Flatten tree and filter
      const allNodes = flattenTree(roots)
      const matchingNodes = allNodes.filter((n) =>
        nodeMatchesFilters(n, columnFilters),
      )

      // Filter orphans too
      const matchingOrphans = orphans.filter((item) =>
        nodeMatchesFilters(
          {
            itemNumber: item.itemNumber,
            name: item.name,
            revision: item.revision,
            state: item.state,
            isInEco: item.isInEco,
            changeAction: item.changeAction,
          },
          columnFilters,
        ),
      )

      return {
        filteredRoots: matchingNodes,
        filteredOrphans: matchingOrphans,
        filteredResultCount: matchingNodes.length + matchingOrphans.length,
      }
    }, [
      roots,
      orphans,
      columnFilters,
      hasActiveFilters,
      flattenTree,
      nodeMatchesFilters,
    ])

  // Update visible nodes whenever roots/expansion/filters change
  useEffect(() => {
    if (filteredRoots.length > 0) {
      selection.setVisibleNodes(
        filteredRoots,
        hasActiveFilters ? new Set() : expandedNodes,
      )
    }
  }, [
    filteredRoots,
    expandedNodes,
    hasActiveFilters,
    selection.setVisibleNodes,
  ])

  // Clear selection when filters change
  useEffect(() => {
    selection.clearSelection()
  }, [columnFilters])

  const fetchStructure = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch<StructureResponse>(
        `/api/change-orders/${changeOrderId}/designs/${designId}/structure`,
      )
      setRoots(response.data.roots)
      setOrphans(response.data.orphans)
      setEcoBranch(response.data.ecoBranch || null)
    } catch {
      setError('Failed to load design structure.')
    } finally {
      setLoading(false)
    }
  }, [changeOrderId, designId])

  useEffect(() => {
    fetchStructure()
  }, [fetchStructure])

  // Toggle node expansion
  const toggleNode = (itemId: string) => {
    if (hasActiveFilters) return // no-op when filtered (flat view)
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) {
        next.delete(itemId)
      } else {
        next.add(itemId)
      }
      return next
    })
  }

  // Expand all nodes
  const expandAll = () => {
    const allIds = new Set<string>()
    const collectIds = (nodes: Array<BOMTreeNode>) => {
      nodes.forEach((node) => {
        if (node.children && node.children.length > 0) {
          allIds.add(node.itemId)
          collectIds(node.children)
        }
      })
    }
    collectIds(roots)
    setExpandedNodes(allIds)
  }

  // Collapse all nodes
  const collapseAll = () => {
    setExpandedNodes(new Set())
  }

  // Expand only the paths needed to reveal affected items
  const showAffectedItems = () => {
    const idsToExpand = new Set<string>()
    const walk = (node: BOMTreeNode, ancestors: Array<string>) => {
      if (node.isInEco) {
        for (const id of ancestors) {
          idsToExpand.add(id)
        }
      }
      if (node.children) {
        for (const child of node.children) {
          walk(child, [...ancestors, node.itemId])
        }
      }
    }
    for (const root of roots) {
      walk(root, [])
    }
    setExpandedNodes(idsToExpand)
  }

  // Handle add to ECO
  const handleAddToEco = (node: BOMTreeNode) => {
    onAddToEco(node, designId)
  }

  // Handle add child
  const handleAddChild = (node: BOMTreeNode) => {
    onAddChild?.(node, designId)
  }

  // Handle batch add
  const handleBatchAdd = () => {
    if (!onBatchAddToEco || selection.selectedCount === 0) return

    // Collect full BOMTreeNode objects for selected IDs
    const selectedNodes: Array<BOMTreeNode> = []
    const collect = (nodes: Array<BOMTreeNode>) => {
      for (const node of nodes) {
        if (selection.selectedIds.has(node.itemId)) {
          selectedNodes.push(node)
        }
        if (node.children) collect(node.children)
      }
    }
    // Search in both filtered roots and original roots (filtered roots are flat copies)
    collect(filteredRoots)

    onBatchAddToEco(selectedNodes, designId)
    selection.clearSelection()
  }

  // Whether to show selection UI
  const showSelection = !readOnly && !!onBatchAddToEco

  // Get state badge variant
  const getStateBadgeVariant = (state: string) => {
    switch (state) {
      case 'Released':
        return 'success' as const
      case 'Draft':
        return 'secondary' as const
      default:
        return 'default' as const
    }
  }

  // Count active filters
  const activeFilterCount = Object.keys(columnFilters).length

  return (
    <Card className="mb-4">
      {/* Design Header */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <button className="p-0.5">
          {isCollapsed ? (
            <ChevronRight className="h-5 w-5 text-slate-500" />
          ) : (
            <ChevronDown className="h-5 w-5 text-slate-500" />
          )}
        </button>
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-lg text-slate-900 dark:text-slate-100">
            {designName || designCode || 'Untitled Design'}
          </h3>
          {designCode && designName && designCode !== designName && (
            <span className="text-sm text-slate-500 dark:text-slate-400">
              ({designCode})
            </span>
          )}
        </div>
        {ecoBranch && (
          <Badge variant="outline" className="text-xs">
            {ecoBranch.itemsAffected} items affected
          </Badge>
        )}
      </div>

      {/* Collapsible content */}
      {!isCollapsed && (
        <CardContent className="pt-0">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : error ? (
            <div className="text-center py-4 text-red-500">{error}</div>
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex items-center justify-between gap-2 mb-4">
                {/* Selection toolbar + filter info (left) */}
                <div className="flex items-center gap-2">
                  {showSelection && selection.selectedCount > 0 && (
                    <>
                      <Badge variant="default" className="text-xs">
                        {selection.selectedCount} selected
                      </Badge>
                      <Button size="sm" onClick={handleBatchAdd}>
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        Add Selected to ECO
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={selection.clearSelection}
                      >
                        <X className="h-3.5 w-3.5 mr-1" />
                        Clear
                      </Button>
                    </>
                  )}
                  {hasActiveFilters && (
                    <>
                      <Badge variant="outline" className="text-xs gap-1">
                        <Filter className="h-3 w-3" />
                        {activeFilterCount}{' '}
                        {activeFilterCount === 1 ? 'filter' : 'filters'} active
                        ({filteredResultCount}{' '}
                        {filteredResultCount === 1 ? 'result' : 'results'})
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={clearAllFilters}
                        className="h-7 px-2 text-xs text-slate-500"
                      >
                        <X className="h-3 w-3 mr-1" />
                        Clear Filters
                      </Button>
                    </>
                  )}
                </div>

                {/* Expand/collapse buttons (right) — hidden when filters active */}
                {!hasActiveFilters && (
                  <div className="flex items-center gap-2">
                    {!readOnly && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAddFromDesignOpen(true)}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        Add Parts
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={showAffectedItems}
                    >
                      <Eye className="h-3.5 w-3.5 mr-1" />
                      Show Affected
                    </Button>
                    <Button variant="outline" size="sm" onClick={expandAll}>
                      Expand All
                    </Button>
                    <Button variant="outline" size="sm" onClick={collapseAll}>
                      Collapse All
                    </Button>
                  </div>
                )}
              </div>

              {/* BOM Tree Table */}
              {filteredRoots.length > 0 ? (
                <EcoTreeTable
                  nodes={filteredRoots}
                  expandedNodes={
                    hasActiveFilters ? new Set<string>() : expandedNodes
                  }
                  onToggle={toggleNode}
                  onAddToEco={handleAddToEco}
                  onAddChild={onAddChild ? handleAddChild : undefined}
                  readOnly={readOnly}
                  branchId={ecoBranch?.id}
                  showCheckboxes={showSelection}
                  selectedIds={selection.selectedIds}
                  onSelectionClick={selection.handleClick}
                  onCheckboxChange={selection.handleCheckboxChange}
                  isItemSelectable={isEligible}
                  onSelectAll={
                    selection.isAllSelected
                      ? selection.clearSelection
                      : selection.selectAll
                  }
                  isAllSelected={selection.isAllSelected}
                  isIndeterminate={selection.isIndeterminate}
                  columnFilters={columnFilters}
                  onColumnFilterChange={handleColumnFilterChange}
                />
              ) : hasActiveFilters ? (
                <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                  <p className="mb-2">No items match the current filters.</p>
                  <Button variant="outline" size="sm" onClick={clearAllFilters}>
                    <X className="h-3.5 w-3.5 mr-1" />
                    Clear Filters
                  </Button>
                </div>
              ) : (
                <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                  No BOM structure found in this design.
                </div>
              )}

              {/* Orphan Items - Documents, Requirements not in BOM */}
              {filteredOrphans.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Other Items (Documents, Requirements)
                  </h4>
                  <div className="border rounded-lg dark:border-slate-700 overflow-hidden">
                    {/* Orphan items header */}
                    <div className="flex items-center h-7 bg-slate-50 dark:bg-slate-800 border-b dark:border-slate-700 px-2 text-xs font-medium text-slate-600 dark:text-slate-400">
                      <div className="flex-[2] min-w-[200px]">Item</div>
                      <div className="flex-[2] min-w-[150px]">Name</div>
                      <div className="w-16 flex-shrink-0 text-center">Rev</div>
                      <div className="w-24 flex-shrink-0 text-center">
                        State
                      </div>
                      <div className="w-28 flex-shrink-0 text-center">
                        ECO Action
                      </div>
                    </div>
                    {/* Orphan item rows */}
                    <div className="divide-y dark:divide-slate-700">
                      {filteredOrphans.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center h-7 px-2 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm"
                        >
                          <div className="flex-[2] min-w-[200px] flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className="text-xs flex-shrink-0"
                            >
                              {item.itemType}
                            </Badge>
                            <span className="font-medium text-slate-900 dark:text-white truncate">
                              {item.itemNumber}
                            </span>
                          </div>
                          <div className="flex-[2] min-w-[150px] truncate text-slate-600 dark:text-slate-400">
                            {item.name}
                          </div>
                          <div className="w-16 flex-shrink-0 text-center text-xs text-slate-500">
                            {item.revision}
                          </div>
                          <div className="w-24 flex-shrink-0 flex justify-center">
                            <Badge
                              variant={getStateBadgeVariant(item.state)}
                              className="text-xs"
                            >
                              {item.state}
                            </Badge>
                          </div>
                          <div className="w-28 flex-shrink-0 flex justify-center">
                            {item.isInEco ? (
                              <Badge
                                variant={
                                  item.changeAction === 'release'
                                    ? 'success'
                                    : item.changeAction === 'obsolete'
                                      ? 'destructive'
                                      : 'default'
                                }
                                className="text-xs"
                              >
                                {item.changeAction
                                  ? item.changeAction.charAt(0).toUpperCase() +
                                    item.changeAction.slice(1)
                                  : 'In ECO'}
                              </Badge>
                            ) : (
                              <span className="text-slate-400 text-xs">—</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
      {/* Add Part from Design Dialog */}
      <AddPartFromDesignDialog
        open={addFromDesignOpen}
        onOpenChange={setAddFromDesignOpen}
        designId={designId}
        designName={designName || designCode || 'Untitled Design'}
        changeOrderId={changeOrderId}
        designType={designType}
        branchId={branchId}
        onSuccess={() => {
          fetchStructure()
          onItemsAdded?.()
        }}
      />
    </Card>
  )
}
