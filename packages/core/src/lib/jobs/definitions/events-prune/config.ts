// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eventsPrunePayloadSchema, eventsPruneResultSchema } from './types'
import type { EventsPrunePayload, EventsPruneResult } from './types'
import type { JobTypeConfig } from '@/lib/jobs/types'

/**
 * Prune domain events every consumer has passed and that are older than the
 * retention window.
 *
 * The log needs its own retention from the moment it ships: nothing else in this
 * tree prunes anything — there is no delete against `jobs` or `job_logs` either
 * — so an append-only table with no horizon grows until somebody notices.
 *
 * `timeout` doubles as the stale-running lease, which is why the handler batches
 * rather than issuing one large delete: a delete that outruns the lease is reaped
 * and retried while still executing.
 */
export const eventsPruneConfig: JobTypeConfig<
  EventsPrunePayload,
  EventsPruneResult
> = {
  type: 'maintenance.events.prune',
  label: 'Domain Event Log Retention',
  routingKey: 'jobs.maintenance.events',

  payloadSchema: eventsPrunePayloadSchema,
  resultSchema: eventsPruneResultSchema,

  timeout: 300000, // 5 minutes — a first run on a long-logging instance is large
  maxAttempts: 3,
  retryDelays: [60000, 300000, 900000],
  priority: 'low',
}
