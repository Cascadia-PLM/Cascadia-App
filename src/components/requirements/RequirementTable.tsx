import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import type { Requirement } from '@/lib/items/types/requirement'
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

interface RequirementTableProps {
  requirements: Array<Requirement>
  onEdit?: (requirement: Requirement) => void
  onDelete?: (requirement: Requirement) => void
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
  Implemented: 'success',
  Verified: 'success',
  Rejected: 'destructive',
}

const priorityColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  MustHave: 'destructive',
  ShouldHave: 'warning',
  CouldHave: 'default',
  WontHave: 'secondary',
}

const priorityLabels: Record<string, string> = {
  MustHave: 'Must Have',
  ShouldHave: 'Should Have',
  CouldHave: 'Could Have',
  WontHave: "Won't Have",
}

export function RequirementTable({
  requirements,
  onEdit,
  onDelete,
  serverSidePagination,
  totalRows,
  onPageChange,
  isLoading,
}: RequirementTableProps) {
  const columns: Array<DataGridColumn<Requirement>> = [
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
            to="/requirements/$id"
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
      id: 'type',
      header: 'Type',
      accessorKey: 'type',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter type...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'priority',
      header: 'Priority',
      accessorKey: 'priority',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Must Have', value: 'MustHave' },
        { label: 'Should Have', value: 'ShouldHave' },
        { label: 'Could Have', value: 'CouldHave' },
        { label: "Won't Have", value: 'WontHave' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return null
        return (
          <Badge variant={priorityColors[value]}>
            {priorityLabels[value] || value}
          </Badge>
        )
      },
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter status...',
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
        { label: 'Proposed', value: 'Proposed' },
        { label: 'In Review', value: 'InReview' },
        { label: 'Approved', value: 'Approved' },
        { label: 'Implemented', value: 'Implemented' },
        { label: 'Verified', value: 'Verified' },
        { label: 'Rejected', value: 'Rejected' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string
        return (
          <Badge variant={stateColors[value] ?? 'secondary'}>{value}</Badge>
        )
      },
    },
  ]

  const renderRowActions = (row: Row<Requirement>) => {
    const requirement = row.original
    const hasActions = requirement.id || onEdit || onDelete
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
          {requirement.id && (
            <DropdownMenuItem asChild>
              <Link to="/requirements/$id" params={{ id: requirement.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(requirement)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(requirement)}
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

  const renderContextMenuItems = useCallback(
    (row: Row<Requirement>) => {
      const requirement = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(requirement)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(requirement)}
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

  const getRowUrl = useCallback((row: Requirement) => {
    return row.id ? `/requirements/${row.id}` : ''
  }, [])

  return (
    <DataGrid
      data={requirements}
      columns={columns}
      getRowId={(row) => row.id ?? row.itemNumber ?? ''}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      renderContextMenuItems={renderContextMenuItems}
      emptyMessage="No requirements found"
      emptyDescription="Create your first requirement to get started"
      exportFilename="requirements"
      serverSidePagination={serverSidePagination}
      totalRows={totalRows}
      onPageChange={onPageChange}
      isLoading={isLoading}
    />
  )
}
