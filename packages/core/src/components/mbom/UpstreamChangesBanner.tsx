// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { UpstreamChange } from '@/lib/query'
import { Button } from '@/components/ui/Button'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { upstreamChangesQuery, useResourceMutation } from '@/lib/query'
import { cn } from '@/lib/utils'

interface UpstreamChangesBannerProps {
  designId: string
}

/**
 * What a "Dismiss All" sweep actually managed to do.
 *
 * There is no bulk review endpoint, so the sweep is a sequence of independent
 * writes and stopping half way through leaves a real partial state on the
 * server. The outcome carries the count so the UI can say which it was
 * instead of reporting a flat success or a flat failure.
 */
interface DismissOutcome {
  /** Rows deferred before the sweep stopped. */
  dismissed: number
  /** Rows that were pending when it started. */
  total: number
  /** The error that stopped the sweep, or `null` if it got through them all. */
  failure: unknown
}

export function UpstreamChangesBanner({
  designId,
}: UpstreamChangesBannerProps) {
  const [expanded, setExpanded] = useState(false)
  const { handleError } = useErrorHandler()

  const {
    data: changes = [],
    isPending,
    isError,
    isFetching,
    refetch,
  } = useQuery(upstreamChangesQuery(designId))

  /**
   * Review every pending change as `defer`.
   *
   * `defer` rather than `reject` because dismissing the banner is a statement
   * about this reviewer's attention, not a verdict on the change. Either way
   * the row leaves the pending list for good — `getPendingUpstreamChanges`
   * filters `status = 'pending'` and nothing re-pends a reviewed row — so the
   * two differ only in the label the audit trail keeps.
   *
   * The loop deliberately does not rethrow. Throwing would skip invalidation,
   * leaving the banner showing rows that are already deferred on the server;
   * returning the partial count instead lets `useResourceMutation` invalidate
   * first and then report honestly from `onSuccess`.
   */
  const dismissAll = useResourceMutation<
    DismissOutcome,
    Error,
    Array<UpstreamChange>
  >({
    mutationFn: async (pending) => {
      let dismissed = 0

      for (const change of pending) {
        try {
          await apiFetch(
            `/api/v1/mbom/${designId}/upstream-changes/${change.id}/review`,
            { method: 'POST', body: JSON.stringify({ action: 'defer' }) },
          )
          dismissed += 1
        } catch (error) {
          return { dismissed, total: pending.length, failure: error }
        }
      }

      return { dismissed, total: pending.length, failure: null }
    },
    invalidates: ['mbom'],
    onSuccess: (outcome) => {
      if (outcome.failure === null) {
        return
      }

      handleError(outcome.failure, {
        title:
          outcome.dismissed === 0
            ? 'Could not dismiss upstream changes'
            : `Dismissed ${outcome.dismissed} of ${outcome.total} upstream changes`,
      })
    },
  })

  // Nothing to advise about while the first read is in flight.
  if (isPending) {
    return null
  }

  // A failed read used to render as `null` — the same thing shown when there
  // is genuinely nothing to review, so a broken detector was indistinguishable
  // from good news. Say which it is.
  if (isError) {
    return (
      <div className="mb-6 px-4 py-3 flex items-center gap-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg">
        <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-sm text-amber-800 dark:text-amber-200">
          Could not check for upstream engineering changes. This MBOM may have
          changes awaiting review that are not shown here.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="ml-auto shrink-0 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
        >
          <RefreshCw
            className={cn('h-4 w-4 mr-1', isFetching && 'animate-spin')}
          />
          Retry
        </Button>
      </div>
    )
  }

  if (changes.length === 0) {
    return null
  }

  // Count total changed items
  const totalChangedItems = changes.reduce(
    (sum, change) => sum + change.changedItems.length,
    0,
  )

  return (
    <div className="mb-6 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg">
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          <div>
            <h3 className="font-medium text-amber-800 dark:text-amber-200">
              Upstream Engineering Changes Detected
            </h3>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {totalChangedItems} item{totalChangedItems !== 1 ? 's' : ''}{' '}
              changed in {changes.length} source design
              {changes.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4 mr-1" />
            ) : (
              <ChevronRight className="h-4 w-4 mr-1" />
            )}
            {expanded ? 'Hide Details' : 'Review Changes'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
          >
            <RefreshCw
              className={cn('h-4 w-4', isFetching && 'animate-spin')}
            />
          </Button>
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-amber-200 dark:border-amber-800 px-4 py-3 space-y-4">
          {changes.map((change) => (
            <div key={change.id} className="space-y-2">
              {/* Source Design Info */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {change.sourceDesignCode}
                  </span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {change.sourceDesignName}
                  </span>
                  {change.sourceEcoNumber && (
                    <span className="text-xs bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 px-2 py-0.5 rounded">
                      via {change.sourceEcoNumber}
                    </span>
                  )}
                </div>
                <Link
                  to="/designs/$id"
                  params={{ id: change.sourceDesignId }}
                  className="text-sm text-cyan-600 dark:text-cyan-400 hover:underline flex items-center gap-1"
                >
                  View Source <ExternalLink className="h-3 w-3" />
                </Link>
              </div>

              {/* Changed Items Table */}
              <div className="bg-white dark:bg-slate-900 rounded border border-amber-200 dark:border-amber-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Item Number
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Name
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Type
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Change
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Revision
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                    {change.changedItems.map((item) => (
                      <tr key={item.masterId}>
                        <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                          {item.itemNumber}
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                          {item.name || '-'}
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                          {item.itemType}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`
                              px-2 py-0.5 rounded text-xs font-medium
                              ${
                                item.changeType === 'added'
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                                  : item.changeType === 'deleted'
                                    ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
                              }
                            `}
                          >
                            {item.changeType}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                          {item.previousRevision} → {item.newRevision}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2 border-t border-amber-200 dark:border-amber-800">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Dismissing records these changes as reviewed and clears the
              banner. It does not update the MBOM.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => dismissAll.mutate(changes)}
              disabled={dismissAll.isPending}
              className="ml-auto shrink-0 border-amber-300 dark:border-amber-700"
            >
              {dismissAll.isPending ? 'Dismissing…' : 'Dismiss All'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
