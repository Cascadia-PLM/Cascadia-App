// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import type { KnownToolSubtype, Tool } from '@/lib/items/types/tool'
import type {
  ColumnFiltersState,
  DataGridColumn,
  PaginationState,
  Row,
  SortingState,
} from '@/components/ui'
import { Badge, Button, DataGrid } from '@/components/ui'
import { TOOL_SUBTYPES } from '@/lib/items/types/tool'
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

interface ToolTableProps {
  items: Array<Tool>
  onEdit?: (tool: Tool) => void
  onDelete?: (tool: Tool) => void
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

const statusVariant: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  available: 'success',
  in_use: 'default',
  maintenance: 'warning',
  retired: 'destructive',
}

function subtypeLabel(subtype?: string): string {
  if (!subtype) return ''
  const known = TOOL_SUBTYPES[subtype as KnownToolSubtype] as
    { label: string } | undefined
  return known?.label ?? subtype
}

export function ToolTable({
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
}: ToolTableProps) {
  const columns: Array<DataGridColumn<Tool>> = [
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
            to="/tools/$id"
            params={{ id: row.original.id }}
            className="font-mono text-sm text-sky-600 hover:text-sky-800 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
          >
            {row.original.itemNumber}
          </Link>
        ) : (
          <span className="font-mono text-sm">{row.original.itemNumber}</span>
        ),
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
      id: 'toolType',
      header: 'Type',
      accessorKey: 'toolType',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Manufacturing', value: 'manufacturing' },
        { label: 'Quality', value: 'quality' },
        { label: 'Utility', value: 'utility' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return '-'
        return <span className="capitalize">{value}</span>
      },
    },
    {
      id: 'toolSubtype',
      header: 'Subtype',
      accessorKey: 'toolSubtype',
      enableFiltering: false,
      cell: ({ getValue }) => (
        <span className="text-slate-500 dark:text-slate-400">
          {subtypeLabel(getValue() as string | undefined)}
        </span>
      ),
    },
    {
      id: 'manufacturer',
      header: 'Manufacturer',
      accessorKey: 'manufacturer',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'model',
      header: 'Model',
      accessorKey: 'model',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'toolStatus',
      header: 'Status',
      accessorKey: 'toolStatus',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Available', value: 'available' },
        { label: 'In Use', value: 'in_use' },
        { label: 'Maintenance', value: 'maintenance' },
        { label: 'Retired', value: 'retired' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return '-'
        return (
          <Badge variant={statusVariant[value] ?? 'secondary'}>
            {value.replace('_', ' ')}
          </Badge>
        )
      },
    },
    {
      id: 'location',
      header: 'Location',
      accessorKey: 'location',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
  ]

  const renderRowActions = (row: Row<Tool>) => {
    const tool = row.original
    const hasActions = tool.id || onEdit || onDelete
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
          {tool.id && (
            <DropdownMenuItem asChild>
              <Link to="/tools/$id" params={{ id: tool.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(tool)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(tool)}
                className="text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
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

  const renderContextMenuItems = useCallback(
    (row: Row<Tool>) => {
      const tool = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(tool)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(tool)}
                className="text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
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

  const getRowUrl = useCallback((row: Tool) => {
    return row.id ? `/tools/${row.id}` : ''
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
      emptyMessage="No tools found"
      emptyDescription="Create your first tool to get started"
      exportFilename="tools"
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
