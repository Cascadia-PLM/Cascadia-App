import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type {
  ColumnFiltersState,
  PaginationState,
  SortingState,
} from '@tanstack/react-table'

/**
 * Parameters sent to the server for data fetching
 */
export interface ServerDataGridParams {
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

/**
 * Options for the useServerDataGrid hook
 */
export interface UseServerDataGridOptions<T> {
  /** Query key prefix for TanStack Query */
  queryKey: Array<string>
  /** Function to fetch data from server */
  fetchFn: (
    params: ServerDataGridParams,
  ) => Promise<{ items: Array<T>; total: number }>
  /** Default page size */
  defaultPageSize?: number
  /** Debounce delay for global search in milliseconds */
  searchDebounceMs?: number
  /** Additional dependencies to include in query key (e.g., designId) */
  dependencies?: Record<string, unknown>
}

/**
 * Return type for the useServerDataGrid hook
 */
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
  /** Refetch data */
  refetch: () => void
}

/**
 * Hook that manages server-side DataGrid state with URL persistence and TanStack Query
 *
 * Features:
 * - Syncs sorting, filtering, pagination state with URL search params
 * - Uses TanStack Query for caching and automatic refetch
 * - Debounces global search to avoid excessive API calls
 * - Resets to page 1 when filters/sort change
 */
export function useServerDataGrid<T>(
  options: UseServerDataGridOptions<T>,
): UseServerDataGridReturn<T> {
  const {
    queryKey,
    fetchFn,
    defaultPageSize = 10,
    searchDebounceMs = 300,
    dependencies = {},
  } = options

  const navigate = useNavigate()

  const searchParams: any = useSearch({ strict: false })

  // Parse URL into state
  const urlState = useMemo(() => {
    const page = Number(searchParams.page) || 1
    const pageSize = Number(searchParams.pageSize) || defaultPageSize
    const sortBy = searchParams.sortBy as string | undefined
    const sortOrder = searchParams.sortOrder as 'asc' | 'desc' | undefined
    const search = (searchParams.search as string) || ''

    // Parse column filters from URL (filter_columnId format)
    const columnFilters: ColumnFiltersState = []
    for (const [key, value] of Object.entries(searchParams)) {
      if (key.startsWith('filter_') && value) {
        const columnId = key.replace('filter_', '')
        // Handle arrays (comma-separated in URL)
        if (typeof value === 'string' && value.includes(',')) {
          columnFilters.push({ id: columnId, value: value.split(',') })
        } else {
          columnFilters.push({ id: columnId, value })
        }
      }
    }

    return {
      page,
      pageSize,
      sortBy,
      sortOrder,
      search,
      columnFilters,
    }
  }, [searchParams, defaultPageSize])

  // Debounced global search state
  const [debouncedSearch, setDebouncedSearch] = useState(urlState.search)
  const debounceTimerRef = useRef<NodeJS.Timeout>()

  // Update debounced search when URL search changes
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedSearch(urlState.search)
    }, searchDebounceMs)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [urlState.search, searchDebounceMs])

  // Build query params for API call
  const queryParams: ServerDataGridParams = useMemo(() => {
    // Convert column filters to server format
    const columnFiltersMap: ServerDataGridParams['columnFilters'] = {}
    for (const filter of urlState.columnFilters) {
      columnFiltersMap[filter.id] = filter.value
    }

    return {
      page: urlState.page,
      pageSize: urlState.pageSize,
      sortField: urlState.sortBy,
      sortDirection: urlState.sortOrder,
      columnFilters:
        Object.keys(columnFiltersMap).length > 0 ? columnFiltersMap : undefined,
      globalSearch: debouncedSearch || undefined,
    }
  }, [urlState, debouncedSearch])

  // TanStack Query
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: [...queryKey, queryParams, dependencies],
    queryFn: () => fetchFn(queryParams),
    placeholderData: keepPreviousData,
  })

  // Update URL when state changes
  const updateUrl = useCallback(
    (updates: Record<string, unknown>, resetPage = false) => {
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
      })
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
