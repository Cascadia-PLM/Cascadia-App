import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import {
  Archive,
  Edit,
  Eye,
  FolderTree,
  Library,
  MoreVertical,
  Package,
} from 'lucide-react'
import type { Design } from '@/lib/types/design'
import type {
  ColumnFiltersState,
  DataGridColumn,
  PaginationState,
  Row,
  SortingState,
} from '@/components/ui'
import { Badge, Button, DataGrid } from '@/components/ui'
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

interface DesignWithHierarchy extends Design {
  programCode?: string
  programName?: string
  parentDesignCode?: string
  parentDesignName?: string
  children?: Array<DesignWithHierarchy>
}

interface DesignTableProps {
  items: Array<DesignWithHierarchy>
  onEdit?: (design: Design) => void
  onArchive?: (design: Design) => void
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

// Helper to get icon for design type
function getDesignTypeIcon(designType: string) {
  switch (designType) {
    case 'Family':
      return <FolderTree className="h-4 w-4 text-amber-500" />
    case 'Library':
      return <Library className="h-4 w-4 text-purple-500" />
    default:
      return <Package className="h-4 w-4 text-cyan-500" />
  }
}

// Helper to get badge variant for design type
function getDesignTypeBadgeVariant(
  designType: string,
): 'default' | 'secondary' | 'warning' {
  switch (designType) {
    case 'Family':
      return 'warning'
    case 'Library':
      return 'secondary'
    default:
      return 'default'
  }
}

export function DesignTable({
  items,
  onEdit,
  onArchive,
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
}: DesignTableProps) {
  const columns: Array<DataGridColumn<DesignWithHierarchy>> = [
    {
      id: 'code',
      header: 'Code',
      accessorKey: 'code',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          {getDesignTypeIcon(row.original.designType)}
          <Link
            to="/designs/$id"
            params={{ id: row.original.id }}
            className="font-medium text-cyan-600 dark:text-cyan-400 hover:underline"
          >
            {row.original.code}
          </Link>
        </div>
      ),
    },
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
    },
    {
      id: 'designType',
      header: 'Type',
      accessorKey: 'designType',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Engineering', value: 'Engineering' },
        { label: 'Family', value: 'Family' },
        { label: 'Library', value: 'Library' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string
        return <Badge variant={getDesignTypeBadgeVariant(value)}>{value}</Badge>
      },
    },
    {
      id: 'programCode',
      header: 'Program',
      accessorKey: 'programCode',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ row }) => {
        const programId = row.original.programId
        const programCode = row.original.programCode
        if (!programId || !programCode)
          return <span className="text-slate-400">-</span>
        return (
          <Link
            to="/programs/$id"
            params={{ id: programId }}
            className="text-cyan-600 dark:text-cyan-400 hover:underline"
          >
            {programCode}
          </Link>
        )
      },
    },
    {
      id: 'plannedQuantity',
      header: 'Qty',
      accessorKey: 'plannedQuantity',
      meta: { align: 'right' },
      cell: ({ getValue }) => {
        const value = getValue() as number | null
        return value ? value.toLocaleString() : '-'
      },
    },
    {
      id: 'createdAt',
      header: 'Created',
      accessorKey: 'createdAt',
      cell: ({ getValue }) => {
        const value = getValue() as string | Date | null
        if (!value) return '-'
        return new Date(value).toLocaleDateString()
      },
    },
  ]

  const renderRowActions = (row: Row<DesignWithHierarchy>) => {
    const design = row.original
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8">
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link to="/designs/$id" params={{ id: design.id }}>
              <Eye className="mr-2 h-4 w-4" />
              View details
            </Link>
          </DropdownMenuItem>
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(design)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onArchive && !design.isArchived && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onArchive(design)}
                className="text-orange-600 focus:text-orange-600"
              >
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Context menu items (Edit, Archive)
  const renderContextMenuItems = useCallback(
    (row: Row<DesignWithHierarchy>) => {
      const design = row.original
      const hasActions = onEdit || (onArchive && !design.isArchived)
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(design)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onArchive && !design.isArchived && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onArchive(design)}
                className="text-orange-600 focus:text-orange-600"
              >
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </ContextMenuItem>
            </>
          )}
        </>
      )
    },
    [onEdit, onArchive],
  )

  // Get URL for row (for "Open in new tab")
  const getRowUrl = useCallback((row: DesignWithHierarchy) => {
    return `/designs/${row.id}`
  }, [])

  return (
    <DataGrid
      data={items}
      columns={columns}
      getRowId={(row) => row.id}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      renderContextMenuItems={renderContextMenuItems}
      defaultSorting={defaultSorting}
      defaultColumnFilters={defaultColumnFilters}
      defaultGlobalFilter={defaultGlobalFilter}
      emptyMessage="No designs found"
      emptyDescription="Create your first design to get started"
      exportFilename="designs"
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
