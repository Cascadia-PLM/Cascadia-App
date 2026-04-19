import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { CheckCircle, Edit2, Trash2, XCircle } from 'lucide-react'
import type { WorkflowDefinition } from '@/lib/workflows/types'
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

interface LifecycleTableProps {
  lifecycles: Array<WorkflowDefinition>
  onDelete?: (lifecycle: WorkflowDefinition) => void
}

export function LifecycleTable({ lifecycles, onDelete }: LifecycleTableProps) {
  const columns: Array<DataGridColumn<WorkflowDefinition>> = [
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search lifecycles...',
      cell: ({ row }) =>
        row.original.id ? (
          <Link
            to="/lifecycles/$id"
            params={{ id: row.original.id }}
            className="font-medium text-sky-600 hover:text-sky-800 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
          >
            {row.original.name}
          </Link>
        ) : (
          <span className="font-medium">{row.original.name}</span>
        ),
    },
    {
      id: 'description',
      header: 'Description',
      accessorKey: 'description',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search descriptions...',
      cell: ({ getValue }) => {
        const value = getValue() as string
        return (
          <div className="max-w-xs truncate text-slate-500" title={value}>
            {value || '-'}
          </div>
        )
      },
    },
    {
      id: 'statesCount',
      header: 'States',
      accessorFn: (row) => row.states.length,
      enableSorting: true,
      enableFiltering: true,
      filterType: 'range',
      filterPlaceholder: 'Any',
      meta: { align: 'right' },
    },
    {
      id: 'changeActionsCount',
      header: 'Change Actions',
      accessorFn: (row) => Object.keys(row.changeActionMappings || {}).length,
      enableSorting: true,
      enableFiltering: true,
      filterType: 'range',
      filterPlaceholder: 'Any',
      meta: { align: 'right' },
    },
    {
      id: 'isActive',
      header: 'Status',
      accessorKey: 'isActive',
      enableFiltering: true,
      filterType: 'select',
      filterOptions: [
        { label: 'Active', value: 'true' },
        { label: 'Inactive', value: 'false' },
      ],
      cell: ({ getValue }) => {
        const isActive = getValue() as boolean
        if (isActive) {
          return (
            <Badge variant="success">
              <CheckCircle className="h-3 w-3 mr-1" />
              Active
            </Badge>
          )
        }
        return (
          <Badge variant="secondary">
            <XCircle className="h-3 w-3 mr-1" />
            Inactive
          </Badge>
        )
      },
    },
  ]

  const renderRowActions = (row: Row<WorkflowDefinition>) => {
    const lifecycle = row.original
    const hasActions = lifecycle.id || onDelete
    if (!hasActions) return null

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8">
            <Edit2 className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {lifecycle.id && (
            <DropdownMenuItem asChild>
              <Link to="/lifecycles/$id" params={{ id: lifecycle.id }}>
                <Edit2 className="mr-2 h-4 w-4" />
                Edit lifecycle
              </Link>
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(lifecycle)}
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
    (row: Row<WorkflowDefinition>) => {
      const lifecycle = row.original
      if (!onDelete) return null

      return (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => onDelete(lifecycle)}
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </ContextMenuItem>
        </>
      )
    },
    [onDelete],
  )

  const getRowUrl = useCallback((row: WorkflowDefinition) => {
    return row.id ? `/lifecycles/${row.id}` : undefined
  }, [])

  return (
    <DataGrid
      data={lifecycles}
      columns={columns}
      getRowId={(row) => row.id || row.name}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      renderContextMenuItems={renderContextMenuItems}
      emptyMessage="No lifecycles found"
      emptyDescription="Create your first lifecycle to get started"
      exportFilename="lifecycles"
    />
  )
}
