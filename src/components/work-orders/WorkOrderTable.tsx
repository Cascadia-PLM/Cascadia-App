import { Link } from '@tanstack/react-router'
import { Edit, Eye, MoreVertical, Trash2 } from 'lucide-react'
import { WorkOrderStatusBadge } from './WorkOrderStatusBadge'
import type {
  WorkOrder,
  WorkOrderPriority,
  WorkOrderStatus,
} from '@/lib/items/types/work-order'
import type { DataGridColumn } from '@/components/ui'
import { Badge, Button, DataGrid } from '@/components/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'

interface WorkOrderTableProps {
  items: Array<WorkOrder>
  onView?: (workOrder: WorkOrder) => void
  onEdit?: (workOrder: WorkOrder) => void
  onDelete?: (workOrder: WorkOrder) => void
}

const priorityColors: Record<string, string> = {
  Low: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  Normal: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300',
  High: 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300',
  Urgent: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-300',
}

export function WorkOrderTable({
  items,
  onView,
  onEdit,
  onDelete,
}: WorkOrderTableProps) {
  const columns: Array<DataGridColumn<WorkOrder>> = [
    {
      id: 'workOrderNumber',
      header: 'WO Number',
      accessorKey: 'workOrderNumber',
      enableFiltering: true,
      cell: ({ row }) => (
        <Link
          to="/work-orders/$id"
          params={{ id: row.original.id }}
          className="font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300"
        >
          {row.original.workOrderNumber}
        </Link>
      ),
    },
    {
      id: 'part',
      header: 'Part',
      accessorFn: (row) =>
        row.part ? `${row.part.itemNumber} ${row.part.name || ''}` : '—',
      cell: ({ row }) =>
        row.original.part ? (
          <span className="text-sm">
            <span className="font-medium">{row.original.part.itemNumber}</span>
            {row.original.part.name && (
              <span className="text-slate-500 ml-1">
                {row.original.part.name}
              </span>
            )}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'quantity',
      header: 'Qty',
      accessorKey: 'quantity',
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.quantityCompleted}/{row.original.quantity}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      enableFiltering: true,
      cell: ({ row }) => <WorkOrderStatusBadge status={row.original.status} />,
    },
    {
      id: 'priority',
      header: 'Priority',
      accessorKey: 'priority',
      enableFiltering: true,
      cell: ({ row }) => {
        const priority = row.original.priority
        return (
          <Badge variant="secondary" className={priorityColors[priority] || ''}>
            {priority}
          </Badge>
        )
      },
    },
    {
      id: 'dueDate',
      header: 'Due Date',
      accessorKey: 'dueDate',
      enableSorting: true,
      cell: ({ row }) => {
        const due = row.original.dueDate
        if (!due) return <span className="text-slate-400">—</span>
        const d = new Date(due)
        const isOverdue =
          d < new Date() &&
          row.original.status !== 'Complete' &&
          row.original.status !== 'Cancelled'
        return (
          <span className={isOverdue ? 'text-red-600 font-medium' : ''}>
            {d.toLocaleDateString()}
          </span>
        )
      },
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onView?.(row.original)}>
              <Eye className="h-4 w-4 mr-2" />
              View
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit?.(row.original)}>
              <Edit className="h-4 w-4 mr-2" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-600"
              onClick={() => onDelete?.(row.original)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  return (
    <DataGrid
      data={items}
      columns={columns}
      emptyMessage="No work orders found"
      enablePagination
      enableGlobalFilter
    />
  )
}
