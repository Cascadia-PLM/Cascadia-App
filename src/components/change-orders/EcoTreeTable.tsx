import { Check, ExternalLink, Minus, Plus } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import type { BOMTreeNode } from '@/components/bom/types'
import type { ColumnDefinition } from '@/components/bom/BomTreeView'
import { Badge } from '@/components/ui'
import { BomTreeView } from '@/components/bom/BomTreeView'
import { getItemRoute, getStateBadgeVariant } from '@/components/bom/helpers'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/ContextMenu'

export type { BOMTreeNode }

interface EcoTreeTableProps {
  nodes: Array<BOMTreeNode>
  expandedNodes: Set<string>
  onToggle: (itemId: string) => void
  onAddToEco: (node: BOMTreeNode) => void
  onAddChild?: (node: BOMTreeNode) => void
  readOnly?: boolean
  branchId?: string

  // Selection props (optional)
  showCheckboxes?: boolean
  selectedIds?: Set<string>
  onSelectionClick?: (
    itemId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => void
  onCheckboxChange?: (itemId: string) => void
  isItemSelectable?: (node: BOMTreeNode) => boolean
  onSelectAll?: () => void
  isAllSelected?: boolean
  isIndeterminate?: boolean

  // Column filter props (optional)
  columnFilters?: Record<string, unknown>
  onColumnFilterChange?: (columnId: string, value: unknown) => void
}

// Get change action badge variant and label
function getChangeActionDisplay(
  action: string | null | undefined,
  isInEco: boolean | undefined,
) {
  if (!isInEco) {
    return { variant: 'outline' as const, label: '—', icon: null }
  }

  switch (action) {
    case 'release':
      return {
        variant: 'success' as const,
        label: 'Release',
        icon: <Check className="h-3 w-3" />,
      }
    case 'revise':
      return {
        variant: 'default' as const,
        label: 'Revise',
        icon: <Check className="h-3 w-3" />,
      }
    case 'obsolete':
      return {
        variant: 'destructive' as const,
        label: 'Obsolete',
        icon: <Minus className="h-3 w-3" />,
      }
    case 'promote':
      return {
        variant: 'warning' as const,
        label: 'Promote',
        icon: <Check className="h-3 w-3" />,
      }
    default:
      return {
        variant: 'success' as const,
        label: 'In ECO',
        icon: <Check className="h-3 w-3" />,
      }
  }
}

export function EcoTreeTable({
  nodes,
  expandedNodes,
  onToggle,
  onAddToEco,
  onAddChild,
  readOnly = false,
  branchId,
  showCheckboxes,
  selectedIds,
  onSelectionClick,
  onCheckboxChange,
  isItemSelectable,
  onSelectAll,
  isAllSelected,
  isIndeterminate,
  columnFilters,
  onColumnFilterChange,
}: EcoTreeTableProps) {
  const navigate = useNavigate()

  const columns: Array<ColumnDefinition> = [
    {
      id: 'item',
      label: 'Item',
      width: 'flex-[2] min-w-[200px]',
      filterType: 'text',
      filterPlaceholder: 'Filter by item number...',
      renderCell: (node) => (
        <>
          <span className="font-medium text-slate-900 dark:text-white truncate">
            {node.itemNumber}
          </span>
          {node.isExternal && node.designCode && (
            <Badge
              variant="outline"
              className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 flex-shrink-0"
              title={`From ${node.designName || node.designCode}`}
            >
              {node.designCode}
            </Badge>
          )}
          {node.quantity && node.quantity > 1 && (
            <span className="text-xs text-slate-400 flex-shrink-0">
              x{node.quantity}
            </span>
          )}
        </>
      ),
    },
    {
      id: 'name',
      label: 'Name',
      width: 'flex-[2] min-w-[150px]',
      filterType: 'text',
      filterPlaceholder: 'Filter by name...',
      renderCell: (node) => (
        <span className="truncate text-slate-600 dark:text-slate-400">
          {node.name}
        </span>
      ),
    },
    {
      id: 'rev',
      label: 'Rev',
      width: 'w-16 flex-shrink-0',
      align: 'center',
      filterType: 'text',
      filterPlaceholder: 'Filter by rev...',
      renderCell: (node) => (
        <span className="text-xs text-slate-500">{node.revision}</span>
      ),
    },
    {
      id: 'state',
      label: 'State',
      width: 'w-24 flex-shrink-0',
      align: 'center',
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Draft', value: 'Draft' },
        { label: 'In Review', value: 'InReview' },
        { label: 'Released', value: 'Released' },
        { label: 'Obsolete', value: 'Obsolete' },
      ],
      renderCell: (node) => (
        <Badge variant={getStateBadgeVariant(node.state)} className="text-xs">
          {node.state}
        </Badge>
      ),
    },
    {
      id: 'action',
      label: 'ECO Action',
      width: 'w-28 flex-shrink-0',
      align: 'center',
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Release', value: 'release' },
        { label: 'Revise', value: 'revise' },
        { label: 'Obsolete', value: 'obsolete' },
        { label: 'In ECO', value: '__in_eco__' },
        { label: 'Not in ECO', value: '__not_in_eco__' },
      ],
      renderCell: (node) => {
        const actionDisplay = getChangeActionDisplay(
          node.changeAction,
          node.isInEco,
        )
        if (node.isInEco) {
          return (
            <Badge variant={actionDisplay.variant} className="text-xs gap-1">
              {actionDisplay.icon}
              {actionDisplay.label}
            </Badge>
          )
        }
        return <span className="text-slate-400 text-xs">—</span>
      },
    },
  ]

  const renderContextMenu = (node: BOMTreeNode) => {
    const route = getItemRoute(node.itemType, node.itemId)
    const isEligibleForAdd = !node.isInEco && node.state !== 'Obsolete'
    const showAddChild =
      !readOnly && onAddChild && node.itemType === 'Part' && !node.isExternal
    const showAddToEco = !readOnly && isEligibleForAdd

    return (
      <>
        <ContextMenuItem
          onClick={() =>
            navigate({
              to: route,
              search: branchId ? { branch: branchId } : {},
            } as any)
          }
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          View
        </ContextMenuItem>
        {(showAddChild || showAddToEco) && <ContextMenuSeparator />}
        {showAddChild && (
          <ContextMenuItem onClick={() => onAddChild(node)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Child
          </ContextMenuItem>
        )}
        {showAddToEco && (
          <ContextMenuItem onClick={() => onAddToEco(node)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add to ECO
          </ContextMenuItem>
        )}
      </>
    )
  }

  return (
    <BomTreeView
      nodes={nodes}
      expandedNodes={expandedNodes}
      onToggle={onToggle}
      layout="grid"
      columns={columns}
      renderContextMenu={renderContextMenu}
      readOnly={readOnly}
      showCheckboxes={showCheckboxes}
      selectedIds={selectedIds}
      onSelectionClick={onSelectionClick}
      onCheckboxChange={onCheckboxChange}
      isItemSelectable={isItemSelectable}
      onSelectAll={onSelectAll}
      isAllSelected={isAllSelected}
      isIndeterminate={isIndeterminate}
      columnFilters={columnFilters}
      onColumnFilterChange={onColumnFilterChange}
    />
  )
}
