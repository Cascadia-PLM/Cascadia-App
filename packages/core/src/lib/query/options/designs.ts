// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { gridParamsToSearchParams } from '../grid-params'
import { entityQuery } from './entities'
import type { GridParams, GridQuery } from '../grid-params'
import type { Design } from '@/lib/types/design'
import { apiFetch } from '@/lib/api/client'

/**
 * Designs, optionally scoped to a program.
 *
 * Nine routes load this list (as a picker, a sidebar, or the list page
 * itself). Sharing one factory means they share one cache entry and one
 * fetch, and all nine refresh together when a design is created.
 */
export function designListQuery<T = Design>(programId?: string) {
  return queryOptions({
    queryKey: qk.list('designs', programId ? { programId } : {}),
    queryFn: async (): Promise<Array<T>> => {
      const qs = new URLSearchParams()
      if (programId) qs.set('programId', programId)
      const suffix = qs.size > 0 ? `?${qs}` : ''
      const result = await apiFetch<{ data: { designs: Array<T> } }>(
        `/api/v1/designs${suffix}`,
      )
      return result.data.designs
    },
  })
}

export interface DesignCounts {
  design: number
  family: number
  library: number
}

const EMPTY_DESIGN_COUNTS: DesignCounts = { design: 0, family: 0, library: 0 }

/**
 * The paged designs grid.
 *
 * `/api/v1/designs` supports `limit`/`offset`/`sortField`/`columnFilters`
 * server-side; the previous grid sent none of them, fetched every row, and
 * reported the page length as the total.
 */
export function designGridQuery(
  grid: GridParams,
  programId?: string,
): GridQuery<Design> {
  return {
    queryKey: qk.list('designs', { ...grid, programId }),
    queryFn: async () => {
      const qs = gridParamsToSearchParams(grid)
      if (programId) qs.set('programId', programId)
      const result = await apiFetch<{
        data: { designs: Array<Design>; total: number }
      }>(`/api/v1/designs?${qs}`)
      return { items: result.data.designs, total: result.data.total }
    },
  }
}

/** Design counts by type, in one request rather than three. */
export function designCountsQuery(programId?: string) {
  return queryOptions({
    queryKey: qk.collection(
      'designs',
      'counts',
      programId ? { programId } : {},
    ),
    queryFn: async (): Promise<DesignCounts> => {
      const qs = new URLSearchParams({ limit: '1', includeCounts: 'true' })
      if (programId) qs.set('programId', programId)
      const result = await apiFetch<{ data: { counts?: DesignCounts } }>(
        `/api/v1/designs?${qs}`,
      )
      return result.data.counts ?? EMPTY_DESIGN_COUNTS
    },
  })
}

export function designDetailQuery(id: string, enabled = true) {
  return entityQuery<Design>('designs', id, 'design', enabled)
}

export interface DesignBranch {
  id: string
  name: string
  [key: string]: unknown
}

export interface DesignTag {
  id: string
  name: string
  [key: string]: unknown
}

/**
 * Branches on a design.
 *
 * Generic in the row type so a caller that needs concrete columns (the page
 * header, the branch selector, the baselines tab) can name them instead of
 * re-narrowing the index-signature default at every use site.
 */
export function designBranchesQuery<T = DesignBranch>(
  id: string,
  includeArchived = true,
) {
  const search = includeArchived ? 'includeArchived=true' : ''
  return queryOptions({
    queryKey: qk.sub('designs', id, 'branches', search || undefined),
    queryFn: async (): Promise<Array<T>> => {
      const suffix = search ? `?${search}` : ''
      const result = await apiFetch<{ data: { branches: Array<T> } }>(
        `/api/v1/designs/${id}/branches${suffix}`,
      )
      return result.data.branches
    },
  })
}

/** Baseline tags on a design. Generic for the same reason as branches. */
export function designTagsQuery<T = DesignTag>(id: string) {
  return queryOptions({
    queryKey: qk.sub('designs', id, 'tags'),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: { tags: Array<T> } }>(
        `/api/v1/designs/${id}/tags`,
      )
      return result.data.tags
    },
  })
}

export interface DesignFamily {
  id: string
  code: string
  name: string
}

/** Family designs available as a parent, scoped to a program. */
export function designFamiliesQuery(programId?: string) {
  return queryOptions({
    queryKey: qk.collection(
      'designs',
      'families',
      programId ? { programId } : {},
    ),
    queryFn: async (): Promise<Array<DesignFamily>> => {
      const qs = new URLSearchParams()
      if (programId) qs.set('programId', programId)
      const suffix = qs.size > 0 ? `?${qs}` : ''
      const result = await apiFetch<{
        data: { families: Array<DesignFamily> }
      }>(`/api/v1/designs/families${suffix}`)
      return result.data.families
    },
  })
}
