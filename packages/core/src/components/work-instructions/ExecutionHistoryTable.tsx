// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import type { DataGridColumn } from '@/components/ui'
import type { InstructionExecution } from '@/lib/items/types/work-order'
import { Badge, DataGrid } from '@/components/ui'
import { cn } from '@/lib/utils'

interface ExecutionHistoryTableProps {
  executions: Array<InstructionExecution>
  /** Owning work order — review links are scoped to it. */
  workOrderId: string
}

const inProgressStatus = {
  className:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  label: 'In Progress',
}

const statusConfig: Record<string, { className: string; label: string }> = {
  'In Progress': inProgressStatus,
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
  workOrderId,
}: ExecutionHistoryTableProps) {
  const columns: Array<DataGridColumn<InstructionExecution>> = [
    {
      id: 'instruction',
      header: 'Instruction',
      accessorFn: (row) => row.instruction?.title || '—',
      cell: ({ row }) => (
        <span className="font-medium">
          {row.original.instruction?.title || '—'}
        </span>
      ),
    },
    {
      id: 'executor',
      header: 'Executor',
      accessorFn: (row) => row.executor?.name || row.executor?.email || '—',
      cell: ({ row }) => (
        <span>
          {row.original.executor?.name || row.original.executor?.email || '—'}
        </span>
      ),
    },
    {
      id: 'unit',
      header: 'Unit',
      accessorFn: (row) => row.unitLabel || '—',
      cell: ({ row }) =>
        row.original.unitLabel ? (
          <span className="font-mono text-sm">{row.original.unitLabel}</span>
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
        const config = statusConfig[row.original.status] ?? inProgressStatus
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
          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
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
            to="/work-orders/$id/executions/$executionId"
            params={{
              id: workOrderId,
              executionId: row.original.id,
            }}
            className="text-sm text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 font-medium"
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
