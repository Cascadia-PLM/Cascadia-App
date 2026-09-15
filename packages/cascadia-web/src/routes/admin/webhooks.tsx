// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Plus, RefreshCw, Webhook } from 'lucide-react'
import type { WebhookSubscription } from '@/lib/query'
import type { WebhookFormValues } from '@/components/webhooks/WebhookFormDialog'
import { Button } from '@/components/ui'
import { WebhookDeliveriesDialog } from '@/components/webhooks/WebhookDeliveriesDialog'
import { WebhookFormDialog } from '@/components/webhooks/WebhookFormDialog'
import { WebhookSecretDialog } from '@/components/webhooks/WebhookSecretDialog'
import { WebhookSubscriptionsTable } from '@/components/webhooks/WebhookSubscriptionsTable'
import {
  eventConsumersQuery,
  eventTypesQuery,
  useResourceMutation,
  webhookSubscriptionsQuery,
} from '@/lib/query'
import { WEBHOOK_DISPATCHER_CONSUMER_ID } from '@/lib/webhooks/config'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/admin/webhooks')({
  component: WebhooksPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(webhookSubscriptionsQuery()),
})

interface CreateResponse {
  data: { subscription: WebhookSubscription; secret: string | null }
}

interface RotateResponse {
  data: { subscription: WebhookSubscription; secret: string }
}

/** A dispatcher this far behind and this long unmoved has no worker running it. */
const DISPATCHER_STALE_MS = 5 * 60 * 1000

/**
 * Webhook administration.
 *
 * A thin route: every dialog and every mutation lives in
 * `components/webhooks/`, and the page itself only wires them together. New
 * code, so the mutations go through `useResourceMutation` rather than the older
 * fetch-then-invalidate pair.
 */
