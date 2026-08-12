// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { qk } from '../keys'
import { gridParamsToSearchParams } from '../grid-params'
import type { GridParams, GridQuery } from '../grid-params'
import { apiFetch } from '@/lib/api/client'

/** One row on the enterprise search results page. */
export interface SearchResultRow {
  id: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string | null
  state: string | null
  createdAt: string | null
  modifiedAt: string | null
  designId: string | null
  designCode: string | null
  designName: string | null
  programId: string | null
  programCode: string | null
  programName: string | null
  [key: string]: unknown
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
