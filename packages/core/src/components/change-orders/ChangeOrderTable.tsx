// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { AlertCircle, Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import type { ChangeOrder } from '@/lib/items/types/change-order'
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
import { useLifecyclePhases } from '@/lib/hooks/useLifecyclePhases'

interface ChangeOrderTableProps {
  items: Array<ChangeOrder>
  onEdit?: (changeOrder: ChangeOrder) => void
  onDelete?: (changeOrder: ChangeOrder) => void
  // Server-side pagination
  serverSidePagination?: boolean
  totalRows?: number
  onPageChange?: (page: number, pageSize: number) => void
  isLoading?: boolean
}

const priorityColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  low: 'secondary',
  medium: 'default',
  high: 'warning',
  critical: 'destructive',
}

const riskLevelColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  low: 'success',
  medium: 'warning',
  high: 'destructive',
  critical: 'destructive',
}

const changeTypeLabels: Record<string, string> = {
  ECO: 'ECO',
  ECN: 'ECN',
  MCO: 'MCO',
  Deviation: 'DEV',
}

export function ChangeOrderTable({
  items,
  onEdit,
  onDelete,
  serverSidePagination,
  totalRows,
  onPageChange,
  isLoading,
}: ChangeOrderTableProps) {
  // State filter options and badges come from the ChangeOrder lifecycle's
  // configuration, not from a list in code
  const { data: lifecycle } = useLifecyclePhases('ChangeOrder')
  const stateFilterOptions = (lifecycle?.states ?? []).map((state) => ({
    label: state.name,
    value: state.id,
  }))

  // The server refuses to hard-delete a change order that has left its initial
  // state — past that it holds votes, workflow history and an affected-item
  // list that the delete would cascade away. Offering the action anyway would
  // be offering a guaranteed error, so the menu item follows the same rule.
  // A hint, not the gate: ItemService.delete is the gate.
  const isDeletable = useCallback(
    (co: ChangeOrder) =>
      (lifecycle?.states ?? []).some(
        (state) => state.isInitial === true && state.id === co.state,
      ),
    [lifecycle],
  )

  const columns: Array<DataGridColumn<ChangeOrder>> = [
    {
      id: 'itemNumber',
      header: 'CO Number',
      accessorKey: 'itemNumber',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search...',
      cell: ({ row }) =>
        row.original.id ? (
          <Link
            to="/change-orders/$id"
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
      cell: ({ getValue }) => {
        const value = getValue() as string
        return (
          <div className="max-w-xs truncate" title={value}>
            {value || '-'}
          </div>
        )
      },
    },
    {
      id: 'changeType',
      header: 'Type',
      accessorKey: 'changeType',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'ECO', value: 'ECO' },
        { label: 'ECN', value: 'ECN' },
        { label: 'MCO', value: 'MCO' },
        { label: 'Deviation', value: 'Deviation' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string
        return (
          <Badge variant="default">{changeTypeLabels[value] || value}</Badge>
        )
      },
    },
    {
      id: 'priority',
      header: 'Priority',
      accessorKey: 'priority',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Low', value: 'low' },
        { label: 'Medium', value: 'medium' },
        { label: 'High', value: 'high' },
        { label: 'Critical', value: 'critical' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return null
        return <Badge variant={priorityColors[value]}>{value}</Badge>
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
        <StateBadge itemType="ChangeOrder" state={getValue() as string} />
      ),
    },
    {
      id: 'riskLevel',
      header: 'Risk Level',
      accessorKey: 'riskLevel',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Low', value: 'low' },
        { label: 'Medium', value: 'medium' },
        { label: 'High', value: 'high' },
        { label: 'Critical', value: 'critical' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return <span className="text-slate-400">-</span>

        return (
          <div className="flex items-center gap-1">
            {(value === 'high' || value === 'critical') && (
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
            )}
            <Badge variant={riskLevelColors[value]}>{value}</Badge>
          </div>
        )
      },
    },
  ]

  const renderRowActions = (row: Row<ChangeOrder>) => {
    const co = row.original
    const canDelete = onDelete && isDeletable(co)
    const hasActions = co.id || onEdit || canDelete
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
          {co.id && (
            <DropdownMenuItem asChild>
              <Link to="/change-orders/$id" params={{ id: co.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(co)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(co)}
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
    (row: Row<ChangeOrder>) => {
      const co = row.original
      const canDelete = onDelete && isDeletable(co)
      const hasActions = onEdit || canDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(co)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {canDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(co)}
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
    [onEdit, onDelete, isDeletable],
  )

  const getRowUrl = useCallback((row: ChangeOrder) => {
    return row.id ? `/change-orders/${row.id}` : ''
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
      emptyMessage="No change orders found"
      emptyDescription="Create your first change order to get started"
      exportFilename="change-orders"
      serverSidePagination={serverSidePagination}
      totalRows={totalRows}
      onPageChange={onPageChange}
      isLoading={isLoading}
    />
  )
}
