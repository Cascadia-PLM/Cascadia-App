// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  KeyRound,
  ListOrdered,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react'
import type { DataGridColumn, Row } from '@/components/ui'
import type { WebhookSubscription } from '@/lib/query'
import { Badge, Button, DataGrid } from '@/components/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'

export interface WebhookSubscriptionsTableProps {
  subscriptions: Array<WebhookSubscription>
  onEdit: (subscription: WebhookSubscription) => void
  onEnable: (subscription: WebhookSubscription) => void
  onDisable: (subscription: WebhookSubscription) => void
  onRotate: (subscription: WebhookSubscription) => void
  onDelete: (subscription: WebhookSubscription) => void
  onViewDeliveries: (subscription: WebhookSubscription) => void
  busyId?: string | null
}

const DESTRUCTIVE_ITEM =
  'text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400'

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

/**
 * Every live subscription, with the operator's actions.
 *
 * The state column keeps **auto-disabled** distinct from **off**, mirroring the
 * two columns behind it. They are not the same fact: one is a decision the
 * operator made and can undo, the other is the system reporting that a receiver
 * stopped answering — and collapsing them would leave somebody staring at a
 * subscription they know they left switched on. An auto-disabled row is surfaced
 * the way a parked consumer is, with the reason attached rather than inferred.
 */
export function WebhookSubscriptionsTable({
  subscriptions,
  onEdit,
  onEnable,
  onDisable,
  onRotate,
  onDelete,
  onViewDeliveries,
  busyId = null,
}: WebhookSubscriptionsTableProps) {
  const columns: Array<DataGridColumn<WebhookSubscription>> = [
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter by name...',
    },
    {
      id: 'targetUrl',
      header: 'Target',
      accessorKey: 'targetUrl',
      cell: ({ getValue }) => (
        <span
          className="font-mono text-xs text-slate-600 dark:text-slate-300"
          title={getValue() as string}
        >
          {getValue() as string}
        </span>
      ),
    },
    {
      id: 'state',
      header: 'State',
      accessorFn: (row) =>
        row.disabledAt ? 'auto-disabled' : row.enabled ? 'active' : 'off',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Active', value: 'active' },
        { label: 'Off', value: 'off' },
        { label: 'Auto-disabled', value: 'auto-disabled' },
      ],
      cell: ({ row, getValue }) => {
        const state = getValue() as string
        if (state === 'auto-disabled') {
          return (
            <Badge
              variant="destructive"
              title={
                row.original.disabledReason ??
                'Switched off automatically after repeated failures'
              }
            >
              auto-disabled
            </Badge>
          )
        }
        if (state === 'off') return <Badge variant="secondary">off</Badge>
        return <Badge variant="success">active</Badge>
      },
    },
    {
      id: 'eventTypes',
      header: 'Events',
      cell: ({ row }) => {
        const types = row.original.eventTypes
        if (types.length === 0) {
          return (
            <span
              className="text-slate-500 dark:text-slate-400"
              title="Every type, including ones a future release adds"
            >
              all types
            </span>
          )
        }
        return (
          <span
            className="text-xs text-slate-600 dark:text-slate-300"
            title={types.join('\n')}
          >
            {types.length === 1 ? types[0] : `${types.length} types`}
          </span>
        )
      },
    },
    {
      id: 'signing',
      header: 'Signing',
      cell: ({ row }) =>
        row.original.secretPrefix ? (
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
            {row.original.secretPrefix}…
          </span>
        ) : (
          <Badge
            variant="warning"
            title="Deliveries are sent unsigned — the receiver cannot verify them"
          >
            unsigned
          </Badge>
        ),
    },
    {
      id: 'failures',
      header: 'Failures',
      accessorKey: 'consecutiveFailures',
      cell: ({ getValue }) => {
        const count = getValue() as number
        return count === 0 ? (
          <span className="text-slate-500 dark:text-slate-400">—</span>
        ) : (
          <span className="font-medium text-red-600 dark:text-red-400">
            {count}
          </span>
        )
      },
    },
    {
      id: 'lastSuccessAt',
      header: 'Last delivered',
      accessorKey: 'lastSuccessAt',
      cell: ({ getValue }) => (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {formatWhen(getValue() as string | null)}
        </span>
      ),
    },
  ]

  const renderRowActions = (row: Row<WebhookSubscription>) => {
    const subscription = row.original
    const isOn = subscription.enabled && !subscription.disabledAt

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            disabled={busyId === subscription.id}
          >
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onViewDeliveries(subscription)}>
            <ListOrdered className="mr-2 h-4 w-4" />
            Delivery log
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onEdit(subscription)}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </DropdownMenuItem>
          {isOn ? (
            <DropdownMenuItem onClick={() => onDisable(subscription)}>
              <Pause className="mr-2 h-4 w-4" />
              Disable
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => onEnable(subscription)}>
              <Play className="mr-2 h-4 w-4" />
              Enable
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onRotate(subscription)}>
            <KeyRound className="mr-2 h-4 w-4" />
            Rotate signing secret
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onDelete(subscription)}
            className={DESTRUCTIVE_ITEM}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <DataGrid
      data={subscriptions}
      columns={columns}
      getRowId={(subscription) => subscription.id}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      emptyMessage="No webhook subscriptions"
      emptyDescription="Create one to deliver domain events to an external system."
    />
  )
}
