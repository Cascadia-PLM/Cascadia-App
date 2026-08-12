// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { QueryKey } from '@tanstack/react-query'
import type { ColumnFiltersState } from '@tanstack/react-table'

/** What a grid query resolves to: one page plus the unpaged total. */
export interface GridQueryResult<T> {
  items: Array<T>
  total: number
}

/**
 * A grid page query.
 *
 * Deliberately a plain object rather than `queryOptions()` output: the
 * branded key type that helper produces cannot be widened to the
 * resource-agnostic shape `useServerDataGrid` needs. Grid queries are only
 * ever consumed by that hook and by `ensureQueryData`, neither of which
 * needs the branding.
 */
export interface GridQuery<T> {
  queryKey: QueryKey
  queryFn: () => Promise<GridQueryResult<T>>
}

/** Builds the query for one page of a grid, given the current URL params. */
export type GridQueryFactory<T> = (grid: GridParams) => GridQuery<T>

/** Parameters sent to the server for a paged, sorted, filtered list. */
export interface GridParams {
  page: number
  pageSize: number
  sortField?: string
  sortDirection?: 'asc' | 'desc'
  columnFilters?: Record<
    string,
    string | Array<string> | { min?: number; max?: number }
  >
  globalSearch?: string
}

export const DEFAULT_PAGE_SIZE = 10

/**
 * Grid state as it exists in the URL.
 *
 * Kept separate from `GridParams` because the table wants
 * `ColumnFiltersState` while the server wants a plain record.
 */
export interface GridUrlState {
  page: number
  pageSize: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  search: string
  columnFilters: ColumnFiltersState
}

/**
 * Read grid state out of validated route search params.
 *
 * This lives outside the hook so a route loader can derive the *same* state
 * the component will derive, and therefore prime the *same* query key. If a
 * loader built its params inline instead, it would write to one cache entry
 * while the grid read from another — which is exactly the double-fetch this
 * module exists to prevent.
 */
export function gridUrlStateFromSearch(
  search: Record<string, unknown>,
  defaultPageSize: number = DEFAULT_PAGE_SIZE,
): GridUrlState {
  const columnFilters: ColumnFiltersState = []
  for (const [key, value] of Object.entries(search)) {
    if (!key.startsWith('filter_') || !value) continue
    const columnId = key.replace('filter_', '')
    columnFilters.push(
      typeof value === 'string' && value.includes(',')
        ? { id: columnId, value: value.split(',') }
        : { id: columnId, value },
    )
  }

  return {
    page: Number(search.page) || 1,
    pageSize: Number(search.pageSize) || defaultPageSize,
    sortBy: search.sortBy as string | undefined,
    sortOrder: search.sortOrder as 'asc' | 'desc' | undefined,
    search: (search.search as string) || '',
    columnFilters,
  }
}

/**
 * Convert URL grid state into the server-facing params that form the query
 * key. `globalSearch` is passed separately because the hook debounces it,
 * so the in-flight value can lag the URL by a few hundred milliseconds.
 */
export function toGridParams(
  urlState: GridUrlState,
  globalSearch: string,
): GridParams {
  const columnFilters: NonNullable<GridParams['columnFilters']> = {}
  for (const filter of urlState.columnFilters) {
    // TanStack Table types a filter value as `unknown`; the DataGrid only
    // ever stores the shapes GridParams allows.
    columnFilters[filter.id] = filter.value as NonNullable<
      GridParams['columnFilters']
    >[string]
  }

  return {
    page: urlState.page,
    pageSize: urlState.pageSize,
    sortField: urlState.sortBy,
    sortDirection: urlState.sortOrder,
    columnFilters:
      Object.keys(columnFilters).length > 0 ? columnFilters : undefined,
    globalSearch: globalSearch || undefined,
  }
}

/** One-shot helper for loaders: search params straight to server params. */
export function gridParamsFromSearch(
  search: Record<string, unknown>,
  defaultPageSize: number = DEFAULT_PAGE_SIZE,
): GridParams {
  const urlState = gridUrlStateFromSearch(search, defaultPageSize)
  return toGridParams(urlState, urlState.search)
}

/** Serialise grid params into the query string the list endpoints expect. */
export function gridParamsToSearchParams(
  params: GridParams,
  base?: URLSearchParams,
): URLSearchParams {
  const qs = new URLSearchParams(base)
  qs.set('limit', String(params.pageSize))
  qs.set('offset', String((params.page - 1) * params.pageSize))
  if (params.sortField) qs.set('sortField', params.sortField)
  if (params.sortDirection) qs.set('sortDirection', params.sortDirection)
  if (params.globalSearch) qs.set('globalSearch', params.globalSearch)
  if (params.columnFilters) {
    qs.set('columnFilters', JSON.stringify(params.columnFilters))
  }
  return qs
}
