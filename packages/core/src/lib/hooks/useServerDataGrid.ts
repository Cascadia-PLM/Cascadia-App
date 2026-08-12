// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type {
  ColumnFiltersState,
  PaginationState,
  SortingState,
} from '@tanstack/react-table'
import type { GridParams, GridQueryFactory } from '@/lib/query/grid-params'
import {
  DEFAULT_PAGE_SIZE,
  gridUrlStateFromSearch,
  toGridParams,
} from '@/lib/query/grid-params'

export type { GridParams as ServerDataGridParams } from '@/lib/query/grid-params'
export type {
  GridQuery,
  GridQueryFactory,
  GridQueryResult,
} from '@/lib/query/grid-params'

export interface UseServerDataGridOptions<T> {
  /**
   * Shared query factory for one page.
   *
   * Route loaders call the *same* factory with params derived from the same
   * URL, so `ensureQueryData` in the loader and `useQuery` here resolve to
   * one cache entry — the page renders what the loader already fetched
   * instead of firing a second identical request.
   */
  query: GridQueryFactory<T>
  /** Default page size. */
  defaultPageSize?: number
  /** Debounce delay for global search in milliseconds. */
  searchDebounceMs?: number
}

export interface UseServerDataGridReturn<T> {
  items: Array<T>
  total: number
  isLoading: boolean
  isFetching: boolean
  /** Props to spread onto DataGrid component */
  dataGridProps: {
    serverSidePagination: boolean
    serverSideOperations: boolean
    totalRows: number
    isLoading: boolean
    sorting: SortingState
    columnFilters: ColumnFiltersState
    globalFilter: string
    pagination: PaginationState
    onSortingChange: (sorting: SortingState) => void
    onColumnFiltersChange: (filters: ColumnFiltersState) => void
    onGlobalFilterChange: (filter: string) => void
    onPaginationChange: (pagination: PaginationState) => void
    onPageChange: (page: number, pageSize: number) => void
  }
  /**
   * Force an immediate refetch of the current page.
   *
   * Rarely the right tool: it refreshes *this* grid only. After a mutation
   * prefer `useInvalidateResources()`, which also refreshes the other views
   * of the same data. Kept for genuinely local refreshes.
   */
  refetch: () => void
}

/**
 * Server-side DataGrid state, synced to the URL and backed by the shared
 * query cache.
 *
 * Features:
 * - Syncs sorting, filtering, pagination state with URL search params
 * - Reads through the app query cache, so mutations elsewhere invalidate it
 * - Debounces global search to avoid excessive API calls
 * - Resets to page 1 when filters/sort change
 */
