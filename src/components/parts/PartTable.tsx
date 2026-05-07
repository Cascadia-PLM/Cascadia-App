import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import { PartThumbnail } from './PartThumbnail'
import type { Part } from '@/lib/items/types/part'
import type {
  ColumnFiltersState,
  DataGridColumn,
  PaginationState,
  Row,
  SortingState,
} from '@/components/ui'
import { Badge, Button, DataGrid } from '@/components/ui'
import { PhaseBadge } from '@/components/items/PhaseBadge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/ContextMenu'

interface PartTableProps {
  items: Array<Part>
  onEdit?: (part: Part) => void
  onDelete?: (part: Part) => void
  // Initial state from URL (uncontrolled - just sets starting values)
  defaultSorting?: SortingState
  defaultColumnFilters?: ColumnFiltersState
  defaultGlobalFilter?: string
  // Server-side pagination
  serverSidePagination?: boolean
  totalRows?: number
  onPageChange?: (page: number, pageSize: number) => void
  isLoading?: boolean
  // Server-side operations (controlled state)
  serverSideOperations?: boolean
  sorting?: SortingState
  onSortingChange?: (sorting: SortingState) => void
  columnFilters?: ColumnFiltersState
  onColumnFiltersChange?: (filters: ColumnFiltersState) => void
  globalFilter?: string
  onGlobalFilterChange?: (filter: string) => void
  pagination?: PaginationState
  onPaginationChange?: (pagination: PaginationState) => void
}

const stateColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  Draft: 'secondary',
  InReview: 'default',
  Approved: 'success',
  Released: 'success',
  Obsolete: 'destructive',
}

export function PartTable({
  items,
  onEdit,
  onDelete,
  defaultSorting,
  defaultColumnFilters,
  defaultGlobalFilter,
  serverSidePagination,
  totalRows,
  onPageChange,
  isLoading,
  serverSideOperations,
  sorting,
  onSortingChange,
  columnFilters,
  onColumnFiltersChange,
  globalFilter,
  onGlobalFilterChange,
  pagination,
  onPaginationChange,
}: PartTableProps) {
  const columns: Array<DataGridColumn<Part>> = [
    {
      id: 'thumbnail',
      header: '',
      enableSorting: false,
      enableFiltering: false,
      meta: { width: '48px' },
      cell: ({ row }) =>
        row.original.id ? (
          <PartThumbnail itemId={row.original.id} size="sm" />
        ) : null,
    },
    {
      id: 'itemNumber',
      header: 'Item Number',
      accessorKey: 'itemNumber',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ row }) =>
        row.original.id ? (
          <Link
            to="/parts/$id"
            params={{ id: row.original.id }}
            className="font-medium text-sky-600 hover:text-sky-800 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
          >
            {row.original.itemNumber}
          </Link>
        ) : (
          <span className="font-medium">{row.original.itemNumber}</span>
        ),
    },
    {
      id: 'revision',
      header: 'Rev',
      accessorKey: 'revision',
      enableSorting: true,
      enableFiltering: false, // Revisions are short, filtering not useful
    },
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'partType',
      header: 'Type',
      accessorKey: 'partType',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Manufacture', value: 'Manufacture' },
        { label: 'Purchase', value: 'Purchase' },
        { label: 'Software', value: 'Software' },
        { label: 'Phantom', value: 'Phantom' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as
          | 'Manufacture'
          | 'Purchase'
          | 'Software'
          | 'Phantom'
          | undefined
        if (!value) return null
        return (
          <Badge
            variant={
              {
                Manufacture: 'default' as const,
                Purchase: 'secondary' as const,
                Software: 'success' as const,
                Phantom: 'outline' as const,
              }[value]
            }
          >
            {value}
          </Badge>
        )
      },
    },
    {
      id: 'material',
      header: 'Material',
      accessorKey: 'material',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'state',
      header: 'State',
      accessorKey: 'state',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Draft', value: 'Draft' },
        { label: 'In Review', value: 'InReview' },
        { label: 'Approved', value: 'Approved' },
        { label: 'Released', value: 'Released' },
        { label: 'Obsolete', value: 'Obsolete' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string
        return <Badge variant={stateColors[value]}>{value}</Badge>
      },
    },
    {
      id: 'phase',
      header: 'Phase',
      enableSorting: false,
      enableFiltering: false,
      meta: { width: '120px' },
      cell: ({ row }) => (
        <PhaseBadge
          itemType="Part"
          state={row.original.state}
          className="text-xs"
        />
      ),
    },
    {
      id: 'cost',
      header: 'Cost',
      accessorKey: 'cost',
      enableFiltering: true,
      filterType: 'range',
      filterPlaceholder: 'Any',
      meta: { align: 'right' },
      cell: ({ row }) => {
        const cost = row.original.cost
        const currency = row.original.costCurrency
        if (!cost) return '-'
        return `${currency} ${parseFloat(cost).toFixed(2)}`
      },
    },
    {
      id: 'usageCount',
      header: 'Used In',
      accessorKey: 'usageCount',
      enableFiltering: false,
      enableSorting: true,
      meta: { align: 'center' },
      cell: ({ row }) => {
        const count = row.original.usageCount
        if (count === undefined) return null // Not showing usage counts (design-specific view)
        if (count === 0) return <span className="text-slate-400">-</span>
        return (
          <Badge variant="outline" className="text-xs">
            {count} {count === 1 ? 'design' : 'designs'}
          </Badge>
        )
      },
    },
  ]

  const renderRowActions = (row: Row<Part>) => {
    const part = row.original
    const hasActions = part.id || onEdit || onDelete
    if (!hasActions) return null

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8">
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {part.id && (
            <DropdownMenuItem asChild>
              <Link to="/parts/$id" params={{ id: part.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(part)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(part)}
                className="text-red-600 focus:text-red-600"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Context menu items (Edit, Delete)
  const renderContextMenuItems = useCallback(
    (row: Row<Part>) => {
      const part = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(part)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(part)}
                className="text-red-600 focus:text-red-600"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </ContextMenuItem>
            </>
          )}
        </>
      )
    },
    [onEdit, onDelete],
  )

  // Get URL for row (for "Open in new tab")
  const getRowUrl = useCallback((row: Part) => {
    return row.id ? `/parts/${row.id}` : ''
  }, [])

  return (
    <DataGrid
      data={items}
      columns={columns}
      getRowId={(row) => row.id ?? row.itemNumber ?? ''}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      renderContextMenuItems={renderContextMenuItems}
      defaultSorting={defaultSorting}
      defaultColumnFilters={defaultColumnFilters}
      defaultGlobalFilter={defaultGlobalFilter}
      emptyMessage="No parts found"
      emptyDescription="Create your first part to get started"
      exportFilename="parts"
      serverSidePagination={serverSidePagination}
      totalRows={totalRows}
      onPageChange={onPageChange}
      isLoading={isLoading}
      // Server-side operations (controlled state)
      serverSideOperations={serverSideOperations}
      sorting={sorting}
      onSortingChange={onSortingChange}
      columnFilters={columnFilters}
      onColumnFiltersChange={onColumnFiltersChange}
      globalFilter={globalFilter}
      onGlobalFilterChange={onGlobalFilterChange}
      pagination={pagination}
      onPaginationChange={onPaginationChange}
    />
  )
}
