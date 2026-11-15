// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import {
  INTERFACE_KINDS,
  INTERFACE_KIND_LABELS,
} from '@cascadia/commons/items/types/interface'
import type {
  InterfaceItem,
  InterfaceKind,
} from '@cascadia/commons/items/types/interface'
import type { DataGridColumn, Row } from '@/components/ui'
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
import { StateBadge } from '@/components/items/StateBadge'
import { useLifecyclePhases } from '@/hooks/useLifecyclePhases'

interface InterfaceTableProps {
  interfaces: Array<InterfaceItem>
  onEdit?: (iface: InterfaceItem) => void
  onDelete?: (iface: InterfaceItem) => void
  // Server-side pagination
  serverSidePagination?: boolean
  totalRows?: number
  onPageChange?: (page: number, pageSize: number) => void
  isLoading?: boolean
}

/** The kind as a label; an unknown value (a hand-edited row) shows as is. */
export function interfaceKindLabel(kind: string | null | undefined): string {
  if (!kind) return '-'
  return (INTERFACE_KINDS as ReadonlyArray<string>).includes(kind)
    ? INTERFACE_KIND_LABELS[kind as InterfaceKind]
    : kind
}

export function InterfaceTable({
  interfaces,
  onEdit,
  onDelete,
  serverSidePagination,
  totalRows,
  onPageChange,
  isLoading,
}: InterfaceTableProps) {
  // State filter options and badges come from the type's lifecycle
  // configuration, not from a list in code
  const { data: lifecycle } = useLifecyclePhases('Interface')
  const stateFilterOptions = (lifecycle?.states ?? []).map((state) => ({
    label: state.name,
    value: state.id,
  }))

  const columns: Array<DataGridColumn<InterfaceItem>> = [
    {
      id: 'itemNumber',
      header: 'Item Number',
      accessorKey: 'itemNumber',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search...',
      cell: ({ row }) =>
        row.original.id ? (
          <Link
            to="/interfaces/$id"
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
    },
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'interfaceKind',
      header: 'Kind',
      accessorKey: 'interfaceKind',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: INTERFACE_KINDS.map((kind) => ({
        label: INTERFACE_KIND_LABELS[kind],
        value: kind,
      })),
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return null
        return <Badge variant="outline">{interfaceKindLabel(value)}</Badge>
      },
    },
    {
      id: 'state',
      header: 'State',
      accessorKey: 'state',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: stateFilterOptions,
      cell: ({ getValue }) => (
        <StateBadge itemType="Interface" state={getValue() as string} />
      ),
    },
  ]

  const renderRowActions = (row: Row<InterfaceItem>) => {
    const iface = row.original
    const hasActions = iface.id || onEdit || onDelete
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
          {iface.id && (
            <DropdownMenuItem asChild>
              <Link to="/interfaces/$id" params={{ id: iface.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(iface)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(iface)}
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
    (row: Row<InterfaceItem>) => {
      const iface = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(iface)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(iface)}
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

  const getRowUrl = useCallback((row: InterfaceItem) => {
    return row.id ? `/interfaces/${row.id}` : ''
  }, [])

  return (
    <DataGrid
      data={interfaces}
      columns={columns}
      getRowId={(row) => row.id ?? row.itemNumber ?? ''}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      renderContextMenuItems={renderContextMenuItems}
      emptyMessage="No interfaces found"
      emptyDescription="Create your first interface to get started"
      exportFilename="interfaces"
      serverSidePagination={serverSidePagination}
      totalRows={totalRows}
      onPageChange={onPageChange}
      isLoading={isLoading}
    />
  )
}
