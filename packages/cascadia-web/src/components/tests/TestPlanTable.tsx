// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import type { TestPlan } from '@/lib/items/types/testplan'
import type { DataGridColumn, Row } from '@/components/ui'
import { Button, DataGrid } from '@/components/ui'
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

interface TestPlanTableProps {
  testPlans: Array<TestPlan>
  onEdit?: (testPlan: TestPlan) => void
  onDelete?: (testPlan: TestPlan) => void
  // Server-side pagination
  serverSidePagination?: boolean
  totalRows?: number
  onPageChange?: (page: number, pageSize: number) => void
  isLoading?: boolean
}

export function TestPlanTable({
  testPlans,
  onEdit,
  onDelete,
  serverSidePagination,
  totalRows,
  onPageChange,
  isLoading,
}: TestPlanTableProps) {
  // State filter options and badges come from the TestPlan lifecycle's
  // configuration, not from a list in code
  const { data: lifecycle } = useLifecyclePhases('TestPlan')
  const stateFilterOptions = (lifecycle?.states ?? []).map((state) => ({
    label: state.name,
    value: state.id,
  }))

  const columns: Array<DataGridColumn<TestPlan>> = [
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
            to="/test-plans/$id"
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
      id: 'environment',
      header: 'Environment',
      accessorKey: 'environment',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter environment...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'state',
      header: 'State',
      accessorKey: 'state',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: stateFilterOptions,
      cell: ({ getValue }) => (
        <StateBadge itemType="TestPlan" state={getValue() as string} />
      ),
    },
  ]

  const renderRowActions = (row: Row<TestPlan>) => {
    const testPlan = row.original
    const hasActions = testPlan.id || onEdit || onDelete
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
          {testPlan.id && (
            <DropdownMenuItem asChild>
              <Link to="/test-plans/$id" params={{ id: testPlan.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(testPlan)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(testPlan)}
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
    (row: Row<TestPlan>) => {
      const testPlan = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(testPlan)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(testPlan)}
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

  const getRowUrl = useCallback((row: TestPlan) => {
    return row.id ? `/test-plans/${row.id}` : ''
  }, [])

  return (
    <DataGrid
      data={testPlans}
      columns={columns}
      getRowId={(row) => row.id ?? row.itemNumber ?? ''}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      renderContextMenuItems={renderContextMenuItems}
      emptyMessage="No test plans found"
      emptyDescription="Create your first test plan to get started"
      exportFilename="test-plans"
      serverSidePagination={serverSidePagination}
      totalRows={totalRows}
      onPageChange={onPageChange}
      isLoading={isLoading}
    />
  )
}
