import type {
  ColumnFiltersState,
  PaginationState,
  SortingState,
} from '@tanstack/react-table'

/**
 * URL state shape for DataGrid persistence
 */
export interface DataGridUrlState {
  search?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  page?: number
  pageSize?: number
  filters?: Record<string, string>
}

/**
 * Convert DataGrid state to URL-friendly parameters
 */
export function dataGridStateToUrlParams(
  sorting: SortingState,
  columnFilters: ColumnFiltersState,
  globalFilter: string,
  pagination: PaginationState,
  defaultPageSize: number = 10,
): DataGridUrlState {
  const params: DataGridUrlState = {}

  // Global search
  if (globalFilter) {
    params.search = globalFilter
  }

  // Sorting (only first sort column for URL simplicity)
  if (sorting.length > 0) {
    params.sortBy = sorting[0].id
    params.sortOrder = sorting[0].desc ? 'desc' : 'asc'
  }

  // Pagination (1-based for URL readability)
  if (pagination.pageIndex > 0) {
    params.page = pagination.pageIndex + 1
  }

  if (pagination.pageSize !== defaultPageSize) {
    params.pageSize = pagination.pageSize
  }

  // Column filters
  if (columnFilters.length > 0) {
    params.filters = {}
    columnFilters.forEach((filter) => {
      params.filters![filter.id] = String(filter.value)
    })
  }

  return params
}

/**
 * Convert URL parameters to DataGrid state
 */
export function urlParamsToDataGridState(
  params: DataGridUrlState,
  defaultPageSize: number = 10,
): {
  sorting: SortingState
  columnFilters: ColumnFiltersState
  globalFilter: string
  pagination: PaginationState
} {
  // Sorting
  const sorting: SortingState = params.sortBy
    ? [
        {
          id: params.sortBy,
          desc: params.sortOrder === 'desc',
        },
      ]
    : []

  // Column filters
  const columnFilters: ColumnFiltersState = []
  if (params.filters) {
    Object.entries(params.filters).forEach(([id, value]) => {
      columnFilters.push({ id, value })
    })
  }

  // Pagination (convert from 1-based URL to 0-based internal)
  const pagination: PaginationState = {
    pageIndex: params.page ? params.page - 1 : 0,
    pageSize: params.pageSize || defaultPageSize,
  }

  return {
    sorting,
    columnFilters,
    globalFilter: params.search || '',
    pagination,
  }
}

/**
 * Check if any search/filter state is active
 */
export function isDataGridStateActive(
  sorting: SortingState,
  columnFilters: ColumnFiltersState,
  globalFilter: string,
): boolean {
  return (
    globalFilter.length > 0 || sorting.length > 0 || columnFilters.length > 0
  )
}

/**
 * Create a summary description of active filters
 */
export function getDataGridStateSummary(
  sorting: SortingState,
  columnFilters: ColumnFiltersState,
  globalFilter: string,
): string {
  const parts: Array<string> = []

  if (globalFilter) {
    parts.push(`Searching for "${globalFilter}"`)
  }

  if (sorting.length > 0) {
    const sort = sorting[0]
    parts.push(`Sorted by ${sort.id} (${sort.desc ? 'desc' : 'asc'})`)
  }

  if (columnFilters.length > 0) {
    parts.push(
      `${columnFilters.length} filter${columnFilters.length > 1 ? 's' : ''} applied`,
    )
  }

  return parts.join(' • ')
}

/**
 * Create default/reset state
 */
export function createDefaultDataGridState(defaultPageSize: number = 10): {
  sorting: SortingState
  columnFilters: ColumnFiltersState
  globalFilter: string
  pagination: PaginationState
} {
  return {
    sorting: [],
    columnFilters: [],
    globalFilter: '',
    pagination: {
      pageIndex: 0,
      pageSize: defaultPageSize,
    },
  }
}

/**
 * Build TanStack Router search params object from DataGrid URL state
 */
export function buildSearchParams(
  urlState: DataGridUrlState,
  filterPrefix: string = 'filter_',
): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {}

  if (urlState.search) {
    params.search = urlState.search
  }

  if (urlState.sortBy) {
    params.sortBy = urlState.sortBy
    params.sortOrder = urlState.sortOrder
  }

  if (urlState.page && urlState.page > 1) {
    params.page = urlState.page
  }

  if (urlState.pageSize) {
    params.pageSize = urlState.pageSize
  }

  if (urlState.filters) {
    Object.entries(urlState.filters).forEach(([key, value]) => {
      params[`${filterPrefix}${key}`] = value
    })
  }

  return params
}

/**
 * Parse TanStack Router search params into DataGrid URL state
 */
export function parseSearchParams(
  searchParams: Record<string, unknown>,
  filterPrefix: string = 'filter_',
): DataGridUrlState {
  const filters: Record<string, string> = {}

  // Extract filter_ prefixed params
  Object.entries(searchParams).forEach(([key, value]) => {
    if (key.startsWith(filterPrefix) && value) {
      const filterKey = key.slice(filterPrefix.length)
      filters[filterKey] = String(value)
    }
  })

  return {
    search: searchParams.search as string | undefined,
    sortBy: searchParams.sortBy as string | undefined,
    sortOrder: searchParams.sortOrder as 'asc' | 'desc' | undefined,
    page: typeof searchParams.page === 'number' ? searchParams.page : undefined,
    pageSize:
      typeof searchParams.pageSize === 'number'
        ? searchParams.pageSize
        : undefined,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
  }
}