export function useServerDataGrid<T>(
  options: UseServerDataGridOptions<T>,
): UseServerDataGridReturn<T> {
  const {
    query,
    defaultPageSize = DEFAULT_PAGE_SIZE,
    searchDebounceMs = 300,
  } = options

  const navigate = useNavigate()

  const searchParams = useSearch({ strict: false })

  // Parse URL into state
  const urlState = useMemo(
    () => gridUrlStateFromSearch(searchParams, defaultPageSize),
    [searchParams, defaultPageSize],
  )

  // Debounced global search state
  const [debouncedSearch, setDebouncedSearch] = useState(urlState.search)
  const debounceTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)

  // Update debounced search when URL search changes
  useEffect(() => {
    clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedSearch(urlState.search)
    }, searchDebounceMs)

    return () => {
      clearTimeout(debounceTimerRef.current)
    }
  }, [urlState.search, searchDebounceMs])

  // Build the server-facing params that form the query key
  const gridParams: GridParams = useMemo(
    () => toGridParams(urlState, debouncedSearch),
    [urlState, debouncedSearch],
  )

  const { data, isLoading, isFetching, refetch } = useQuery({
    ...query(gridParams),
    placeholderData: keepPreviousData,
  })

  // Update URL when state changes
  const updateUrl = useCallback(
    (updates: Record<string, unknown>, resetPage = false) => {
      // Type assertion for the navigate options since this hook is
      // route-agnostic and TanStack Router's strict typing requires knowing
      // the specific route (see useVersionContext for the same pattern).
      navigate({
        search: (prev: Record<string, unknown>) => {
          const newParams = { ...prev, ...updates }
          if (resetPage) {
            newParams.page = 1
          }
          // Remove empty values
          for (const key of Object.keys(newParams)) {
            if (
              newParams[key] === undefined ||
              newParams[key] === '' ||
              newParams[key] === null
            ) {
              delete newParams[key]
            }
          }
          return newParams
        },
        replace: true, // Don't add to history stack for state changes
      } as Parameters<typeof navigate>[0])
    },
    [navigate],
  )

  // State change handlers
  const handleSortingChange = useCallback(
    (sorting: SortingState) => {
      const sort = sorting[0]
      updateUrl(
        {
          sortBy: sort?.id,
          sortOrder: sort?.desc ? 'desc' : sort ? 'asc' : undefined,
        },
        true, // Reset to page 1
      )
    },
    [updateUrl],
  )

  const handleColumnFiltersChange = useCallback(
    (filters: ColumnFiltersState) => {
      // Convert filters to URL params (filter_columnId format)
      const filterParams: Record<string, string | undefined> = {}

      // Clear all existing filter params first
      for (const key of Object.keys(searchParams)) {
        if (key.startsWith('filter_')) {
          filterParams[key] = undefined
        }
      }

      // Add new filter params
      for (const filter of filters) {
        const value = filter.value
        if (Array.isArray(value)) {
          filterParams[`filter_${filter.id}`] = value.join(',')
        } else if (typeof value === 'object' && value !== null) {
          // Range filter - store as JSON
          filterParams[`filter_${filter.id}`] = JSON.stringify(value)
        } else if (value !== undefined && value !== '') {
          filterParams[`filter_${filter.id}`] = String(value)
        }
      }

      updateUrl(filterParams, true) // Reset to page 1
    },
    [updateUrl, searchParams],
  )

  const handleGlobalFilterChange = useCallback(
    (filter: string) => {
      updateUrl({ search: filter || undefined }, true) // Reset to page 1
    },
    [updateUrl],
  )

  const handlePaginationChange = useCallback(
    (pagination: PaginationState) => {
      updateUrl({
        page: pagination.pageIndex + 1,
        pageSize:
          pagination.pageSize !== defaultPageSize
            ? pagination.pageSize
            : undefined,
      })
    },
    [updateUrl, defaultPageSize],
  )

  const handlePageChange = useCallback(
    (page: number, pageSize: number) => {
      updateUrl({
        page,
        pageSize: pageSize !== defaultPageSize ? pageSize : undefined,
      })
    },
    [updateUrl, defaultPageSize],
  )

  // Build sorting state from URL
  const sorting: SortingState = useMemo(() => {
    if (!urlState.sortBy) return []
    return [{ id: urlState.sortBy, desc: urlState.sortOrder === 'desc' }]
  }, [urlState.sortBy, urlState.sortOrder])

  // Build pagination state from URL
  const pagination: PaginationState = useMemo(
    () => ({
      pageIndex: urlState.page - 1,
      pageSize: urlState.pageSize,
    }),
    [urlState.page, urlState.pageSize],
  )

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    isLoading,
    isFetching,
    refetch,
    dataGridProps: {
      serverSidePagination: true,
      serverSideOperations: true,
      totalRows: data?.total ?? 0,
      isLoading: isLoading || isFetching,
      sorting,
      columnFilters: urlState.columnFilters,
      globalFilter: urlState.search,
      pagination,
      onSortingChange: handleSortingChange,
      onColumnFiltersChange: handleColumnFiltersChange,
      onGlobalFilterChange: handleGlobalFilterChange,
      onPaginationChange: handlePaginationChange,
      onPageChange: handlePageChange,
    },
  }
}