function WebhooksPage() {
  const { confirm } = useAlertDialog()
  const { handleError } = useErrorHandler()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<WebhookSubscription | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [secretMode, setSecretMode] = useState<'created' | 'rotated'>('created')
  const [viewingLog, setViewingLog] = useState<WebhookSubscription | null>(null)
  // Bumped on every open, so the form remounts with fresh state even when two
  // creates in a row share the same absent row id.
  const [formSession, setFormSession] = useState(0)

  const {
    data: subscriptions = [],
    error,
    isFetching,
    refetch,
  } = useQuery(webhookSubscriptionsQuery())
  const { data: eventTypes = [] } = useQuery(eventTypesQuery())
  const { data: consumers, dataUpdatedAt: consumersReadAt } = useQuery(
    eventConsumersQuery(),
  )

  const create = useResourceMutation<CreateResponse, Error, WebhookFormValues>({
    mutationFn: (values) =>
      apiFetch<CreateResponse>('/api/v1/webhooks', {
        method: 'POST',
        body: JSON.stringify(values),
      }),
    invalidates: ['webhooks'],
    onError: (err) => handleError(err),
    onSuccess: (response) => {
      setFormOpen(false)
      setEditing(null)
      // The one and only time the plaintext exists outside the receiver.
      if (response.data.secret) {
        setSecretMode('created')
        setSecret(response.data.secret)
      }
    },
  })

  const update = useResourceMutation<
    unknown,
    Error,
    { id: string; values: WebhookFormValues }
  >({
    mutationFn: ({ id, values }) =>
      apiFetch(`/api/v1/webhooks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: values.name,
          targetUrl: values.targetUrl,
          eventTypes: values.eventTypes,
          programId: values.programId,
          allowInsecure: values.allowInsecure,
        }),
      }),
    invalidates: ['webhooks'],
    onError: (err) => handleError(err),
    onSuccess: () => {
      setFormOpen(false)
      setEditing(null)
    },
  })

  const setEnabled = useResourceMutation<
    unknown,
    Error,
    { id: string; enabled: boolean }
  >({
    mutationFn: ({ id, enabled }) =>
      apiFetch(`/api/v1/webhooks/${id}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
      }),
    invalidates: ['webhooks'],
    onError: (err) => handleError(err),
  })

  const rotate = useResourceMutation<RotateResponse, Error, string>({
    mutationFn: (id) =>
      apiFetch<RotateResponse>(`/api/v1/webhooks/${id}/rotate-secret`, {
        method: 'POST',
      }),
    invalidates: ['webhooks'],
    onError: (err) => handleError(err),
    onSuccess: (response) => {
      setSecretMode('rotated')
      setSecret(response.data.secret)
    },
  })

  const remove = useResourceMutation<unknown, Error, string>({
    mutationFn: (id) =>
      apiFetch(`/api/v1/webhooks/${id}`, { method: 'DELETE' }),
    invalidates: ['webhooks'],
    onError: (err) => handleError(err),
  })

  // Read off the mutations' own `variables` rather than mirrored into state, so
  // it cannot drift from what is actually running.
  const busyId = setEnabled.isPending
    ? setEnabled.variables.id
    : rotate.isPending
      ? rotate.variables
      : remove.isPending
        ? remove.variables
        : update.isPending
          ? update.variables.id
          : null

  const confirmRotate = (subscription: WebhookSubscription) =>
    confirm({
      title: `Rotate the secret for ${subscription.name}?`,
      description:
        'The current secret stops working immediately. Every delivery signed ' +
        'with it will fail verification until the receiver has the new one, ' +
        'and the new secret is shown only once.',
      actionLabel: 'Rotate the secret',
      variant: 'destructive',
      onConfirm: () => rotate.mutate(subscription.id),
    })

  const confirmDelete = (subscription: WebhookSubscription) =>
    confirm({
      title: `Delete ${subscription.name}?`,
      description:
        'The subscription stops matching events immediately and its signing ' +
        'secret becomes unusable. Deliveries still queued are expired rather ' +
        'than sent. Its ' +
        'delivery history stays readable until retention prunes it.',
      actionLabel: 'Delete the subscription',
      variant: 'destructive',
      onConfirm: () => remove.mutate(subscription.id),
    })

  const autoDisabled = subscriptions.filter(
    (subscription) => subscription.disabledAt !== null,
  )

  // Deliveries are written and sent by the jobs worker alone, so an instance
  // without one accepts subscriptions and delivers nothing. Judged from the
  // dispatcher's cursor: no row means no worker has ever run it, and a row that
  // is behind the log and has not moved for five minutes means none is running
  // it now. Measured against when the snapshot was read, so both times come
  // from the same moment.
  const dispatcher = consumers?.consumers.find(
    (consumer) => consumer.id === WEBHOOK_DISPATCHER_CONSUMER_ID,
  )
  const workerMissing =
    consumers !== undefined &&
    subscriptions.length > 0 &&
    (dispatcher === undefined ||
      (dispatcher.lag > 0 &&
        consumersReadAt - new Date(dispatcher.updatedAt).getTime() >
          DISPATCHER_STALE_MS))

  return (
    <div className="min-h-screen bg-slate-50 p-6 dark:bg-slate-900">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Webhook size={32} className="text-cyan-600 dark:text-cyan-400" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Webhooks
          </h1>
        </div>
        <div className="flex items-center gap-2">
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
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setFormSession((session) => session + 1)
              setFormOpen(true)
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            New subscription
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded border border-destructive/20 bg-destructive/10 px-4 py-3 text-destructive">
          {error.message}
        </div>
      )}

      {workerMissing && (
        <div className="mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Nothing is being delivered.</strong>{' '}
          {dispatcher === undefined
            ? 'No jobs worker has run the webhook dispatcher on this instance yet.'
            : `The webhook dispatcher has not moved since ${new Date(dispatcher.updatedAt).toLocaleString()} and is ${dispatcher.lag} events behind.`}{' '}
          Webhooks are sent by the jobs worker, not the web server, so start
          one.
        </div>
      )}

      {/*
        Surfaced the way a parked consumer is: an automatic disable is the
        system reporting that a receiver stopped answering, not a setting
        somebody forgot. Saying so here means an operator does not have to
        notice a badge in a table to learn it.
      */}
      {autoDisabled.length > 0 && (
        <div className="mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>
            {autoDisabled.length === 1
              ? 'One subscription was disabled automatically.'
              : `${autoDisabled.length} subscriptions were disabled automatically.`}
          </strong>{' '}
          Nothing is being delivered to{' '}
          {autoDisabled.map((s) => s.name).join(', ')} — the receiver failed
          repeatedly, or answered 410 Gone. Fix the endpoint, then enable it
          again.
        </div>
      )}

      <WebhookSubscriptionsTable
        subscriptions={subscriptions}
        onEdit={(subscription) => {
          setEditing(subscription)
          setFormSession((session) => session + 1)
          setFormOpen(true)
        }}
        onEnable={(subscription) =>
          setEnabled.mutate({ id: subscription.id, enabled: true })
        }
        onDisable={(subscription) =>
          setEnabled.mutate({ id: subscription.id, enabled: false })
        }
        onRotate={confirmRotate}
        onDelete={confirmDelete}
        onViewDeliveries={setViewingLog}
        busyId={busyId}
      />

      {/*
        Keyed on the row being edited and on the open, so switching rows — or
        opening a second create — remounts the form with fresh initial state. That is what lets the dialog initialise from props
        without an effect syncing them — and an effect there would depend on the
        subscription object, whose identity changes on every refetch, wiping
        whatever the operator had typed.
      */}
      <WebhookFormDialog
        key={`${editing?.id ?? 'new'}-${formSession}`}
        open={formOpen}
        subscription={editing}
        eventTypes={eventTypes}
        busy={create.isPending || update.isPending}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        onSubmit={(values) => {
          if (editing) update.mutate({ id: editing.id, values })
          else create.mutate(values)
        }}
      />

      <WebhookSecretDialog
        secret={secret}
        mode={secretMode}
        onClose={() => {
          setSecret(null)
          // The plaintext also sits in each mutation's result until reset.
          create.reset()
          rotate.reset()
        }}
      />

      <WebhookDeliveriesDialog
        key={viewingLog?.id ?? 'closed'}
        subscription={viewingLog}
        onClose={() => setViewingLog(null)}
      />
    </div>
  )
}
