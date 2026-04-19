import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronRight as ChevronRightIcon,
  ChevronsLeft,
  ChevronsRight,
  Download,
  ExternalLink,
  Search,
  X,
} from 'lucide-react'
import { Button } from './Button'
import { Input } from './Input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './Select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './Table'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ContextMenu'
import { ColumnFilterPopover } from './ColumnFilter'
import type {
  FilterType,
  MultiSelectFilterValue,
  RangeFilterValue,
} from './ColumnFilter'
import type {
  ColumnDef,
  ColumnFiltersState,
  ExpandedState,
  FilterFn,
  PaginationState,
  Row,
  SortingState,
} from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Re-export filter types for backward compatibility
export type { FilterType, RangeFilterValue, MultiSelectFilterValue }

// Column configuration type
export interface DataGridColumn<T> {
  id: string
  header: string
  accessorKey?: keyof T | string
  accessorFn?: (row: T) => unknown
  cell?: (props: { row: Row<T>; getValue: () => unknown }) => ReactNode
  enableSorting?: boolean
  enableFiltering?: boolean
  enableEditing?: boolean
  // Filter configuration
  filterType?: FilterType
  filterOptions?: Array<{ label: string; value: string }>
  filterPlaceholder?: string
  meta?: {
    align?: 'left' | 'center' | 'right'
    width?: string
  }
}

// Props interface
export interface DataGridProps<T> {
  // Data
  data: Array<T>
  columns: Array<DataGridColumn<T>>

  // Row key
  getRowId?: (row: T) => string

  // Controlled state (for URL persistence)
  sorting?: SortingState
  onSortingChange?: (sorting: SortingState) => void
  columnFilters?: ColumnFiltersState
  onColumnFiltersChange?: (filters: ColumnFiltersState) => void
  globalFilter?: string
  onGlobalFilterChange?: (filter: string) => void
  pagination?: PaginationState
  onPaginationChange?: (pagination: PaginationState) => void

  // Features
  enablePagination?: boolean
  enableSorting?: boolean
  enableFiltering?: boolean
  enableGlobalFilter?: boolean
  enableHierarchy?: boolean
  enableRowActions?: boolean

  // Server-side pagination
  serverSidePagination?: boolean
  totalRows?: number
  onPageChange?: (page: number, pageSize: number) => void
  isLoading?: boolean

  // Server-side operations (sorting, filtering) - when true, disables client-side processing
  serverSideOperations?: boolean

  // Hierarchy
  getSubRows?: (row: T) => Array<T> | undefined

  // Callbacks
  onCellEdit?: (
    row: T,
    columnId: string,
    value: unknown,
  ) => void | Promise<void>
  renderRowActions?: (row: Row<T>) => ReactNode

  // Context Menu
  enableContextMenu?: boolean
  getRowUrl?: (row: T) => string | undefined
  renderContextMenuItems?: (row: Row<T>) => ReactNode

  // Empty state
  emptyMessage?: string
  emptyDescription?: string

  // Styling
  className?: string

  // Export
  enableExport?: boolean
  exportFilename?: string

  // Default/initial values (for uncontrolled mode)
  defaultSorting?: SortingState
  defaultColumnFilters?: ColumnFiltersState
  defaultGlobalFilter?: string
  defaultPageSize?: number
  pageSizeOptions?: Array<number>
}

// Editable cell component
function EditableCell<T>({
  cell,
  row,
  onCellEdit,
  enableEditing,
}: {
  cell: {
    getValue: () => unknown
    column: { id: string; columnDef: { cell?: unknown } }
    getContext: () => unknown
  }
  row: Row<T>
  onCellEdit?: (
    row: T,
    columnId: string,
    value: unknown,
  ) => void | Promise<void>
  enableEditing?: boolean
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState<string>(String(cell.getValue() ?? ''))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleSave = useCallback(async () => {
    if (onCellEdit && value !== String(cell.getValue() ?? '')) {
      await onCellEdit(row.original, cell.column.id, value)
    }
    setIsEditing(false)
  }, [onCellEdit, value, cell, row])

  const handleCancel = useCallback(() => {
    setValue(String(cell.getValue() ?? ''))
    setIsEditing(false)
  }, [cell])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSave()
      } else if (e.key === 'Escape') {
        handleCancel()
      }
    },
    [handleSave, handleCancel],
  )

  if (enableEditing && isEditing) {
    return (
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        className="h-8 w-full min-w-[100px]"
      />
    )
  }

  const cellContent =
    typeof cell.column.columnDef.cell === 'function'
      ? flexRender(
          cell.column.columnDef.cell as Parameters<typeof flexRender>[0],
          cell.getContext() as object,
        )
      : cell.getValue()

  return (
    <div
      className={cn(
        enableEditing &&
          'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 -m-2 p-2 rounded',
      )}
      onDoubleClick={() => enableEditing && setIsEditing(true)}
    >
      {cellContent as ReactNode}
    </div>
  )
}

