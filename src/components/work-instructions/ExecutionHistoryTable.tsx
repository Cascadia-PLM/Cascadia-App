import { Link } from '@tanstack/react-router'
import type { DataGridColumn } from '@/components/ui'
import type { WorkInstructionExecution } from '@/lib/items/types/work-instruction'
import { Badge, DataGrid } from '@/components/ui'
import { cn } from '@/lib/utils'

interface ExecutionHistoryTableProps {
  executions: Array<WorkInstructionExecution>
  showWorkInstruction?: boolean
}

const statusConfig: Record<string, { className: string; label: string }> = {
  'In Progress': {
    className:
      'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
    label: 'In Progress',
  },
  Complete: {
    className:
      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    label: 'Complete',
  },
  Incomplete: {
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    label: 'Incomplete',
  },
  'Pending Approval': {
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    label: 'Pending Approval',
  },
  Approved: {
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    label: 'Approved',
  },
  Rejected: {
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    label: 'Rejected',
  },
}

function formatDuration(seconds?: number | null): string {
  if (!seconds) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (minutes < 60) return `${minutes}m ${secs}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours}h ${mins}m`
}

export function ExecutionHistoryTable({
  executions,
  showWorkInstruction,
}: ExecutionHistoryTableProps) {
  const columns: Array<DataGridColumn<WorkInstructionExecution>> = [
    {
      id: 'executor',
      header: 'Executor',
      accessorFn: (row) => row.executor?.name || row.executor?.email || '—',
      cell: ({ row }) => (
        <span className="font-medium">
          {row.original.executor?.name || row.original.executor?.email || '—'}
        </span>
      ),
    },
    ...(showWorkInstruction
      ? [
          {
            id: 'workInstruction',
            header: 'Work Instruction',
            accessorFn: (row) => {
              const wi = (row as unknown as Record<string, unknown>)
                .workInstruction as { itemNumber: string } | null
              return wi?.itemNumber || '—'
            },
            cell: ({ row }) => {
              const wi = (row.original as unknown as Record<string, unknown>)
                .workInstruction as {
                id: string
                itemNumber: string
              } | null
              return wi ? (
                <Link
                  to="/work-instructions/$id"
                  params={{ id: wi.id }}
                  className="text-sky-600 hover:text-sky-700 font-medium"
                >
                  {wi.itemNumber}
                </Link>
              ) : (
                '—'
              )
            },
          } as DataGridColumn<WorkInstructionExecution>,
        ]
      : []),
    {
      id: 'workOrder',
      header: 'Work Order',
      accessorFn: (row) => row.workOrder?.workOrderNumber || '—',
      cell: ({ row }) =>
        row.original.workOrder ? (
          <Link
            to="/work-orders/$id"
            params={{ id: row.original.workOrder.id }}
            className="text-sky-600 hover:text-sky-700"
          >
            {row.original.workOrder.workOrderNumber}
          </Link>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      enableFiltering: true,
      cell: ({ row }) => {
        const config =
          statusConfig[row.original.status] || statusConfig['In Progress']
        return (
          <Badge
            variant="secondary"
            className={cn('font-medium', config.className)}
          >
            {config.label}
          </Badge>
        )
      },
    },
    {
      id: 'startedAt',
      header: 'Started',
      accessorKey: 'startedAt',
      enableSorting: true,
      cell: ({ row }) => (
        <span className="text-sm">
          {new Date(row.original.startedAt).toLocaleString()}
        </span>
      ),
    },
    {
      id: 'duration',
      header: 'Duration',
      accessorKey: 'duration',
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatDuration(row.original.duration)}
        </span>
      ),
    },
    {
      id: 'dataFields',
      header: 'Data Fields',
      accessorFn: (row) => Object.keys(row.stepData).length,
      cell: ({ row }) => {
        const count = Object.keys(row.original.stepData).length
        return count > 0 ? (
          <span className="text-sm font-medium text-emerald-600">
            {count} captured
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )
      },
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Link
            to="/work-instructions/$id/executions/$executionId"
            params={{
              id: row.original.workInstructionId,
              executionId: row.original.id,
            }}
            className="text-sm text-sky-600 hover:text-sky-700 font-medium"
          >
            {row.original.status === 'Pending Approval' ? 'Review' : 'View'}
          </Link>
        </div>
      ),
    },
  ]

  return (
    <DataGrid
      data={executions}
      columns={columns}
      emptyMessage="No executions found"
      enablePagination
    />
  )
}
