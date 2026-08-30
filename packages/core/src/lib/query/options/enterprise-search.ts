// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { gridParamsToSearchParams } from '../grid-params'
import type { GridParams, GridQuery } from '../grid-params'
import type { ApiData } from '@/lib/api/typed'
import { apiFetch } from '@/lib/api/client'

/**
 * One row on the enterprise search results page — the documented columns
 * derive from the OpenAPI contract (FE-7); the index signature stays,
 * because rows also carry dynamic custom-attribute columns the grid reads
 * by name.
 */
export type SearchResultRow = ApiData<
  '/api/v1/enterprise-search/results',
  'get'
>['items'][number] & { [key: string]: unknown }

/**
 * The header typeahead's grouped results.
 *
 * Distinct from `searchResultsGridQuery`, which pages the full `/search`
 * page; this reads the summary endpoint that groups hits by item type.
 * Keyed under `enterprise-search`, which `RESOURCE_DEPENDENTS` already
 * lists as a dependent of `items`.
 */
export function enterpriseSearchQuery<T>(
  q: string,
  limit = 20,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.collection('enterprise-search', 'typeahead', { q, limit }),
    queryFn: async (): Promise<T | null> => {
      const result = await apiFetch<{ data?: T }>(
        `/api/v1/enterprise-search?q=${encodeURIComponent(q)}&limit=${limit}`,
      )
      return result.data ?? null
    },
    enabled: enabled && q.length >= 2,
  })
}

/**
 * The paged cross-type search grid behind `/search`.
 *
 * Keyed under `enterprise-search`, which `RESOURCE_DEPENDENTS` already lists
 * as a dependent of `items` — any item mutation invalidates this grid.
 */
export function searchResultsGridQuery(
  grid: GridParams,
): GridQuery<SearchResultRow> {
  return {
    queryKey: qk.list('enterprise-search', grid),
    queryFn: async () => {
      const qs = gridParamsToSearchParams(grid)
      const result = await apiFetch<{
        data: { items: Array<SearchResultRow>; total: number }
      }>(`/api/v1/enterprise-search/results?${qs}`)
      return { items: result.data.items, total: result.data.total }
    },
  }
}