// Global filter function - searches across ALL columns
function globalFilterFn<T>(
  row: Row<T>,
  _columnId: string,
  filterValue: string,
): boolean {
  const search = String(filterValue).toLowerCase()

  // Search across all cells in the row
  for (const cell of row.getAllCells()) {
    // Skip internal columns (expand, actions)
    if (cell.column.id.startsWith('_')) continue

    const value = cell.getValue()
    if (
      String(value ?? '')
        .toLowerCase()
        .includes(search)
    ) {
      return true
    }
  }
  return false
}

// Multi-select filter function
const multiSelectFilterFn: FilterFn<unknown> = (
  row,
  columnId,
  filterValue: Array<string>,
) => {
  if (filterValue.length === 0) return true
  const value = row.getValue(columnId)
  return filterValue.includes(String(value ?? ''))
}

// Range filter function
const rangeFilterFn: FilterFn<unknown> = (
  row,
  columnId,
  filterValue: RangeFilterValue,
) => {
  if (filterValue.min === undefined && filterValue.max === undefined)
    return true
  const value = row.getValue(columnId)
  const numValue = parseFloat(String(value ?? ''))
  if (isNaN(numValue)) return false
  if (filterValue.min !== undefined && numValue < filterValue.min) return false
  if (filterValue.max !== undefined && numValue > filterValue.max) return false
  return true
}

