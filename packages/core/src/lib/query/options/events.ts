// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

export interface EventConsumerStatus {
  id: string
  lastSeq: number
  /** How far behind the head of the log this consumer is. */
  lag: number
  failureCount: number
  lastError: string | null
  lastErrorAt: string | null
  lastErrorSeq: number | null
  nextAttemptAt: string | null
  parkedAt: string | null
  /**
   * Set when retention gave up waiting for a long-parked consumer. Its backlog
   * is forfeit and it must be re-registered.
   */
  abandonedAt: string | null
  updatedAt: string
  /**
   * Whether *this process* registers the consumer. Each process runs its own:
   * the app server polls core's release extensions by default, while the
   * RabbitMQ relay and the webhook dispatcher run only in the jobs worker — so
   * **false is a normal reading** for those, not a fault. What actually says
   * "no poller is running anywhere" is lag that grows while `updatedAt` stays
   * stale.
   */
  registeredHere: boolean
}

export interface EventConsumersSnapshot {
  latestSeq: number
  consumers: Array<EventConsumerStatus>
}

/** Cursor state for every registered event consumer, with its lag. */
export function eventConsumersQuery() {
  return queryOptions({
    queryKey: qk.collection('events', 'consumers'),
    queryFn: () =>
      apiFetch<{ data: EventConsumersSnapshot }>(
        '/api/v1/events/consumers',
      ).then((response) => response.data),
  })
}

/** The event type catalog this build can emit. */
export interface EventTypeSummary {
  type: string
  schemaVersion: number
  description: string
  subjectType: string | null
}

export function eventTypesQuery() {
  return queryOptions({
    queryKey: qk.collection('events', 'types'),
    queryFn: () =>
      apiFetch<{ data: { types: Array<EventTypeSummary> } }>(
        '/api/v1/events/types',
      ).then((response) => response.data.types),
  })
}
