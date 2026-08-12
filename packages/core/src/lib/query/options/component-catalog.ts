// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { CatalogEntryWithCategory } from '@/lib/services/CatalogService'
import { apiFetch } from '@/lib/api/client'

export interface CatalogCategory {
  id: string
  name: string
  slug: string
  parentId: string | null
  sortOrder: number | null
}

export interface CatalogEntryPage {
  entries: Array<CatalogEntryWithCategory>
  total: number
}

export interface CatalogEntrySearch {
  categoryId?: string | null
  entryType?: string
  q?: string
  offset?: number
  limit?: number
}

const EMPTY_PAGE: CatalogEntryPage = { entries: [], total: 0 }

/** The category tree behind the catalog sidebar and the entry form's picker. */
export function catalogCategoryListQuery() {
  return queryOptions({
    queryKey: qk.collection('admin', 'catalog-categories'),
    queryFn: async (): Promise<Array<CatalogCategory>> => {
      const result = await apiFetch<{
        data: { categories: Array<CatalogCategory> }
      }>('/api/v1/admin/component-catalog/categories')
      return result.data.categories
    },
  })
}

/**
 * One page of catalog entries.
 *
 * Params are normalised here so the empty filter a loader primes and the
 * empty filter the page starts with build the same key — one fetch.
 */
export function catalogEntryListQuery(search: CatalogEntrySearch = {}) {
  const categoryId = search.categoryId ?? null
  const entryType = search.entryType ?? 'all'
  const q = search.q?.trim() ?? ''
  const offset = search.offset ?? 0
  const limit = search.limit ?? 25

  return queryOptions({
    queryKey: qk.collection('admin', 'catalog-entries', {
      categoryId,
      entryType,
      q,
      offset,
      limit,
    }),
    queryFn: async (): Promise<CatalogEntryPage> => {
      const qs = new URLSearchParams()
      if (categoryId) qs.set('categoryId', categoryId)
      if (entryType !== 'all') qs.set('entryType', entryType)
      if (q) qs.set('q', q)
      qs.set('offset', String(offset))
      qs.set('limit', String(limit))

      const result = await apiFetch<{ data: Partial<CatalogEntryPage> }>(
        `/api/v1/admin/component-catalog?${qs}`,
      )
      return {
        entries: result.data.entries ?? EMPTY_PAGE.entries,
        total: result.data.total ?? EMPTY_PAGE.total,
      }
    },
  })
}
