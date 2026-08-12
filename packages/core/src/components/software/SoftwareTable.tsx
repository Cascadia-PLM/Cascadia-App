// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import type { Software } from '@/lib/items/types/software'
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

interface SoftwareTableProps {
  items: Array<Software>
  onEdit?: (sw: Software) => void
  onDelete?: (sw: Software) => void
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

const stateVariant: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  Draft: 'secondary',
  InReview: 'default',
  Approved: 'success',
  Released: 'success',
  Obsolete: 'destructive',
}

export function SoftwareTable({
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
}: SoftwareTableProps) {
  const columns: Array<DataGridColumn<Software>> = [
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
            to="/software/$id"
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
      id: 'revision',
      header: 'Rev',
      accessorKey: 'revision',
      enableFiltering: false,
      cell: ({ getValue }) => (
        <span className="font-mono text-sm">{getValue() as string}</span>
      ),
    },
    {
      id: 'softwareType',
      header: 'Type',
      accessorKey: 'softwareType',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Firmware', value: 'firmware' },
        { label: 'Application', value: 'application' },
        { label: 'Library', value: 'library' },
        { label: 'Configuration', value: 'configuration' },
        { label: 'FPGA', value: 'fpga' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return '-'
        return <span className="capitalize">{value}</span>
      },
    },
    {
      id: 'version',
      header: 'Version',
      accessorKey: 'version',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        return value ? <span className="font-mono text-sm">{value}</span> : '-'
      },
    },
    {
      id: 'targetHardware',
      header: 'Target Hardware',
      accessorKey: 'targetHardware',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'sourceMode',
      header: 'Source',
      accessorKey: 'sourceMode',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Internal', value: 'internal' },
        { label: 'External', value: 'external' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return '-'
        return (
          <Badge variant={value === 'internal' ? 'default' : 'secondary'}>
            {value}
          </Badge>
        )
      },
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
        const value = getValue() as string | undefined
        if (!value) return '-'
        return (
          <Badge variant={stateVariant[value] ?? 'secondary'}>{value}</Badge>
        )
      },
    },
  ]

  const renderRowActions = (row: Row<Software>) => {
    const sw = row.original
    const hasActions = sw.id || onEdit || onDelete
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
          {sw.id && (
            <DropdownMenuItem asChild>
              <Link to="/software/$id" params={{ id: sw.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(sw)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(sw)}
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
    (row: Row<Software>) => {
      const sw = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(sw)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(sw)}
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

  const getRowUrl = useCallback((row: Software) => {
    return row.id ? `/software/${row.id}` : ''
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
      emptyMessage="No software items found"
      emptyDescription="Create your first software item to get started"
      exportFilename="software"
      serverSidePagination={serverSidePagination}
      totalRows={totalRows}
      onPageChange={onPageChange}
      isLoading={isLoading}
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
