import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import type { Issue } from '@/lib/items/types/issue'
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

interface IssueTableProps {
  items: Array<Issue>
  onEdit?: (issue: Issue) => void
  onDelete?: (issue: Issue) => void
  // Server-side pagination
  serverSidePagination?: boolean
  totalRows?: number
  onPageChange?: (page: number, pageSize: number) => void
  isLoading?: boolean
}

const severityVariant = (
  severity: string,
): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Critical: 'destructive',
    High: 'warning',
    Medium: 'default',
    Low: 'secondary',
  }
  return variants[severity] || 'default'
}

const priorityVariant = (
  priority: string,
): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Critical: 'destructive',
    High: 'warning',
    Medium: 'default',
    Low: 'secondary',
  }
  return variants[priority] || 'default'
}

const stateVariant = (
  state: string,
): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Open: 'default',
    InProgress: 'warning',
    Pending: 'secondary',
    Resolved: 'success',
    Verified: 'success',
    Closed: 'secondary',
    Cancelled: 'destructive',
  }
  return variants[state] || 'default'
}

const stateLabel = (state: string): string => {
  const labels: Record<string, string> = {
    Open: 'Open',
    InProgress: 'In Progress',
    Pending: 'Pending',
    Resolved: 'Resolved',
    Verified: 'Verified',
    Closed: 'Closed',
    Cancelled: 'Cancelled',
  }
  return labels[state] || state
}

const formatDate = (date?: string | Date) => {
  if (!date) return '-'
  try {
    return new Date(date).toLocaleDateString()
  } catch {
    return '-'
  }
}

export function IssueTable({
  items,
  onEdit,
  onDelete,
  serverSidePagination,
  totalRows,
  onPageChange,
  isLoading,
}: IssueTableProps) {
  const columns: Array<DataGridColumn<Issue>> = [
    {
      id: 'itemNumber',
      header: 'Issue #',
      accessorKey: 'itemNumber',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search...',
      cell: ({ row }) =>
        row.original.id ? (
          <Link
            to="/issues/$id"
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
      header: 'Title',
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
      id: 'state',
      header: 'State',
      accessorKey: 'state',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Open', value: 'Open' },
        { label: 'In Progress', value: 'InProgress' },
        { label: 'Pending', value: 'Pending' },
        { label: 'Resolved', value: 'Resolved' },
        { label: 'Verified', value: 'Verified' },
        { label: 'Closed', value: 'Closed' },
        { label: 'Cancelled', value: 'Cancelled' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string
        return (
          <Badge variant={stateVariant(value || 'Open')}>
            {stateLabel(value || 'Open')}
          </Badge>
        )
      },
    },
    {
      id: 'severity',
      header: 'Severity',
      accessorKey: 'severity',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Critical', value: 'Critical' },
        { label: 'High', value: 'High' },
        { label: 'Medium', value: 'Medium' },
        { label: 'Low', value: 'Low' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return '-'
        return <Badge variant={severityVariant(value)}>{value}</Badge>
      },
    },
    {
      id: 'priority',
      header: 'Priority',
      accessorKey: 'priority',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Critical', value: 'Critical' },
        { label: 'High', value: 'High' },
        { label: 'Medium', value: 'Medium' },
        { label: 'Low', value: 'Low' },
      ],
      cell: ({ getValue }) => {
        const value = getValue() as string | undefined
        if (!value) return '-'
        return <Badge variant={priorityVariant(value)}>{value}</Badge>
      },
    },
    {
      id: 'category',
      header: 'Category',
      accessorKey: 'category',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Design', value: 'Design' },
        { label: 'Manufacturing', value: 'Manufacturing' },
        { label: 'Quality', value: 'Quality' },
        { label: 'Customer', value: 'Customer' },
        { label: 'Safety', value: 'Safety' },
        { label: 'Other', value: 'Other' },
      ],
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'createdAt',
      header: 'Created',
      accessorKey: 'createdAt',
      enableSorting: true,
      cell: ({ getValue }) =>
        formatDate(getValue() as string | Date | undefined),
    },
  ]

  const renderRowActions = (row: Row<Issue>) => {
    const issue = row.original
    const hasActions = issue.id || onEdit || onDelete
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
          {issue.id && (
            <DropdownMenuItem asChild>
              <Link to="/issues/$id" params={{ id: issue.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(issue)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(issue)}
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
    (row: Row<Issue>) => {
      const issue = row.original
      const hasActions = onEdit || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(issue)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(issue)}
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

  const getRowUrl = useCallback((row: Issue) => {
    return row.id ? `/issues/${row.id}` : ''
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
      emptyMessage="No issues found"
      emptyDescription="Create your first issue to get started"
      exportFilename="issues"
      serverSidePagination={serverSidePagination}
      totalRows={totalRows}
      onPageChange={onPageChange}
      isLoading={isLoading}
    />
  )
}
