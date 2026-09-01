// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { gridParamsToSearchParams } from '../grid-params'
import { entityQuery, entitySubQuery } from './entities'
import type { GridParams, GridQuery } from '../grid-params'
import type { Program, ProgramMember } from '@/lib/types/program'
import { apiFetch } from '@/lib/api/client'

export interface ProgramCounts {
  active: number
  onHold: number
  completed: number
}

const EMPTY_COUNTS: ProgramCounts = { active: 0, onHold: 0, completed: 0 }

/** Every program — the picker/reference list loaded by five routes. */
/**
 * The commit graph across a program's designs.
 *
 * Keyed beneath the program (and the design subset it covers), so a commit
 * or release refreshes it.
 */
export function programHistoryGraphQuery<T>(
  programId: string,
  designIds?: Array<string>,
  limit = 50,
) {
  const ids = designIds && designIds.length > 0 ? designIds.join(',') : ''
  return queryOptions({
    queryKey: qk.sub('programs', programId, 'history-graph', { ids, limit }),
    queryFn: async (): Promise<T> => {
      const qs = new URLSearchParams({ limit: String(limit) })
      if (ids) qs.set('designIds', ids)
      const result = await apiFetch<{ data: T }>(
        `/api/v1/programs/${programId}/history/graph?${qs}`,
      )
      return result.data
    },
  })
}

export function programListQuery() {
  return queryOptions({
    queryKey: qk.list('programs', {}),
    queryFn: async (): Promise<Array<Program>> => {
      const result = await apiFetch<{ data: { programs: Array<Program> } }>(
        '/api/v1/programs',
      )
      return result.data.programs
    },
  })
}

/** The paged programs grid. */
export function programGridQuery(grid: GridParams): GridQuery<Program> {
  return {
    queryKey: qk.list('programs', grid),
    queryFn: async () => {
      const qs = gridParamsToSearchParams(grid)
      const result = await apiFetch<{
        data: { programs: Array<Program>; total: number }
      }>(`/api/v1/programs?${qs}`)
      return { items: result.data.programs, total: result.data.total }
    },
  }
}

/** Program counts by status, served in one call alongside a minimal page. */
export function programCountsQuery() {
  return queryOptions({
    queryKey: qk.collection('programs', 'counts'),
    queryFn: async (): Promise<ProgramCounts> => {
      const result = await apiFetch<{
        data: { counts?: ProgramCounts }
      }>('/api/v1/programs?includeCounts=true&limit=1')
      return result.data.counts ?? EMPTY_COUNTS
    },
  })
}

export function programDetailQuery(id: string) {
  return entityQuery<Program>('programs', id, 'program')
}

/**
 * The program's team. Keyed under the program entity, so invalidating
 * `programs` refreshes it along with the detail record.
 */
export function programMembersQuery(id: string) {
  return entitySubQuery<ProgramMember>('programs', id, 'members', 'members')
}

/**
 * The drill-down scope graph rooted at a program — the program node, a design
 * node beneath it per design, and the per-item-type counts the graph view's
 * type filter is built from.
 *
 * Generic in the response shape for the same reason `programHistoryGraphQuery`
 * is: the concrete node and edge shapes are React Flow types owned by the
 * component, and the query layer has no business importing from `components/`.
 *
 * Keyed beneath the program, so `invalidate('programs')` refreshes a mounted
 * graph. The endpoint takes no parameters — the graph view's item-type filter
 * shapes what a *design* expansion returns, not this response.
 */
export function programScopeGraphQuery<T>(programId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('programs', programId, 'scope-graph'),
    queryFn: async (): Promise<T> => {
      const result = await apiFetch<{ data: T }>(
        `/api/v1/programs/${programId}/graph`,
      )
      return result.data
    },
    enabled: enabled && Boolean(programId),
  })
}
