// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { qk } from '../keys'
import type { GridParams, GridQuery } from '../grid-params'
import { apiFetch } from '@/lib/api/client'

/** One row of `/api/v1/designs/:id/items` — a design-scoped item summary. */
export interface DesignItem {
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
  modifiedAt: string
}

/** The version of the design the item list is resolved against. */
export interface DesignItemsContext {
  branch?: string
  tag?: string
  commit?: string
  /** Restrict to one item type, e.g. `Part`. */
  itemType?: string
}

/**
 * A paged list of the items contained in one design.
 *
 * Distinct from `itemGridQuery` because this reads the design-scoped
 * endpoint, which resolves historical contexts through `VersionResolver` and
 * names its free-text filter `search`. It supports neither sorting nor column
 * filters, so the shared `gridParamsToSearchParams` serialiser does not apply
 * and the query string is built here instead.
 *
 * Keyed beneath the design, so invalidating `designs` refreshes it.
 */
export function designItemsGridQuery(
  designId: string,
  grid: GridParams,
  context: DesignItemsContext = {},
): GridQuery<DesignItem> {
  return {
    queryKey: qk.sub('designs', designId, 'items', { ...grid, ...context }),
    queryFn: async () => {
      const qs = new URLSearchParams({
        limit: String(grid.pageSize),
        offset: String((grid.page - 1) * grid.pageSize),
      })
      if (grid.globalSearch) qs.set('search', grid.globalSearch)
      if (context.itemType) qs.set('type', context.itemType)
      if (context.branch) qs.set('branch', context.branch)
      if (context.tag) qs.set('tag', context.tag)
      if (context.commit) qs.set('commit', context.commit)

      const result = await apiFetch<{
        data: { items: Array<DesignItem>; total: number }
      }>(`/api/v1/designs/${designId}/items?${qs}`)
      return { items: result.data.items, total: result.data.total }
    },
  }
}
