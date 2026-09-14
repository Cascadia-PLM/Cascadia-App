// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Radio, RefreshCw } from 'lucide-react'
import type { EventConsumerStatus } from '@/lib/query'
import { Button } from '@/components/ui'
import { ConsumerErrorDialog } from '@/components/events/ConsumerErrorDialog'
import { EventConsumersTable } from '@/components/events/EventConsumersTable'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { useToast } from '@/lib/hooks/useToast'
import {
  eventConsumersQuery,
  eventTypesQuery,
  useResourceMutation,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/admin/events')({
  component: EventsPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(eventConsumersQuery()),
})

function EventsPage() {
  const { addToast } = useToast()
  const { confirm } = useAlertDialog()
  const { handleError } = useErrorHandler()
  const [selected, setSelected] = useState<EventConsumerStatus | null>(null)

  const { data, error, isFetching, refetch } = useQuery(eventConsumersQuery())
  const { data: types = [] } = useQuery(eventTypesQuery())

  const consumers = data?.consumers ?? []
  const latestSeq = data?.latestSeq ?? 0

  const resume = useResourceMutation<unknown, Error, string>({
    mutationFn: (id) =>
      apiFetch(`/api/v1/events/consumers/${id}/resume`, { method: 'POST' }),
    invalidates: ['events'],
    onError: (err) => handleError(err),
    onSuccess: () => setSelected(null),
  })

  const skip = useResourceMutation<unknown, Error, string>({
    mutationFn: (id) =>
      apiFetch(`/api/v1/events/consumers/${id}/skip`, { method: 'POST' }),
    invalidates: ['events'],
    onError: (err) => handleError(err),
    onSuccess: () => setSelected(null),
  })

  const forget = useResourceMutation<unknown, Error, string>({
    mutationFn: (id) =>
      apiFetch(`/api/v1/events/consumers/${id}`, { method: 'DELETE' }),
    invalidates: ['events'],
    onError: (err) => handleError(err),
    onSuccess: () => setSelected(null),
  })

  // Which row's menu to disable while a write is in flight. Read off the
  // mutation's own `variables` rather than mirrored into state, so it cannot
  // drift from what is actually running.
  const busyId = resume.isPending
    ? resume.variables
    : skip.isPending
      ? skip.variables
      : forget.isPending
        ? forget.variables
        : null

  // A parked consumer arrives as a status field on a *successful* response, so
  // announcing it is a toast raised here — never `handleError`, which is for a
  // thrown or API-error value and would report a healthy request as a failure.
  //
  // The dedupe ref keeps a re-render or a refetch from re-announcing the same
  // consumer, and the effect is keyed on the joined string rather than the
  // array: a freshly built array is a new identity every render, which is the
  // documented cause of "maximum update depth exceeded" in this codebase.
  const announced = useRef(new Set<string>())
  const parkedKey = consumers
    .filter((consumer) => consumer.parkedAt !== null)
    .map((consumer) => consumer.id)
    .join('|')

  useEffect(() => {
    if (parkedKey === '') return
    const fresh = parkedKey
      .split('|')
      .filter((id) => !announced.current.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) announced.current.add(id)

    addToast({
      title:
        fresh.length === 1
          ? 'An event consumer is parked'
          : `${fresh.length} event consumers are parked`,
      description: `${fresh.join(', ')} — stopped retrying after repeated failures. Nothing behind the cursor is being handled, and the log cannot be pruned past it.`,
      variant: 'warning',
      duration: 10000,
    })
  }, [parkedKey, addToast])

  const confirmForget = (consumer: EventConsumerStatus) => {
    confirm({
      title: `Forget ${consumer.id}?`,
      description:
        consumer.lag > 0
          ? `This deletes the cursor row, abandoning the ${consumer.lag.toLocaleString()} event(s) it has not handled. They will never be delivered to it. If the consumer is re-registered it restarts wherever its code declares — which for most consumers means treating everything now in the log as already delivered. Use this for a consumer no process owns any more, not to unstick a working one.`
          : 'This deletes the cursor row. The consumer is up to date, so nothing is lost today, but a re-registered consumer restarts wherever its code declares rather than where this cursor sat.',
      actionLabel: 'Forget the cursor',
      variant: 'destructive',
      onConfirm: () => forget.mutate(consumer.id),
    })
  }

  const parked = consumers.filter(
    (consumer) => consumer.parkedAt !== null && consumer.abandonedAt === null,
  ).length
  const abandoned = consumers.filter(
    (consumer) => consumer.abandonedAt !== null,
  ).length
  const behind = consumers.filter((consumer) => consumer.lag > 0).length

  return (
    <div className="min-h-screen bg-slate-50 p-6 dark:bg-slate-900">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio size={32} className="text-cyan-600 dark:text-cyan-400" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Domain Events
          </h1>
        </div>
        <Button
          onClick={() => void refetch()}
          disabled={isFetching}
          variant="outline"
          size="sm"
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-6 rounded border border-destructive/20 bg-destructive/10 px-4 py-3 text-destructive">
          {error.message}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Head of log" value={latestSeq.toLocaleString()} />
        <Stat label="Consumers" value={consumers.length} />
        <Stat
          label="Behind"
          value={behind}
          tone={behind > 0 ? 'warn' : 'calm'}
        />
        <Stat
          label="Parked"
          value={parked}
          tone={parked > 0 ? 'bad' : 'calm'}
        />
        <Stat
          label="Abandoned"
          value={abandoned}
          tone={abandoned > 0 ? 'bad' : 'calm'}
        />
      </div>

      <EventConsumersTable
        consumers={consumers}
        latestSeq={latestSeq}
        onResume={(consumer) => resume.mutate(consumer.id)}
        onSkip={(consumer) => skip.mutate(consumer.id)}
        onForget={confirmForget}
        onViewError={setSelected}
        busyId={busyId}
      />

      <ConsumerErrorDialog
        consumer={selected}
        onClose={() => setSelected(null)}
        onResume={(consumer) => resume.mutate(consumer.id)}
        onSkip={(consumer) => skip.mutate(consumer.id)}
        busy={busyId !== null}
      />

      <section className="mt-8">
        <h2 className="mb-1 text-lg font-semibold text-slate-900 dark:text-white">
          Event types this build emits
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          The catalog an extension can subscribe to. A type absent here is a
          type nothing in this instance publishes.
        </p>
        <div className="overflow-hidden rounded-lg border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">v</th>
                <th className="px-4 py-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {types.map((type) => (
                <tr
                  key={type.type}
                  className="border-t border-slate-200 dark:border-slate-700"
                >
                  <td className="px-4 py-2 font-mono text-xs text-slate-900 dark:text-slate-100">
                    {type.type}
                  </td>
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400">
                    {type.subjectType ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400">
                    {type.schemaVersion}
                  </td>
                  <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                    {type.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'calm',
}: {
  label: string
  value: string | number
  tone?: 'calm' | 'warn' | 'bad'
}) {
  const tones = {
    calm: 'text-slate-700 dark:text-slate-100',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-red-600 dark:text-red-400',
  }
  return (
    <div className="rounded-lg border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <div className={`text-2xl font-bold ${tones[tone]}`}>{value}</div>
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  )
}
