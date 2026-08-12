// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import type { TestCase } from '@/lib/items/types/testcase'
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

interface TestCaseTableProps {
  testCases: Array<TestCase>
  onEdit?: (testCase: TestCase) => void
  onDelete?: (testCase: TestCase) => void
  // Server-side pagination
  serverSidePagination?: boolean
  totalRows?: number
  onPageChange?: (page: number, pageSize: number) => void
  isLoading?: boolean
}

const stateColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  Draft: 'secondary',
  Proposed: 'default',
  InReview: 'default',
  Approved: 'success',
  Released: 'success',
  Obsolete: 'destructive',
}

const executionColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  NotRun: 'secondary',
  Passed: 'success',
  Failed: 'destructive',
  Blocked: 'warning',
}

export function TestCaseTable({
  testCases,
  onEdit,
  onDelete,
  serverSidePagination,
  totalRows,
  onPageChange,
  isLoading,
}: TestCaseTableProps) {
  const columns: Array<DataGridColumn<TestCase>> = [
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
            to="/test-cases/$id"
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
      id: 'testType',
      header: 'Type',
      accessorKey: 'testType',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Unit', value: 'Unit' },
        { label: 'Integration', value: 'Integration' },
        { label: 'System', value: 'System' },
        { label: 'Acceptance', value: 'Acceptance' },
      ],
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'executionStatus',
      header: 'Result',
      accessorKey: 'executionStatus',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Not Run', value: 'NotRun' },
        { label: 'Passed', value: 'Passed' },
        { label: 'Failed', value: 'Failed' },
        { label: 'Blocked', value: 'Blocked' },
      ],
      cell: ({ getValue }) => {
        const value = (getValue() as string | undefined) ?? 'NotRun'
        return (
          <Badge variant={executionColors[value] ?? 'secondary'}>
            {value === 'NotRun' ? 'Not Run' : value}
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
        { label: 'Proposed', value: 'Proposed' },
        { label: 'In Review', value: 'InReview' },
        { label: 'Approved', value: 'Approved' },
        { label: 'Released', value: 'Released' },
        { label: 'Obsolete', value: 'Obsolete' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string
        return (
          <Badge variant={stateColors[value] ?? 'secondary'}>{value}</Badge>
        )
      },
    },
  ]

  const renderRowActions = (row: Row<TestCase>) => {
    const testCase = row.original
    const hasActions = testCase.id || onEdit || onDelete
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
          {testCase.id && (
            <DropdownMenuItem asChild>
              <Link to="/test-cases/$id" params={{ id: testCase.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(testCase)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(testCase)}
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
    (row: Row<TestCase>) => {
      const testCase = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(testCase)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(testCase)}
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

  const getRowUrl = useCallback((row: TestCase) => {
    return row.id ? `/test-cases/${row.id}` : ''
  }, [])

  return (
    <DataGrid
      data={testCases}
      columns={columns}
      getRowId={(row) => row.id ?? row.itemNumber ?? ''}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      renderContextMenuItems={renderContextMenuItems}
      emptyMessage="No test cases found"
      emptyDescription="Create your first test case to get started"
      exportFilename="test-cases"
      serverSidePagination={serverSidePagination}
      totalRows={totalRows}
      onPageChange={onPageChange}
      isLoading={isLoading}
    />
  )
}
