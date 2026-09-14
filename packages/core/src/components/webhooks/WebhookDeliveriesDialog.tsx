// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { WebhookDelivery, WebhookSubscription } from '@/lib/query'
import { Badge, Button, LoadingSpinner } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { webhookDeliveriesQuery } from '@/lib/query'

interface WebhookDeliveriesDialogProps {
  subscription: WebhookSubscription | null
  onClose: () => void
}

/** How often the newest page refreshes while it is the only page shown. */
const REFRESH_MS = 15_000

const STATUS_VARIANTS: Record<
  string,
  'success' | 'warning' | 'destructive' | 'secondary'
> = {
  delivered: 'success',
  pending: 'warning',
  dead: 'destructive',
  expired: 'secondary',
}

function StatusBadge({ delivery }: { delivery: WebhookDelivery }) {
  const variant = STATUS_VARIANTS[delivery.status] ?? 'secondary'
  const title =
    delivery.status === 'dead'
      ? 'Exhausted its attempts. The event was never delivered, and the log row is the record of that.'
      : delivery.status === 'expired'
        ? 'Dropped rather than sent: older than the maximum pending age when the pump reached it, or still queued when the subscription was deleted.'
        : undefined
  return (
    <Badge variant={variant} title={title}>
      {delivery.status}
    </Badge>
  )
}

/**
 * One subscription's delivery log.
 *
 * Read-only on purpose. There is no redeliver button, and the reason is the
 * ordering promise: deliveries go out in seq order within a subscription, so
 * re-sending one out of band would break the only guarantee a receiver is given.
 * A receiver that missed something replays from the event log instead.
 *
 * Paged backwards by seq. The newest page refreshes by itself while it is the
 * only one open; once older pages are loaded it stops, because a refresh that
 * shifted the newest page would open a gap above the first older one.
 */
export function WebhookDeliveriesDialog({
  subscription,
  onClose,
}: WebhookDeliveriesDialogProps) {
  // The cursor of every older page asked for. The call site keys this dialog on
  // the subscription, so opening another row starts from its newest page.
  const [cursors, setCursors] = useState<Array<number>>([])
  const open = subscription !== null
  const subscriptionId = subscription?.id ?? ''

  const pages = useQueries({
    queries: [
      {
        ...webhookDeliveriesQuery(subscriptionId, { enabled: open }),
        refetchInterval: open && cursors.length === 0 ? REFRESH_MS : false,
      },
      ...cursors.map((beforeSeq) =>
        webhookDeliveriesQuery(subscriptionId, { enabled: open, beforeSeq }),
      ),
    ],
  })

  const newest = pages.at(0)
  const last = pages.at(-1)
  // Keyed by id: a delivery that settles between two page loads can appear in
  // both, and a row listed twice would read as two deliveries.
  const deliveries = [
    ...new Map(
      pages
        .flatMap((page) => page.data?.deliveries ?? [])
        .map((delivery) => [delivery.id, delivery] as const),
    ).values(),
  ]
  const nextBeforeSeq = last?.data?.nextBeforeSeq ?? null
  const loadingOlder = cursors.length > 0 && last?.isPending === true

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Delivery log — {subscription?.name}</DialogTitle>
          <DialogDescription>
            Newest first. Deliveries go out in event order within a
            subscription, so a failure holds the line until it succeeds or runs
            out of attempts.
          </DialogDescription>
        </DialogHeader>

        {newest?.isPending !== false ? (
          <div className="flex justify-center p-8">
            <LoadingSpinner />
          </div>
        ) : deliveries.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
            Nothing delivered yet.
          </p>
        ) : (
          <div className="max-h-[28rem] overflow-auto rounded border border-slate-300 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-100 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Seq</th>
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">Response</th>
                  <th className="px-3 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr
                    key={delivery.id}
                    className="border-t border-slate-200 dark:border-slate-700"
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      {delivery.eventSeq}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {delivery.eventType}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge delivery={delivery} />
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {delivery.attemptCount}
                    </td>
                    <td
                      className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300"
                      title={delivery.error ?? delivery.responseSnippet ?? ''}
                    >
                      {delivery.responseStatus ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                      {new Date(
                        delivery.deliveredAt ?? delivery.createdAt,
                      ).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {deliveries.length > 0 && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {nextBeforeSeq !== null
                ? `Showing the newest ${deliveries.length} deliveries.`
                : 'That is every delivery still on record. Settled deliveries are pruned once they pass the retention period.'}
            </p>
            {nextBeforeSeq !== null && (
              <Button
                variant="outline"
                size="sm"
                disabled={loadingOlder}
                onClick={() =>
                  setCursors((current) => [...current, nextBeforeSeq])
                }
              >
                {loadingOlder ? 'Loading…' : 'Load older deliveries'}
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
