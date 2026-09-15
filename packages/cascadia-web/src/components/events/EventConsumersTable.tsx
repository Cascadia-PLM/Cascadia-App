// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { MoreVertical, RotateCcw, SkipForward, Trash2 } from 'lucide-react'
import type { DataGridColumn, Row } from '@/components/ui'
import type { EventConsumerStatus } from '@/lib/query'
import { Badge, Button, DataGrid } from '@/components/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'

export interface EventConsumersTableProps {
  consumers: Array<EventConsumerStatus>
  latestSeq: number
  onResume: (consumer: EventConsumerStatus) => void
  onSkip: (consumer: EventConsumerStatus) => void
  onForget: (consumer: EventConsumerStatus) => void
  onViewError: (consumer: EventConsumerStatus) => void
  busyId?: string | null
}

const DESTRUCTIVE_ITEM =
  'text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400'

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

/**
 * Cursor state for every event consumer, with the actions an operator has.
 *
 * Two presentation rules that look like details and are not:
 *
 * - **`registeredHere: false` is not a fault** and must not render as one.
 *   Each process registers only the consumers it runs — the RabbitMQ relay and
 *   the webhook dispatcher run in the jobs worker alone — so the process
 *   serving this page legitimately reports false for those. What says "nothing
 *   is draining this" is lag that grows while `updatedAt` stays stale — which
 *   is why this table shows both columns next to each other instead of a
 *   single health light.
 * - **Abandoned is worse than parked**, and is shown as such. A parked consumer
 *   still holds its backlog and the retention horizon with it; an abandoned one
 *   has forfeited both and has to be re-registered to come back.
 */
export function EventConsumersTable({
  consumers,
  latestSeq,
  onResume,
  onSkip,
  onForget,
  onViewError,
  busyId = null,
}: EventConsumersTableProps) {
  const columns: Array<DataGridColumn<EventConsumerStatus>> = [
    {
      id: 'id',
      header: 'Consumer',
      accessorKey: 'id',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter by id...',
      cell: ({ getValue }) => (
        <span className="font-mono text-sm text-slate-700 dark:text-slate-200">
          {getValue() as string}
        </span>
      ),
    },
    {
      id: 'state',
      header: 'State',
      accessorFn: (row) =>
        row.abandonedAt
          ? 'abandoned'
          : row.parkedAt
            ? 'parked'
            : row.nextAttemptAt
              ? 'retrying'
              : row.lag > 0
                ? 'behind'
                : 'current',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Current', value: 'current' },
        { label: 'Behind', value: 'behind' },
        { label: 'Retrying', value: 'retrying' },
        { label: 'Parked', value: 'parked' },
        { label: 'Abandoned', value: 'abandoned' },
      ],
      cell: ({ getValue }) => {
        const state = getValue() as string
        if (state === 'abandoned') {
          return (
            <Badge
              variant="destructive"
              title="Retention gave up waiting: this backlog is forfeit and the consumer must be re-registered"
            >
              abandoned
            </Badge>
          )
        }
        if (state === 'parked') {
          return (
            <Badge
              variant="destructive"
              title="Stopped retrying after repeated failures — resume it, or skip the event it is stuck on"
            >
              parked
            </Badge>
          )
        }
        if (state === 'retrying')
          return <Badge variant="warning">retrying</Badge>
        if (state === 'behind') return <Badge variant="outline">behind</Badge>
        return <Badge variant="success">current</Badge>
      },
    },
    {
      id: 'lag',
      header: 'Lag',
      accessorKey: 'lag',
      cell: ({ getValue }) => {
        const lag = getValue() as number
        return (
          <span
            className={
              lag > 0
                ? 'font-medium text-amber-600 dark:text-amber-400'
                : 'text-slate-500 dark:text-slate-400'
            }
          >
            {lag > 0 ? lag.toLocaleString() : '—'}
          </span>
        )
      },
    },
    {
      id: 'cursor',
      header: 'Cursor',
      accessorKey: 'lastSeq',
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {(getValue() as number).toLocaleString()} /{' '}
          {latestSeq.toLocaleString()}
        </span>
      ),
    },
    {
      id: 'failures',
      header: 'Failures',
      accessorKey: 'failureCount',
      cell: ({ row }) => {
        const consumer = row.original
        if (consumer.failureCount === 0) {
          return <span className="text-slate-500 dark:text-slate-400">—</span>
        }
        return (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-red-600 dark:text-red-400"
            onClick={() => onViewError(consumer)}
          >
            {consumer.failureCount} — see error
          </Button>
        )
      },
    },
    {
      id: 'updatedAt',
      header: 'Last progress',
      accessorKey: 'updatedAt',
      cell: ({ getValue }) => (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {formatWhen(getValue() as string)}
        </span>
      ),
    },
    {
      id: 'registeredHere',
      header: 'Polled by',
      accessorKey: 'registeredHere',
      cell: ({ getValue }) => {
        const here = getValue() as boolean
        // Deliberately neutral in both cases: see the rule in this file's
        // docstring. `false` is what an API process reports for every
        // consumer, and rendering it as a warning would cry wolf on every row.
        return (
          <span
            className="text-xs text-slate-500 dark:text-slate-400"
            title={
              here
                ? 'This process registers the consumer and polls it'
                : 'Registered in another process — the jobs worker, for the relay and the webhook dispatcher. The usual reading, not a fault.'
            }
          >
            {here ? 'this process' : 'elsewhere'}
          </span>
        )
      },
    },
  ]

  const renderRowActions = (row: Row<EventConsumerStatus>) => {
    const consumer = row.original
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            disabled={busyId === consumer.id}
          >
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* An abandoned consumer's backlog may already be pruned, so the
              server refuses both actions; forgetting it is the way back. */}
          <DropdownMenuItem
            onClick={() => onResume(consumer)}
            disabled={consumer.abandonedAt !== null}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Resume
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onSkip(consumer)}
            disabled={
              consumer.lastErrorSeq === null || consumer.abandonedAt !== null
            }
          >
            <SkipForward className="mr-2 h-4 w-4" />
            Skip the failing event
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => onForget(consumer)}
            className={DESTRUCTIVE_ITEM}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Forget this cursor
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <DataGrid
      data={consumers}
      columns={columns}
      getRowId={(consumer) => consumer.id}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      emptyMessage="No consumer has a cursor yet"
      emptyDescription="A cursor row appears the first time a consumer runs."
    />
  )
}