export function DataGrid<T>({
  data,
  columns,
  getRowId,
  // Controlled state
  sorting: controlledSorting,
  onSortingChange: onSortingChangeProp,
  columnFilters: controlledColumnFilters,
  onColumnFiltersChange: onColumnFiltersChangeProp,
  globalFilter: controlledGlobalFilter,
  onGlobalFilterChange: onGlobalFilterChangeProp,
  pagination: controlledPagination,
  onPaginationChange: onPaginationChangeProp,
  // Features
  enablePagination = true,
  enableSorting = true,
  enableFiltering = true,
  enableGlobalFilter = true,
  enableHierarchy = false,
  enableRowActions = false,
  // Server-side pagination
  serverSidePagination = false,
  totalRows,
  onPageChange,
  isLoading = false,
  // Server-side operations
  serverSideOperations = false,
  // Hierarchy
  getSubRows,
  // Callbacks
  onCellEdit,
  renderRowActions,
  // Context Menu
  enableContextMenu = false,
  getRowUrl,
  renderContextMenuItems,
  // Empty state
  emptyMessage = 'No data found',
  emptyDescription = 'Try adjusting your search or filters',
  // Styling
  className,
  // Export
  enableExport = true,
  exportFilename = 'export',
  // Defaults
  defaultSorting = [],
  defaultColumnFilters = [],
  defaultGlobalFilter = '',
  defaultPageSize = 10,
  pageSizeOptions = [10, 20, 50, 100],
}: DataGridProps<T>) {
  // Internal state (for uncontrolled mode) - initialized with defaults
  const [internalSorting, setInternalSorting] =
    useState<SortingState>(defaultSorting)
  const [internalColumnFilters, setInternalColumnFilters] =
    useState<ColumnFiltersState>(defaultColumnFilters)
  const [internalGlobalFilter, setInternalGlobalFilter] =
    useState(defaultGlobalFilter)
  const [internalPagination, setInternalPagination] = useState<PaginationState>(
    {
      pageIndex: 0,
      pageSize: defaultPageSize,
    },
  )
  const [expanded, setExpanded] = useState<ExpandedState>({})

  // Track which filter popovers are open (persists across re-renders)
  const [openFilters, setOpenFilters] = useState<Record<string, boolean>>({})

  // Local state for global search input (prevents lost keystrokes during URL sync)
  const [localSearchValue, setLocalSearchValue] = useState(
    controlledGlobalFilter ?? defaultGlobalFilter,
  )
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null)
  const isSearchInternalChange = useRef(false)

  // Use controlled or internal state
  const sorting = controlledSorting ?? internalSorting
  const setSorting = onSortingChangeProp ?? setInternalSorting
  const columnFilters = controlledColumnFilters ?? internalColumnFilters
  const setColumnFilters = onColumnFiltersChangeProp ?? setInternalColumnFilters
  const globalFilter = controlledGlobalFilter ?? internalGlobalFilter
  const setGlobalFilter = onGlobalFilterChangeProp ?? setInternalGlobalFilter
  const pagination = controlledPagination ?? internalPagination
  const setPagination = onPaginationChangeProp ?? setInternalPagination

  // Sync local search value from parent (for external changes like URL navigation or clear button elsewhere)
  useEffect(() => {
    if (!isSearchInternalChange.current) {
      setLocalSearchValue(globalFilter)
    }
    isSearchInternalChange.current = false
  }, [globalFilter])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }
    }
  }, [])

  // Handle search input change with debounced URL sync
  const handleSearchChange = useCallback(
    (value: string) => {
      setLocalSearchValue(value) // Immediate visual update

      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }

      isSearchInternalChange.current = true
      searchDebounceRef.current = setTimeout(() => {
        setGlobalFilter(value) // Triggers URL update after debounce
      }, 300)
    },
    [setGlobalFilter],
  )

  // Handle clearing search
  const handleClearSearch = useCallback(() => {
    setLocalSearchValue('')
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
    }
    isSearchInternalChange.current = true
    setGlobalFilter('')
  }, [setGlobalFilter])

  // Helper to update a single column filter
  const updateColumnFilter = useCallback(
    (columnId: string, value: unknown) => {
      const computeNewFilters = (
        prev: ColumnFiltersState,
      ): ColumnFiltersState => {
        const existing = prev.filter((f) => f.id !== columnId)
        // Remove filter if value is empty
        const isEmpty =
          value === '' ||
          value === undefined ||
          value === null ||
          (Array.isArray(value) && value.length === 0) ||
          (typeof value === 'object' &&
            Object.keys(value).every(
              (k) => (value as Record<string, unknown>)[k] === undefined,
            ))

        if (isEmpty) {
          return existing
        }
        return [...existing, { id: columnId, value }]
      }

      // Handle both controlled and uncontrolled modes
      if (onColumnFiltersChangeProp) {
        // Controlled mode: compute new value from current filters and pass directly
        const newFilters = computeNewFilters(columnFilters)
        onColumnFiltersChangeProp(newFilters)
      } else {
        // Uncontrolled mode: use updater function
        setInternalColumnFilters(computeNewFilters)
      }
    },
    [columnFilters, onColumnFiltersChangeProp],
  )

  // Get filter value for a column
  const getColumnFilterValue = useCallback(
    (columnId: string) => {
      return columnFilters.find((f) => f.id === columnId)?.value
    },
    [columnFilters],
  )

  // Helper to toggle filter popover open state
  const setFilterOpen = useCallback((columnId: string, isOpen: boolean) => {
    setOpenFilters((prev) => ({ ...prev, [columnId]: isOpen }))
  }, [])

  // Handle open in new tab action
  const handleOpenInNewTab = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  // Check if any column filters are active
  const hasActiveFilters = columnFilters.length > 0 || globalFilter

  // Convert DataGridColumn to TanStack Table ColumnDef
  const tableColumns = useMemo<Array<ColumnDef<T>>>(() => {
    const cols: Array<ColumnDef<T>> = []

    // Add expand column for hierarchy
    if (enableHierarchy) {
      cols.push({
        id: '_expand',
        header: '',
        size: 28,
        cell: ({ row }) => {
          if (!row.getCanExpand()) return null
          return (
            <button
              onClick={() => row.toggleExpanded()}
              className="p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
              aria-label={row.getIsExpanded() ? 'Collapse row' : 'Expand row'}
              aria-expanded={row.getIsExpanded()}
            >
              {row.getIsExpanded() ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRightIcon className="h-3 w-3" />
              )}
            </button>
          )
        },
      })
    }

    // Add data columns
    columns.forEach((col) => {
      const filterFn: FilterFn<T> | 'includesString' =
        col.filterType === 'multiSelect'
          ? (multiSelectFilterFn as FilterFn<T>)
          : col.filterType === 'range'
            ? (rangeFilterFn as FilterFn<T>)
            : 'includesString'

      cols.push({
        id: col.id,
        accessorKey: col.accessorKey as string,
        ...(col.accessorFn && { accessorFn: col.accessorFn }),
        header: ({ column }) => {
          const canSort = enableSorting && col.enableSorting !== false
          const canFilter =
            enableFiltering && col.enableFiltering !== false && col.filterType
          const filterValue = getColumnFilterValue(col.id)

          return (
            <div className="flex items-center gap-1">
              {/* Header label */}
              <span
                className={cn(canSort && 'cursor-pointer')}
                onClick={() =>
                  canSort &&
                  column.toggleSorting(column.getIsSorted() === 'asc')
                }
              >
                {col.header}
              </span>

              {/* Sort button */}
              {canSort && (
                <button
                  className="p-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() =>
                    column.toggleSorting(column.getIsSorted() === 'asc')
                  }
                  aria-label={
                    column.getIsSorted() === 'asc'
                      ? 'Sort descending'
                      : column.getIsSorted() === 'desc'
                        ? 'Clear sort'
                        : 'Sort ascending'
                  }
                >
                  {column.getIsSorted() === 'asc' ? (
                    <ArrowUp className="h-3 w-3" />
                  ) : column.getIsSorted() === 'desc' ? (
                    <ArrowDown className="h-3 w-3" />
                  ) : (
                    <ArrowUpDown className="h-3 w-3 opacity-50" />
                  )}
                </button>
              )}

              {/* Filter button */}
              {canFilter && (
                <ColumnFilterPopover
                  filterType={col.filterType!}
                  value={filterValue}
                  onChange={(v) => updateColumnFilter(col.id, v)}
                  options={col.filterOptions}
                  placeholder={col.filterPlaceholder}
                  columnHeader={col.header}
                  open={openFilters[col.id] || false}
                  onOpenChange={(isOpen) => setFilterOpen(col.id, isOpen)}
                />
              )}
            </div>
          )
        },
        cell: col.cell
          ? ({ row, getValue }) => col.cell!({ row, getValue })
          : ({ getValue }) => {
              const value = getValue()
              if (value === null || value === undefined)
                return <span className="text-slate-400">-</span>
              return (
                <span className="text-slate-700 dark:text-slate-300">
                  {String(value)}
                </span>
              )
            },
        enableSorting: col.enableSorting !== false && enableSorting,
        filterFn,
        meta: col.meta,
      })
    })

    // Add actions column
    if (enableRowActions && renderRowActions) {
      cols.push({
        id: '_actions',
        header: 'Actions',
        cell: ({ row }) => renderRowActions(row),
        enableSorting: false,
        meta: { align: 'right' as const },
      })
    }

    return cols
  }, [
    columns,
    enableSorting,
    enableFiltering,
    enableHierarchy,
    enableRowActions,
    renderRowActions,
    getColumnFilterValue,
    updateColumnFilter,
    openFilters,
    setFilterOpen,
  ])

  // Calculate page count for server-side pagination
  const serverPageCount =
    serverSidePagination && totalRows !== undefined
      ? Math.ceil(totalRows / pagination.pageSize)
      : undefined

  // Create table instance
  const table = useReactTable({
    data,
    columns: tableColumns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      pagination,
      expanded,
    },
    getRowId,
    onSortingChange: (updater) => {
      const newValue =
        typeof updater === 'function' ? updater(sorting) : updater
      setSorting(newValue)
      // Reset to first page when sorting changes (only for client-side operations)
      if (!serverSidePagination && !serverSideOperations) {
        setPagination((prev) => ({ ...prev, pageIndex: 0 }))
      }
    },
    onColumnFiltersChange: (updater) => {
      const newValue =
        typeof updater === 'function' ? updater(columnFilters) : updater
      setColumnFilters(newValue)
      // Reset to first page when filters change (only for client-side operations)
      if (!serverSidePagination && !serverSideOperations) {
        setPagination((prev) => ({ ...prev, pageIndex: 0 }))
      }
    },
    onGlobalFilterChange: (updater) => {
      const newValue =
        typeof updater === 'function' ? updater(globalFilter) : updater
      setGlobalFilter(newValue)
      // Reset to first page when global filter changes (only for client-side operations)
      if (!serverSidePagination && !serverSideOperations) {
        setPagination((prev) => ({ ...prev, pageIndex: 0 }))
      }
    },
    onPaginationChange: (updater) => {
      const newValue =
        typeof updater === 'function' ? updater(pagination) : updater
      setPagination(newValue)
      // Call onPageChange callback for server-side pagination
      if (serverSidePagination && onPageChange) {
        onPageChange(newValue.pageIndex + 1, newValue.pageSize)
      }
    },
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: enablePagination
      ? getPaginationRowModel()
      : undefined,
    getExpandedRowModel: enableHierarchy ? getExpandedRowModel() : undefined,
    getSubRows: getSubRows,
    globalFilterFn,
    filterFns: {
      multiSelect: multiSelectFilterFn,
      range: rangeFilterFn,
    },
    manualPagination: serverSidePagination,
    pageCount: serverPageCount,
    // Server-side operations: disable client-side sorting/filtering
    manualSorting: serverSideOperations,
    manualFiltering: serverSideOperations,
  })

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    setColumnFilters([])
    setGlobalFilter('')
  }, [setColumnFilters, setGlobalFilter])

  // Export to CSV
  const exportToCsv = useCallback(() => {
    // Get all filtered/sorted rows (not just current page)
    const rows = table.getFilteredRowModel().rows

    // Get data columns (skip expand and actions columns)
    const dataColumns = columns.filter(
      (col) => col.id !== '_expand' && col.id !== '_actions',
    )

    // Build CSV header
    const headers = dataColumns.map((col) => col.header)

    // Build CSV rows
    const csvRows = rows.map((row) => {
      return dataColumns.map((col) => {
        let value: unknown
        if (col.accessorFn) {
          value = col.accessorFn(row.original)
        } else if (col.accessorKey) {
          // Handle nested keys like 'user.name'
          const keys = String(col.accessorKey).split('.')
          value = keys.reduce<unknown>((obj, key) => {
            if (obj == null) return undefined
            return (obj as Record<string, unknown>)[key]
          }, row.original)
        } else {
          value = row.getValue(col.id)
        }

        // Convert value to string for CSV
        if (value === null || value === undefined) {
          return ''
        }
        if (value instanceof Date) {
          return value.toISOString()
        }
        if (typeof value === 'object') {
          return JSON.stringify(value)
        }
        // Escape quotes and wrap in quotes if contains comma, quote, or newline
        const strValue = String(value)
        if (
          strValue.includes(',') ||
          strValue.includes('"') ||
          strValue.includes('\n')
        ) {
          return `"${strValue.replace(/"/g, '""')}"`
        }
        return strValue
      })
    })

    // Combine headers and rows
    const csvContent = [
      headers.join(','),
      ...csvRows.map((row) => row.join(',')),
    ].join('\n')

    // Create and download file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${exportFilename}-${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
  }, [table, columns, exportFilename])

  return (
    <div className={cn('space-y-1.5', className)}>
      {/* Toolbar */}
      {(enableGlobalFilter || enableExport) && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Global search */}
          {enableGlobalFilter && (
            <div className="relative w-48">
              <Search
                className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400"
                aria-hidden="true"
              />
              <Input
                placeholder="Search..."
                value={localSearchValue}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="h-7 pl-7 pr-7 text-xs"
                aria-label="Search table"
              />
              {localSearchValue && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {/* Clear all filters button */}
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAllFilters}
              className="h-7 px-2 text-xs text-slate-500"
            >
              <X className="h-3 w-3 mr-1" />
              Clear
            </Button>
          )}

          {/* Spacer to push export button to the right */}
          <div className="flex-1" />

          {/* Export button */}
          {enableExport && (
            <Button
              variant="outline"
              size="sm"
              onClick={exportToCsv}
              className="h-7 px-2 text-xs text-slate-600 dark:text-slate-400"
            >
              <Download className="h-3 w-3 mr-1" />
              Export
            </Button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border border-slate-300 dark:border-slate-700">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const meta = header.column.columnDef.meta as
                    | { align?: string; width?: string }
                    | undefined
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        meta?.align === 'right' && 'text-right',
                        meta?.align === 'center' && 'text-center',
                      )}
                      style={{ width: meta?.width }}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={tableColumns.length}
                  className="h-12 text-center"
                >
                  <div className="flex flex-col items-center justify-center text-slate-500">
                    <p className="text-xs font-medium">{emptyMessage}</p>
                    <p className="text-[11px] text-slate-400">
                      {emptyDescription}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => {
                const depth = row.depth
                const rowUrl = getRowUrl?.(row.original)

                const rowContent = (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() ? 'selected' : undefined}
                  >
                    {row.getVisibleCells().map((cell, index) => {
                      const meta = cell.column.columnDef.meta as
                        | { align?: string }
                        | undefined
                      const column = columns.find(
                        (c) => c.id === cell.column.id,
                      )
                      const enableEditing = column?.enableEditing && onCellEdit

                      return (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            meta?.align === 'right' && 'text-right',
                            meta?.align === 'center' && 'text-center',
                          )}
                          style={{
                            paddingLeft:
                              enableHierarchy && index === 1
                                ? `${depth * 16 + 8}px`
                                : undefined,
                          }}
                        >
                          <EditableCell
                            cell={cell}
                            row={row}
                            onCellEdit={onCellEdit}
                            enableEditing={!!enableEditing}
                          />
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )

                if (enableContextMenu) {
                  return (
                    <ContextMenu key={row.id}>
                      <ContextMenuTrigger asChild>
                        {rowContent}
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        {rowUrl && (
                          <ContextMenuItem
                            onClick={() => handleOpenInNewTab(rowUrl)}
                          >
                            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                            Open in new tab
                          </ContextMenuItem>
                        )}
                        {rowUrl && renderContextMenuItems && (
                          <ContextMenuSeparator />
                        )}
                        {renderContextMenuItems?.(row)}
                      </ContextMenuContent>
                    </ContextMenu>
                  )
                }

                return rowContent
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {enablePagination && (
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <div className="flex items-center gap-1">
            {isLoading ? (
              <span className="text-slate-400">Loading...</span>
            ) : (
              <span>
                {(serverSidePagination && totalRows !== undefined
                  ? totalRows
                  : table.getFilteredRowModel().rows.length) === 0
                  ? 0
                  : table.getState().pagination.pageIndex *
                      table.getState().pagination.pageSize +
                    1}
                -
                {Math.min(
                  (table.getState().pagination.pageIndex + 1) *
                    table.getState().pagination.pageSize,
                  serverSidePagination && totalRows !== undefined
                    ? totalRows
                    : table.getFilteredRowModel().rows.length,
                )}{' '}
                of{' '}
                {serverSidePagination && totalRows !== undefined
                  ? totalRows
                  : table.getFilteredRowModel().rows.length}
              </span>
            )}
            <Select
              value={String(pagination.pageSize)}
              onValueChange={(value) => {
                const newPageSize = Number(value)
                setPagination({
                  ...pagination,
                  pageIndex: 0,
                  pageSize: newPageSize,
                })
                // Call onPageChange callback for server-side pagination
                if (serverSidePagination && onPageChange) {
                  onPageChange(1, newPageSize)
                }
              }}
              disabled={isLoading}
            >
              <SelectTrigger className="w-14 h-6 text-[11px] px-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage() || isLoading}
              aria-label="Go to first page"
            >
              <ChevronsLeft className="h-4 w-4" strokeWidth={2.5} />
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage() || isLoading}
              aria-label="Go to previous page"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
            </button>
            <span className="px-1.5 text-slate-600 dark:text-slate-400 tabular-nums">
              {table.getState().pagination.pageIndex + 1}/
              {table.getPageCount() || 1}
            </span>
            <button
              type="button"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage() || isLoading}
              aria-label="Go to next page"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage() || isLoading}
              aria-label="Go to last page"
            >
              <ChevronsRight className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Re-export types for convenience (RangeFilterValue and MultiSelectFilterValue are already exported at definition)
export type { SortingState, ColumnFiltersState, PaginationState, Row }
