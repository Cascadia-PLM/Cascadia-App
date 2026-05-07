import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownToLine,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Link, useNavigate } from '@tanstack/react-router'
import { AddPartToDesignDialog } from './AddPartToDesignDialog'
import { AddPartToStructureDialog } from './AddPartToStructureDialog'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type { BOMTreeNode } from '@/components/bom/types'
import type { ColumnDefinition } from '@/components/bom/BomTreeView'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
  Progress,
} from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/ContextMenu'
import { apiFetch } from '@/lib/api/client'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { BomTreeView } from '@/components/bom/BomTreeView'
import { exportBomTreeToCsv } from '@/components/bom/exportBomTree'
import { useTreeSelection } from '@/components/bom/useTreeSelection'
import { getItemRoute, getStateBadgeVariant } from '@/components/bom/helpers'

interface OrphanItem {
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
}

interface PullInChainInfo {
  targetNode: BOMTreeNode
  chainItemIds: Array<string> // topmost first, target last
  chainNodes: Array<BOMTreeNode> // for display in dialog
  refId: string | null // if chain starts from XREF root
  parentBomRelationshipId: string | null // if chain starts below a native parent
}

interface StructureTabProps {
  designId: string
  designCode: string
  designName: string
  versionContext: VersionContext
  isHistoricalView: boolean
}

