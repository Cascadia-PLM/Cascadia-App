// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

export interface WebhookSubscription {
  id: string
  name: string
  targetUrl: string
  /** Empty means every type. */
  eventTypes: Array<string>
  programId: string | null
  /**
   * The first characters of the plaintext secret, for identification only. Null
   * on an explicitly unsigned subscription. The secret itself is shown exactly
   * once, at creation and at rotation, and is never readable afterwards.
   */
  secretPrefix: string | null
  enabled: boolean
  /**
   * Set when the breaker or a 410 Gone switched this off by itself — as opposed
   * to `enabled: false`, which is an operator's own decision. Two fields rather
   * than one so "I left it on and the system stopped it" is visible as such.
   */
  disabledAt: string | null
  disabledReason: string | null
  consecutiveFailures: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  createdFromSeq: number
  createdAt: string
  updatedAt: string
  rotatedAt: string | null
}

/** Every live subscription. Soft-deleted ones are not returned. */
export function webhookSubscriptionsQuery() {
  return queryOptions({
    queryKey: qk.lists('webhooks'),
    queryFn: () =>
      apiFetch<{ data: { subscriptions: Array<WebhookSubscription> } }>(
        '/api/v1/webhooks',
      ).then((response) => response.data.subscriptions),
  })
}

export interface WebhookDelivery {
  id: string
  eventId: string
  eventSeq: number
  eventType: string
  /** `pending` | `delivered` | `dead` | `expired`. */
  status: string
  attemptCount: number
  nextAttemptAt: string | null
  responseStatus: number | null
  responseSnippet: string | null
  error: string | null
  deliveredAt: string | null
  createdAt: string
}

export interface WebhookDeliveryPage {
  deliveries: Array<WebhookDelivery>
  /** Pass back as `beforeSeq` for the next page; null when this is the last. */
  nextBeforeSeq: number | null
}

/**
 * One page of a subscription's delivery log, newest first.
 *
 * `beforeSeq` asks for the page below that seq; without it, the newest page.
 * Each page is cached under its own cursor, so loading an older page refetches
 * none of the pages already shown.
 */
export function webhookDeliveriesQuery(
  subscriptionId: string,
  { enabled = true, beforeSeq }: { enabled?: boolean; beforeSeq?: number } = {},
) {
  return queryOptions({
    queryKey: qk.sub('webhooks', subscriptionId, 'deliveries', {
      beforeSeq: beforeSeq ?? null,
    }),
    enabled: enabled && subscriptionId !== '',
    queryFn: () =>
      apiFetch<{ data: WebhookDeliveryPage }>(
        `/api/v1/webhooks/${subscriptionId}/deliveries${
          beforeSeq !== undefined ? `?beforeSeq=${beforeSeq}` : ''
        }`,
      ).then((response) => response.data),
  })
}
