// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { collectionQuery, entityQuery } from './entities'
import type { Report, ReportExecutionResult } from '@/lib/reports/types'
import { apiFetch } from '@/lib/api/client'

/** Every report visible to the caller, grouped by item type in the UI. */
export function reportListQuery() {
  return collectionQuery<Report>('reports', 'reports')
}

export function reportDetailQuery(id: string) {
  return entityQuery<Report>('reports', id, 'report')
}

/** The window of rows one run of a report returns. */
export interface ReportExecutionParams {
  limit: number
  offset: number
}

const DEFAULT_EXECUTION_PARAMS: ReportExecutionParams = {
  limit: 100,
  offset: 0,
}

/**
 * One run of a report.
 *
 * A POST that is nonetheless a read: the execution options travel in the body
 * because they are too structured for a query string, but the request returns
 * rows and writes nothing. The window is part of the key, so paging forward
 * and back does not re-run what is already held.
 *
 * `staleTime: 0` overrides the client's 30s default deliberately. A report is
 * a live query over items, and the viewer's Refresh button exists because
 * users expect it to reach the server; keeping the default would let a remount
 * inside the window show the previous run's rows as if they were current.
 *
 * `reportId` is optional because `Report.id` is: a report that has not been
 * saved yet has none, and there is nothing on the server to run. The read
 * holds rather than posting to `/reports/undefined/execute`.
 */
export function reportExecutionQuery(
  reportId: string | undefined,
  params: ReportExecutionParams = DEFAULT_EXECUTION_PARAMS,
) {
  const { limit, offset } = params
  const id = reportId ?? ''
  return queryOptions({
    queryKey: qk.sub('reports', id, 'execution', { limit, offset }),
    queryFn: async (): Promise<ReportExecutionResult> => {
      const result = await apiFetch<{
        data: { result: ReportExecutionResult }
      }>(`/api/v1/reports/${id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ limit, offset }),
      })
      return result.data.result
    },
    enabled: Boolean(reportId),
    staleTime: 0,
  })
}