export function StructureTab({
  designId,
  designCode,
  designName,
  versionContext,
  isHistoricalView,
}: StructureTabProps) {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const [loading, setLoading] = useState(true)
  const [roots, setRoots] = useState<Array<BOMTreeNode>>([])
  const [orphans, setOrphans] = useState<Array<OrphanItem>>([])
  const [filter, setFilter] = useState('')
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [isAddPartDialogOpen, setIsAddPartDialogOpen] = useState(false)
  const [removingItemId, setRemovingItemId] = useState<string | null>(null)
  // State for AddPartToStructureDialog (add child to BOM)
  const [addChildDialogOpen, setAddChildDialogOpen] = useState(false)
  const [parentForAddChild, setParentForAddChild] = useState<{
    id: string
    number: string
  } | null>(null)

  // State for Pull-In dialog (single item)
  const [pullInDialogOpen, setPullInDialogOpen] = useState(false)
  const [pullInChainInfo, setPullInChainInfo] =
    useState<PullInChainInfo | null>(null)
  const [pullInSuffix, setPullInSuffix] = useState(false)
  const [pullInLoading, setPullInLoading] = useState(false)

  // State for batch Pull-In dialog
  const [batchPullInDialogOpen, setBatchPullInDialogOpen] = useState(false)
  const [batchChains, setBatchChains] = useState<Array<PullInChainInfo>>([])
  const [batchTotalItems, setBatchTotalItems] = useState(0)
  const [batchPullInSuffix, setBatchPullInSuffix] = useState(true)
  const [batchPullInLoading, setBatchPullInLoading] = useState(false)
  const [batchProgress, setBatchProgress] = useState(0)
  const [batchErrors, setBatchErrors] = useState<
    Array<{ itemNumber: string; error: string }>
  >([])

  // Multi-select for batch pull-in
  const isEligible = useCallback(
    (node: BOMTreeNode) => !!(node.isExternal || node.isCrossDesignRef),
    [],
  )
  const selection = useTreeSelection({ isEligible })

  // Filter tree nodes recursively - keep nodes that match or have matching descendants
  const filterTree = (
    nodes: Array<BOMTreeNode>,
    searchTerm: string,
  ): Array<BOMTreeNode> => {
    if (!searchTerm.trim()) return nodes

    const lowerSearch = searchTerm.toLowerCase()

    const filterNode = (node: BOMTreeNode): BOMTreeNode | null => {
      const nodeMatches =
        node.itemNumber.toLowerCase().includes(lowerSearch) ||
        node.name.toLowerCase().includes(lowerSearch)

      // Recursively filter children
      const filteredChildren = node.children
        ? node.children
            .map((child) => filterNode(child))
            .filter((child): child is BOMTreeNode => child !== null)
        : []

      // Keep node if it matches or has matching descendants
      if (nodeMatches || filteredChildren.length > 0) {
        return {
          ...node,
          children:
            filteredChildren.length > 0 ? filteredChildren : node.children,
        }
      }

      return null
    }

    return nodes
      .map((node) => filterNode(node))
      .filter((node): node is BOMTreeNode => node !== null)
  }

  // Memoized filtered data
  const filteredRoots = useMemo(
    () => filterTree(roots, filter),
    [roots, filter],
  )

  const filteredOrphans = useMemo(() => {
    if (!filter.trim()) return orphans
    const lowerSearch = filter.toLowerCase()
    return orphans.filter(
      (item) =>
        item.itemNumber.toLowerCase().includes(lowerSearch) ||
        item.name.toLowerCase().includes(lowerSearch),
    )
  }, [orphans, filter])

  // Sync visible nodes for selection hook
  useEffect(() => {
    selection.setVisibleNodes(filteredRoots, expandedNodes)
  }, [filteredRoots, expandedNodes, selection.setVisibleNodes])

  // Auto-expand all nodes when filtering to show matches
  useEffect(() => {
    if (filter.trim()) {
      const allIds = new Set<string>()
      const collectIds = (nodes: Array<BOMTreeNode>) => {
        nodes.forEach((node) => {
          if (node.children && node.children.length > 0) {
            allIds.add(node.itemId)
            collectIds(node.children)
          }
        })
      }
      collectIds(filteredRoots)
      setExpandedNodes(allIds)
    }
  }, [filter, filteredRoots])

  // Fetch structure data
  const fetchStructure = async () => {
    setLoading(true)
    setError(null)
    try {
      // Build query params
      const params = new URLSearchParams()
      if (versionContext.branchId) params.set('branch', versionContext.branchId)
      if (versionContext.tagId) params.set('tag', versionContext.tagId)
      if (versionContext.commitId) params.set('commit', versionContext.commitId)

      const response = await apiFetch<{
        data: { roots: Array<BOMTreeNode>; orphans: Array<OrphanItem> }
      }>(`/api/v1/designs/${designId}/structure?${params.toString()}`)

      setRoots(response.data.roots)
      setOrphans(response.data.orphans)
      selection.clearSelection()
    } catch {
      setError(
        'Failed to load structure. The API endpoint may not be implemented yet.',
      )
      // Set empty data
      setRoots([])
      setOrphans([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStructure()
  }, [designId, versionContext])

  // Handle successful add
  const handleAddSuccess = () => {
    fetchStructure()
  }

  // Handle remove root part from design structure (moves to orphan list)
  // Note: This only applies to root parts (no relationshipId). Child parts are managed via their parent.
  const handleRemoveFromStructure = (itemId: string, itemNumber: string) => {
    confirm({
      title: 'Remove from Structure',
      description: `Are you sure you want to remove ${itemNumber} from the design structure? The part will move to the orphan list but will still belong to this design.`,
      actionLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        setRemovingItemId(itemId)
        try {
          // Set inDesignStructure=false, keeping the designId association
          await apiFetch(`/api/v1/designs/${designId}/items?itemId=${itemId}`, {
            method: 'DELETE',
          })
          fetchStructure()
        } catch {
          // Silently fail - user can retry the operation
        } finally {
          setRemovingItemId(null)
        }
      },
    })
  }

  // Handle adding orphan part back to design structure
  const handleAddToStructure = (itemId: string, itemNumber: string) => {
    confirm({
      title: 'Add to Structure',
      description: `Add ${itemNumber} back to the design structure as a root part?`,
      actionLabel: 'Add',
      cancelLabel: 'Cancel',
      onConfirm: async () => {
        setRemovingItemId(itemId) // Reuse loading state
        try {
          // Set inDesignStructure=true
          await apiFetch(`/api/v1/designs/${designId}/items`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId }),
          })
          fetchStructure()
        } catch {
          // Silently fail - user can retry the operation
        } finally {
          setRemovingItemId(null)
        }
      },
    })
  }

  // Toggle node expansion
  const toggleNode = (itemId: string) => {
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

  // Column definitions for tree-table grid
  const structureColumns: Array<ColumnDefinition> = useMemo(
    () => [
      {
        id: 'item',
        label: 'Item',
        width: 'flex-[2] min-w-[200px]',
        renderCell: (node) => (
          <>
            <span
              className={`font-medium truncate ${
                node.isCrossDesignRef
                  ? 'text-slate-500 dark:text-slate-400'
                  : 'text-slate-900 dark:text-white'
              }`}
            >
              {node.itemNumber}
            </span>
            {node.isCrossDesignRef && node.designCode && (
              <Badge
                variant="outline"
                className="text-xs text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600 flex-shrink-0"
                title={`Cross-design reference from ${node.designName || node.designCode}`}
              >
                XREF {node.designCode}
              </Badge>
            )}
            {!node.isCrossDesignRef && node.isExternal && node.designCode && (
              <Badge
                variant="outline"
                className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 flex-shrink-0"
                title={`From ${node.designName || node.designCode}`}
              >
                <Link2 className="h-3 w-3 mr-1" />
                {node.designCode}
              </Badge>
            )}
          </>
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
      {
        id: 'inwork',
        label: '',
        width: 'w-6 flex-shrink-0',
        align: 'center',
        renderCell: (node) =>
          node.isInWork ? (
            <span className="text-amber-500" title="In work on ECO">
              &#8635;
            </span>
          ) : null,
      },
    ],
    [isHistoricalView],
  )

  // Build a parent map from the tree: node -> parent
  const buildParentMap = (
    treeRoots: Array<BOMTreeNode>,
  ): Map<BOMTreeNode, BOMTreeNode | null> => {
    const map = new Map<BOMTreeNode, BOMTreeNode | null>()
    const walk = (node: BOMTreeNode, parent: BOMTreeNode | null) => {
      map.set(node, parent)
      if (node.children) {
        for (const child of node.children) {
          walk(child, node)
        }
      }
    }
    for (const root of treeRoots) {
      walk(root, null)
    }
    return map
  }

  // Open the Pull-In dialog for any external item
  const handlePullInReference = (node: BOMTreeNode) => {
    const parentMap = buildParentMap(roots)

    // Walk up collecting external ancestors until we hit a native parent or XREF root
    const chain: Array<BOMTreeNode> = [node]
    let current = parentMap.get(node)

    while (current) {
      if (current.isCrossDesignRef && current.crossReferenceId) {
        // Reached an XREF root - include it in the chain
        chain.unshift(current)
        break
      }
      if (!current.isExternal && !current.isCrossDesignRef) {
        // Reached a native parent - stop (don't include it)
        break
      }
      // External ancestor - add to chain
      chain.unshift(current)
      current = parentMap.get(current)
    }

    // Determine refId and parentBomRelationshipId
    let refId: string | null = null
    let parentBomRelationshipId: string | null = null

    const topmostNode = chain[0]
    if (topmostNode.isCrossDesignRef && topmostNode.crossReferenceId) {
      refId = topmostNode.crossReferenceId
    } else {
      // The topmost chain node is external but not an XREF root
      // Its parent is native - use the BOM relationship from parent to topmost
      parentBomRelationshipId = topmostNode.relationshipId ?? null
    }

    setPullInChainInfo({
      targetNode: node,
      chainItemIds: chain.map((n) => n.itemId),
      chainNodes: chain,
      refId,
      parentBomRelationshipId,
    })
    setPullInSuffix(false)
    setPullInDialogOpen(true)
  }

  // Execute the pull-in after user confirms options
  const executePullIn = async () => {
    if (!pullInChainInfo) return
    setPullInLoading(true)
    try {
      await apiFetch(`/api/v1/designs/${designId}/cross-references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refId: pullInChainInfo.refId || undefined,
          itemIds: pullInChainInfo.chainItemIds,
          parentBomRelationshipId:
            pullInChainInfo.parentBomRelationshipId || undefined,
          branchId: versionContext.branchId || null,
          suffixItemNumber: pullInSuffix || undefined,
        }),
      })
      setPullInDialogOpen(false)
      fetchStructure()
    } catch {
      // Silently fail - user can retry
    } finally {
      setPullInLoading(false)
    }
  }

  // Build deduplicated chains for batch pull-in
  const buildBatchChains = useCallback(
    (
      selectedItemIds: Set<string>,
    ): { chains: Array<PullInChainInfo>; totalUniqueItems: number } => {
      const parentMap = buildParentMap(roots)
      const allChains: Array<PullInChainInfo> = []

      // Build a map of XREF root nodes keyed by itemId so we find the
      // node that carries crossReferenceId rather than a BOM-child duplicate.
      const xrefRootsByItemId = new Map<string, BOMTreeNode>()
      for (const root of roots) {
        if (root.isCrossDesignRef && root.crossReferenceId) {
          xrefRootsByItemId.set(root.itemId, root)
        }
      }

      const findNode = (
        nodes: Array<BOMTreeNode>,
        id: string,
      ): BOMTreeNode | null => {
        for (const n of nodes) {
          if (n.itemId === id) return n
          if (n.children) {
            const found = findNode(n.children, id)
            if (found) return found
          }
        }
        return null
      }

      // Build a chain for each selected item using the same logic as handlePullInReference
      for (const itemId of selectedItemIds) {
        // Prefer the XREF root occurrence (has crossReferenceId) over a BOM-child duplicate
        const targetNode: BOMTreeNode | null =
          xrefRootsByItemId.get(itemId) ?? findNode(roots, itemId)
        if (!targetNode) continue

        const chain: Array<BOMTreeNode> = [targetNode]
        let current = parentMap.get(targetNode)

        while (current) {
          if (current.isCrossDesignRef && current.crossReferenceId) {
            chain.unshift(current)
            break
          }
          if (!current.isExternal && !current.isCrossDesignRef) {
            break
          }
          chain.unshift(current)
          current = parentMap.get(current)
        }

        let refId: string | null = null
        let parentBomRelationshipId: string | null = null
        const topmostNode = chain[0]
        if (topmostNode.isCrossDesignRef && topmostNode.crossReferenceId) {
          refId = topmostNode.crossReferenceId
        } else {
          parentBomRelationshipId = topmostNode.relationshipId ?? null
        }

        allChains.push({
          targetNode,
          chainItemIds: chain.map((n) => n.itemId),
          chainNodes: chain,
          refId,
          parentBomRelationshipId,
        })
      }

      // Deduplicate: sort chains by length descending, skip chains whose items are fully covered
      allChains.sort((a, b) => b.chainItemIds.length - a.chainItemIds.length)
      const coveredItemIds = new Set<string>()
      const deduped: Array<PullInChainInfo> = []

      for (const chain of allChains) {
        // Check if the target is already covered by a longer chain
        if (coveredItemIds.has(chain.targetNode.itemId)) continue
        deduped.push(chain)
        for (const id of chain.chainItemIds) {
          coveredItemIds.add(id)
        }
      }

      return { chains: deduped, totalUniqueItems: coveredItemIds.size }
    },
    [roots],
  )

  // Open batch pull-in dialog
  const handleBatchPullIn = () => {
    const { chains, totalUniqueItems } = buildBatchChains(selection.selectedIds)
    if (chains.length === 0) return
    setBatchChains(chains)
    setBatchTotalItems(totalUniqueItems)
    setBatchPullInSuffix(false)
    setBatchPullInLoading(false)
    setBatchProgress(0)
    setBatchErrors([])
    setBatchPullInDialogOpen(true)
  }

  // Execute batch pull-in — merge chains sharing the same refId into a single API call
  const executeBatchPullIn = async () => {
    setBatchPullInLoading(true)
    setBatchProgress(0)
    setBatchErrors([])
    const errors: Array<{ itemNumber: string; error: string }> = []

    // Group chains by refId — shared-ancestor chains become a single API call
    const refIdGroups = new Map<string, Array<PullInChainInfo>>()
    const standaloneChains: Array<PullInChainInfo> = []

    for (const chain of batchChains) {
      if (chain.refId) {
        const group = refIdGroups.get(chain.refId) ?? []
        group.push(chain)
        refIdGroups.set(chain.refId, group)
      } else {
        standaloneChains.push(chain)
      }
    }

    let progress = 0

    // Process merged refId groups (one API call per group)
    for (const [refId, chains] of refIdGroups) {
      const seen = new Set<string>()
      const mergedItemIds: Array<string> = []
      for (const chain of chains) {
        for (const id of chain.chainItemIds) {
          if (!seen.has(id)) {
            seen.add(id)
            mergedItemIds.push(id)
          }
        }
      }

      try {
        await apiFetch(`/api/v1/designs/${designId}/cross-references`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            refId,
            itemIds: mergedItemIds,
            branchId: versionContext.branchId || null,
            suffixItemNumber: batchPullInSuffix || undefined,
          }),
        })
      } catch {
        for (const chain of chains) {
          errors.push({
            itemNumber: chain.targetNode.itemNumber,
            error: 'Failed to pull in',
          })
        }
      }
      progress += chains.length
      setBatchProgress(progress)
    }

    // Process standalone chains individually (no refId, use parentBomRelationshipId)
    for (const chain of standaloneChains) {
      try {
        await apiFetch(`/api/v1/designs/${designId}/cross-references`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            refId: chain.refId || undefined,
            itemIds: chain.chainItemIds,
            parentBomRelationshipId: chain.parentBomRelationshipId || undefined,
            branchId: versionContext.branchId || null,
            suffixItemNumber: batchPullInSuffix || undefined,
          }),
        })
      } catch {
        errors.push({
          itemNumber: chain.targetNode.itemNumber,
          error: 'Failed to pull in',
        })
      }
      progress++
      setBatchProgress(progress)
    }

    setBatchErrors(errors)
    setBatchPullInLoading(false)

    if (errors.length === 0) {
      setBatchPullInDialogOpen(false)
      selection.clearSelection()
      fetchStructure()
    }
  }

  // Right-click context menu for tree rows
  const renderContextMenu = (node: BOMTreeNode) => {
    const route = getItemRoute(node.itemType, node.itemId)
    const showAddChild =
      !isHistoricalView &&
      node.itemType === 'Part' &&
      !node.isExternal &&
      !node.isCrossDesignRef
    const showRemove =
      !isHistoricalView &&
      !node.relationshipId &&
      !node.isExternal &&
      !node.isCrossDesignRef
    const showPullIn =
      !isHistoricalView && (node.isExternal || node.isCrossDesignRef)

    return (
      <>
        <ContextMenuItem onClick={() => navigate({ to: route })}>
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          {node.isExternal || node.isCrossDesignRef
            ? 'View in Home Design'
            : 'View'}
        </ContextMenuItem>
        {(showAddChild || showRemove || showPullIn) && <ContextMenuSeparator />}
        {showPullIn && (
          <ContextMenuItem onClick={() => handlePullInReference(node)}>
            <ArrowDownToLine className="mr-1.5 h-3.5 w-3.5" />
            Pull In as Usage Copy
          </ContextMenuItem>
        )}
        {showAddChild && (
          <ContextMenuItem
            onClick={() => {
              setParentForAddChild({
                id: node.itemId,
                number: node.itemNumber,
              })
              setAddChildDialogOpen(true)
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Child
          </ContextMenuItem>
        )}
        {showRemove && (
          <ContextMenuItem
            onClick={() =>
              handleRemoveFromStructure(node.itemId, node.itemNumber)
            }
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Remove from Structure
          </ContextMenuItem>
        )}
      </>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Error message */}
      {error && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800">
          <CardContent className="py-4">
            <p className="text-amber-700 dark:text-amber-300">{error}</p>
            <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">
              This feature requires the structure API endpoint to be
              implemented.
            </p>
          </CardContent>
        </Card>
      )}

      {/* BOM Tree */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Design Structure</CardTitle>
              <CardDescription>
                Bill of Materials hierarchy
                {isHistoricalView && (
                  <span className="text-amber-600 dark:text-amber-400 ml-2">
                    (viewing historical state)
                  </span>
                )}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-80 flex-shrink-0">
                <Input
                  placeholder="Filter by item number or name..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <Button variant="outline" size="sm" onClick={expandAll}>
                Expand All
              </Button>
              <Button variant="outline" size="sm" onClick={collapseAll}>
                Collapse All
              </Button>
              {roots.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    exportBomTreeToCsv(roots, { filename: `${designCode}-bom` })
                  }
                >
                  <Download className="h-4 w-4 mr-1" />
                  Export CSV
                </Button>
              )}
              {!isHistoricalView && (
                <Button size="sm" onClick={() => setIsAddPartDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Part
                </Button>
              )}
            </div>
          </div>
          {/* Bulk action bar when items are selected */}
          {!isHistoricalView && selection.selectedCount > 0 && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t dark:border-slate-700">
              <Badge variant="secondary" className="text-xs">
                {selection.selectedCount} selected
              </Badge>
              <Button size="sm" onClick={handleBatchPullIn}>
                <ArrowDownToLine className="h-3.5 w-3.5 mr-1" />
                Pull In Selected
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={selection.clearSelection}
              >
                <X className="h-3.5 w-3.5 mr-1" />
                Clear
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {filteredRoots.length > 0 ? (
            <BomTreeView
              nodes={filteredRoots}
              expandedNodes={expandedNodes}
              onToggle={toggleNode}
              layout="grid"
              columns={structureColumns}
              renderContextMenu={renderContextMenu}
              {...(!isHistoricalView && {
                showCheckboxes: true,
                selectedIds: selection.selectedIds,
                onSelectionClick: selection.handleClick,
                onCheckboxChange: selection.handleCheckboxChange,
                isItemSelectable: isEligible,
                onSelectAll: selection.isAllSelected
                  ? selection.clearSelection
                  : selection.selectAll,
                isAllSelected: selection.isAllSelected,
                isIndeterminate: selection.isIndeterminate,
              })}
            />
          ) : roots.length > 0 ? (
            <div className="text-center py-8 text-slate-500 dark:text-slate-400">
              No items match the filter.
            </div>
          ) : (
            !error && (
              <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                No BOM structure found. Add parent-child relationships between
                parts to build the design structure.
              </div>
            )
          )}
        </CardContent>
      </Card>

      {/* Orphan Items */}
      {filteredOrphans.length > 0 && (
        <Collapsible defaultOpen={false}>
          <Card>
            <CardHeader>
              <CollapsibleTrigger className="hover:opacity-70">
                <CardTitle>Orphan Items</CardTitle>
              </CollapsibleTrigger>
              <CardDescription>
                Items in this design but not in the BOM hierarchy (documents,
                requirements, and removed parts)
              </CardDescription>
            </CardHeader>
            <CollapsibleContent>
              <CardContent>
                <div className="space-y-0 divide-y dark:divide-slate-700">
                  {filteredOrphans.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center h-7 gap-2 px-2 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm group"
                    >
                      <Badge variant="outline" className="text-xs">
                        {item.itemType}
                      </Badge>
                      <span className="font-medium text-slate-900 dark:text-white">
                        {item.itemNumber}
                      </span>
                      <span className="text-slate-600 dark:text-slate-400 truncate">
                        {item.name}
                      </span>
                      <span className="text-xs text-slate-500">
                        Rev {item.revision}
                      </span>
                      <Badge
                        variant={getStateBadgeVariant(item.state)}
                        className="text-xs"
                      >
                        {item.state}
                      </Badge>
                      <div className="flex-1" />
                      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1">
                        <Link to={getItemRoute(item.itemType, item.id)}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2"
                          >
                            <ExternalLink className="h-3 w-3 mr-1" />
                            View
                          </Button>
                        </Link>
                        {/* Parts can be added back to structure. Documents/Requirements stay as orphans. */}
                        {!isHistoricalView && item.itemType === 'Part' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950"
                            onClick={() =>
                              handleAddToStructure(item.id, item.itemNumber)
                            }
                            disabled={removingItemId === item.id}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            {removingItemId === item.id ? 'Adding...' : 'Add'}
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      {/* Add Part to Design Dialog */}
      <AddPartToDesignDialog
        open={isAddPartDialogOpen}
        onOpenChange={setIsAddPartDialogOpen}
        designId={designId}
        designCode={designCode}
        designName={designName}
        onSuccess={handleAddSuccess}
      />

      {/* Add Part to BOM Dialog (cross-design aware) */}
      {parentForAddChild && (
        <AddPartToStructureDialog
          open={addChildDialogOpen}
          onOpenChange={setAddChildDialogOpen}
          parentItemId={parentForAddChild.id}
          parentItemNumber={parentForAddChild.number}
          currentDesignId={designId}
          currentDesignCode={designCode}
          onSuccess={handleAddSuccess}
        />
      )}

      {/* Batch Pull In Dialog */}
      <Dialog
        open={batchPullInDialogOpen}
        onOpenChange={(open) => {
          if (!batchPullInLoading) setBatchPullInDialogOpen(open)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pull In Selected Items</DialogTitle>
            <DialogDescription>
              Convert {batchTotalItems} external item
              {batchTotalItems !== 1 ? 's' : ''} into usage copies in this
              design.
            </DialogDescription>
          </DialogHeader>

          {/* Chain list */}
          <div className="max-h-60 overflow-y-auto space-y-1 py-1">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {batchChains.length} chain{batchChains.length !== 1 ? 's' : ''} to
              process:
            </p>
            <div className="space-y-0.5 ml-1">
              {batchChains.map((chain) => (
                <div
                  key={chain.targetNode.itemId}
                  className="flex items-center gap-1.5 text-sm"
                >
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {chain.targetNode.itemNumber}
                  </span>
                  <span className="text-xs text-slate-400 truncate">
                    {chain.targetNode.name}
                  </span>
                  {chain.chainNodes.length > 1 && (
                    <Badge variant="outline" className="text-xs px-1 py-0">
                      +{chain.chainNodes.length - 1} ancestor
                      {chain.chainNodes.length - 1 > 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Progress bar during execution */}
          {batchPullInLoading && (
            <div className="space-y-1 py-1">
              <Progress value={batchProgress} max={batchChains.length} />
              <p className="text-xs text-slate-500 text-center">
                {batchProgress} / {batchChains.length} completed
              </p>
            </div>
          )}

          {/* Error display for partial failures */}
          {batchErrors.length > 0 && (
            <div className="space-y-1 py-1">
              <p className="text-xs font-medium text-red-600 dark:text-red-400">
                {batchErrors.length} item{batchErrors.length !== 1 ? 's' : ''}{' '}
                failed:
              </p>
              <div className="space-y-0.5 ml-1">
                {batchErrors.map((err) => (
                  <div
                    key={err.itemNumber}
                    className="text-xs text-red-600 dark:text-red-400"
                  >
                    {err.itemNumber}: {err.error}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3 py-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="batchPullInSuffix"
                checked={batchPullInSuffix}
                onCheckedChange={(checked) =>
                  setBatchPullInSuffix(checked as boolean)
                }
                disabled={batchPullInLoading}
              />
              <Label
                htmlFor="batchPullInSuffix"
                className="text-sm font-normal cursor-pointer"
              >
                Suffix item numbers with design code
              </Label>
            </div>
            {batchPullInSuffix && designCode && batchChains.length > 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400 ml-6">
                e.g., {batchChains[0].targetNode.itemNumber}-{designCode}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBatchPullInDialogOpen(false)}
              disabled={batchPullInLoading}
            >
              Cancel
            </Button>
            <Button onClick={executeBatchPullIn} disabled={batchPullInLoading}>
              {batchPullInLoading
                ? `Pulling in... (${batchProgress}/${batchChains.length})`
                : `Pull In ${batchChains.length} Item${batchChains.length !== 1 ? 's' : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pull In Reference Dialog (single item) */}
      <Dialog open={pullInDialogOpen} onOpenChange={setPullInDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pull In as Usage Copy</DialogTitle>
            <DialogDescription>
              {pullInChainInfo && pullInChainInfo.chainNodes.length === 1 ? (
                <>
                  Convert{' '}
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {pullInChainInfo.targetNode.itemNumber}
                  </span>{' '}
                  into a usage copy in this design. Its BOM children will remain
                  as references to their source design.
                </>
              ) : pullInChainInfo ? (
                <>
                  Convert{' '}
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {pullInChainInfo.targetNode.itemNumber}
                  </span>{' '}
                  into a usage copy. {pullInChainInfo.chainNodes.length - 1}{' '}
                  ancestor
                  {pullInChainInfo.chainNodes.length - 1 > 1 ? 's' : ''} will
                  also be pulled in.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {/* Show chain items when more than one */}
          {pullInChainInfo && pullInChainInfo.chainNodes.length > 1 && (
            <div className="space-y-1 py-1">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Items to pull in:
              </p>
              <div className="space-y-0.5 ml-1">
                {pullInChainInfo.chainNodes.map((chainNode, idx) => (
                  <div
                    key={chainNode.itemId}
                    className="flex items-center gap-1.5 text-sm"
                  >
                    <span className="text-slate-400">
                      {'  '.repeat(idx)}
                      {idx > 0 ? '└ ' : ''}
                    </span>
                    <span
                      className={
                        chainNode.itemId === pullInChainInfo.targetNode.itemId
                          ? 'font-medium text-slate-900 dark:text-slate-100'
                          : 'text-slate-600 dark:text-slate-400'
                      }
                    >
                      {chainNode.itemNumber}
                    </span>
                    <span className="text-xs text-slate-400 truncate">
                      {chainNode.name}
                    </span>
                    {chainNode.itemId === pullInChainInfo.targetNode.itemId && (
                      <Badge variant="outline" className="text-xs px-1 py-0">
                        target
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3 py-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="pullInSuffix"
                checked={pullInSuffix}
                onCheckedChange={(checked) =>
                  setPullInSuffix(checked as boolean)
                }
              />
              <Label
                htmlFor="pullInSuffix"
                className="text-sm font-normal cursor-pointer"
              >
                Suffix item numbers with design code
              </Label>
            </div>
            {pullInSuffix && designCode && pullInChainInfo && (
              <p className="text-xs text-slate-500 dark:text-slate-400 ml-6">
                e.g., {pullInChainInfo.targetNode.itemNumber}-{designCode}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPullInDialogOpen(false)}
              disabled={pullInLoading}
            >
              Cancel
            </Button>
            <Button onClick={executePullIn} disabled={pullInLoading}>
              {pullInLoading ? 'Pulling in...' : 'Pull In'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
