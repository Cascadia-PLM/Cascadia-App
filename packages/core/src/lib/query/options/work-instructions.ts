// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { entityQuery, entitySubQuery } from './entities'
import type {
  WorkInstructionOperation,
  WorkInstructionWithSteps,
} from '@/lib/items/types/work-instruction'
import { apiFetch } from '@/lib/api/client'

/**
 * One work instruction template, steps included.
 *
 * `GET /api/v1/work-instructions/:id` returns the item with its steps already
 * joined; operations come from a separate endpoint, so the detail and
 * presentation routes read both and merge them.
 */
export function workInstructionDetailQuery(id: string) {
  return entityQuery<WorkInstructionWithSteps>(
    'work-instructions',
    id,
    'workInstruction',
  )
}

/** The operations a work instruction groups its steps into. */
export function workInstructionOperationsQuery(id: string) {
  return entitySubQuery<WorkInstructionOperation>(
    'work-instructions',
    id,
    'operations',
    'operations',
  )
}

/**
 * Count of change alerts still awaiting review on a template.
 *
 * Drives the badge on the Alerts tab, so it has to move when a part this
 * template references changes — which it now does, because a part write
 * reaches `items` and this key sits under the work instruction.
 */
export function workInstructionAlertCountQuery(id: string) {
  return queryOptions({
    queryKey: qk.sub('work-instructions', id, 'alert-count'),
    queryFn: async (): Promise<number> => {
      const result = await apiFetch<{
        data: { counts?: { pending?: number } }
      }>(`/api/v1/work-instructions/${id}/alerts`)
      return result.data.counts?.pending ?? 0
    },
  })
}

/** One parametric block's resolved value, or why it has none. */
export interface ResolvedParametricValue {
  value: string | null
  available: boolean
}

/**
 * Parametric block values resolved against the parts they reference, keyed
 * by block id. Enabled only when the template actually has parametric
 * blocks — the presenter skips the request entirely otherwise.
 */
export function workInstructionResolvedParametricsQuery(
  id: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('work-instructions', id, 'resolve-parametric'),
    queryFn: async (): Promise<Record<string, ResolvedParametricValue>> => {
      const result = await apiFetch<{
        data: { resolved?: Record<string, ResolvedParametricValue> }
      }>(`/api/v1/work-instructions/${id}/resolve-parametric`)
      return result.data.resolved ?? {}
    },
    enabled: enabled && Boolean(id),
  })
}

/** One change alert plus the panel's pending/total counters. */
export interface WorkInstructionAlerts<T> {
  alerts: Array<T>
  counts: { pending: number; total: number }
}

/**
 * The change alerts raised against this template, optionally filtered by
 * status. Keyed beneath the work instruction alongside the badge's count
 * query, so acknowledging an alert refreshes both.
 */
export function workInstructionAlertsQuery<T>(id: string, status?: string) {
  return queryOptions({
    queryKey: qk.sub('work-instructions', id, 'alerts', status ?? undefined),
    queryFn: async (): Promise<WorkInstructionAlerts<T>> => {
      const suffix = status ? `?status=${status}` : ''
      const result = await apiFetch<{
        data: {
          alerts?: Array<T>
          counts?: { pending: number; total: number }
        }
      }>(`/api/v1/work-instructions/${id}/alerts${suffix}`)
      return {
        alerts: result.data.alerts ?? [],
        counts: result.data.counts ?? { pending: 0, total: 0 },
      }
    },
  })
}

/** Which work-order travelers have instantiated this template. */
export function workInstructionUsageQuery<T>(id: string) {
  return queryOptions({
    queryKey: qk.sub('work-instructions', id, 'usage'),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: { usage?: Array<T> } }>(
        `/api/v1/work-instructions/${id}/usage`,
      )
      return result.data.usage ?? []
    },
  })
}
