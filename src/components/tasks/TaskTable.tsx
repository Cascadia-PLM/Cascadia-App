import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import type { Task } from '@/lib/items/types/task'
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

interface TaskTableProps {
  items: Array<Task>
  onEdit?: (task: Task) => void
  onDelete?: (task: Task) => void
}

const stateColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  Backlog: 'secondary',
  ToDo: 'default',
  InProgress: 'warning',
  InReview: 'default',
  Done: 'success',
  Cancelled: 'destructive',
}

const priorityColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  Low: 'secondary',
  Medium: 'default',
  High: 'warning',
  Critical: 'destructive',
}

const formatDate = (date?: string | Date) => {
  if (!date) return '-'
  try {
    return new Date(date).toLocaleDateString()
  } catch {
    return '-'
  }
}

export function TaskTable({ items, onEdit, onDelete }: TaskTableProps) {
  const columns: Array<DataGridColumn<Task>> = [
    {
      id: 'itemNumber',
      header: 'Task Number',
      accessorKey: 'itemNumber',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search...',
      cell: ({ row }) =>
        row.original.id ? (
          <Link
            to="/tasks/$id"
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
          <div className="max-w-md truncate" title={value}>
            {value || '-'}
          </div>
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
        { label: 'Low', value: 'Low' },
        { label: 'Medium', value: 'Medium' },
        { label: 'High', value: 'High' },
        { label: 'Critical', value: 'Critical' },
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
      filterOptions: [
        { label: 'Backlog', value: 'Backlog' },
        { label: 'To Do', value: 'ToDo' },
        { label: 'In Progress', value: 'InProgress' },
        { label: 'In Review', value: 'InReview' },
        { label: 'Done', value: 'Done' },
        { label: 'Cancelled', value: 'Cancelled' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string
        return (
          <Badge variant={stateColors[value] ?? 'secondary'}>{value}</Badge>
        )
      },
    },
    {
      id: 'dueDate',
      header: 'Due Date',
      accessorKey: 'dueDate',
      enableSorting: true,
      cell: ({ getValue }) =>
        formatDate(getValue() as string | Date | undefined),
    },
    {
      id: 'estimatedHours',
      header: 'Est. Hours',
      accessorKey: 'estimatedHours',
      enableSorting: true,
      enableFiltering: true,
      filterType: 'range',
      filterPlaceholder: 'Any',
      meta: { align: 'right' },
      cell: ({ getValue }) => {
        const value = getValue() as number | undefined
        return value || '-'
      },
    },
  ]

  const renderRowActions = (row: Row<Task>) => {
    const task = row.original
    const hasActions = task.id || onEdit || onDelete
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
          {task.id && (
            <DropdownMenuItem asChild>
              <Link to="/tasks/$id" params={{ id: task.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(task)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(task)}
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
    (row: Row<Task>) => {
      const task = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(task)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(task)}
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

  const getRowUrl = useCallback((row: Task) => {
    return row.id ? `/tasks/${row.id}` : ''
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
      emptyMessage="No tasks found"
      emptyDescription="Create your first task to get started"
      exportFilename="tasks"
    />
  )
}
