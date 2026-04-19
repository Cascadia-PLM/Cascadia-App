import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Info, Loader2, Search } from 'lucide-react'
import {
  getAvailableActions,
  getDefaultChangeAction,
  getTargetInfo,
} from './eco-helpers'
import type { ChangeAction } from '@/lib/types/lifecycle'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import type { Row } from '@tanstack/react-table'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'
import { DataGrid } from '@/components/ui/DataGrid'
import { apiFetch } from '@/lib/api/client'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { cn } from '@/lib/utils'

interface DesignItem {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
}

interface CrossDesignItem {
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
  designId?: string | null
  designCode?: string | null
  designName?: string | null
}

type ImportDesignScope = 'all' | 'library'

interface AddPartFromDesignDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  designId: string
  designName: string
  changeOrderId: string
  designType?: string
  branchId?: string | null
  onSuccess: () => void
}

export function AddPartFromDesignDialog({
  open,
  onOpenChange,
  designId,
  designName,
  changeOrderId,
  designType,
  branchId,
  onSuccess,
}: AddPartFromDesignDialogProps) {
  const { alert } = useAlertDialog()
  const isLibrary = designType === 'Library'
  const [step, setStep] = useState<'select' | 'review'>('select')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [affectedItemIds, setAffectedItemIds] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedItemsMap, setSelectedItemsMap] = useState<
    Map<string, DesignItem>
  >(new Map())
  const [description, setDescription] = useState('')
  const [actionOverrides, setActionOverrides] = useState<
    Record<string, ChangeAction>
  >({})

  // Server-side pagination state
  const [pageItems, setPageItems] = useState<Array<DesignItem>>([])
  const [totalItems, setTotalItems] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  // Library mode toggle: 'add' = add existing library parts, 'import' = cross-design import
  const [libraryMode, setLibraryMode] = useState<'add' | 'import'>('add')

  // Import mode state (Library designs)
  const [importScope, setImportScope] = useState<ImportDesignScope>('all')
  const [importResults, setImportResults] = useState<Array<CrossDesignItem>>([])
  const [importSearching, setImportSearching] = useState(false)

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Fetch affected items (once on open)
  const fetchAffectedItems = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/change-orders/${changeOrderId}/affected-items`,
      ).then((r) => (r.ok ? r.json() : { data: { affectedItems: [] } }))
      const ids = new Set<string>()
      for (const item of response.data?.affectedItems || []) {
        if (item.affectedItemId) ids.add(item.affectedItemId)
      }
      setAffectedItemIds(ids)
    } catch {
      // Will show empty set
    }
  }, [changeOrderId])

  // Fetch paginated design items
  const fetchPageData = useCallback(async () => {
    setLoading(true)
    try {
      const offset = (page - 1) * pageSize
      const params = new URLSearchParams({
        type: 'Part',
        limit: String(pageSize),
        offset: String(offset),
      })
      if (debouncedSearch) {
        params.set('search', debouncedSearch)
      }
      const response = await apiFetch<{
        data: { items: Array<DesignItem>; total: number }
      }>(`/api/designs/${designId}/items?${params}`)
      setPageItems(response.data.items)
      setTotalItems(response.data.total)
    } catch {
      setPageItems([])
      setTotalItems(0)
    } finally {
      setLoading(false)
    }
  }, [designId, page, pageSize, debouncedSearch])

  // Fetch existing items in this Library design (to filter out already-imported)
  const existingDesignItemIdsRef = useRef<Set<string>>(new Set())

  const fetchExistingDesignItems = useCallback(async () => {
    try {
      const response = await apiFetch<{
        data: { items: Array<{ id: string }>; total: number }
      }>(`/api/designs/${designId}/items?type=Part&limit=1000`)
      existingDesignItemIdsRef.current = new Set(
        response.data.items.map((i) => i.id),
      )
    } catch {
      // Silently fail
    }
  }, [designId])

  // Dialog open effect
  useEffect(() => {
    if (open) {
      setStep('select')
      setSelectedIds(new Set())
      setSelectedItemsMap(new Map())
      setSearchQuery('')
      setDebouncedSearch('')
      setDescription('')
      setActionOverrides({})
      setImportResults([])
      setImportScope('all')
      setLibraryMode('add')
      setPage(1)
      setPageSize(20)
      setPageItems([])
      setTotalItems(0)

      fetchAffectedItems()

      if (isLibrary) {
        fetchExistingDesignItems()
      }
    }
  }, [open, fetchAffectedItems, fetchExistingDesignItems, isLibrary])

  // Fetch page data when pagination/search changes (only when not in import mode)
  useEffect(() => {
    if (!open) return
    if (isLibrary && libraryMode === 'import') return
    fetchPageData()
  }, [open, fetchPageData, isLibrary, libraryMode])

  // Cross-design search for Library import mode
  useEffect(() => {
    if (!isLibrary || !open || libraryMode !== 'import') return

    const debounceTimer = setTimeout(async () => {
      if (searchQuery.length < 2) {
        setImportResults([])
        return
      }

      setImportSearching(true)
      try {
        const params = new URLSearchParams({
          q: searchQuery,
          types: 'Part',
          limit: '50',
        })
        // Only add designScope if not 'all' — omitting it searches all items without scope restriction
        if (importScope === 'library') {
          params.set('designScope', 'library')
        }
        params.set('contextDesignId', designId)

        const response = await fetch(`/api/items/search?${params}`)
        if (response.ok) {
          const data = await response.json()
          const items: Array<CrossDesignItem> = data.data?.items ?? []
          // Filter out items already in this Library design
          const filtered = items.filter(
            (item) =>
              item.designId !== designId &&
              !existingDesignItemIdsRef.current.has(item.id),
          )
          setImportResults(filtered)
        }
      } catch {
        // Search failed silently
      } finally {
        setImportSearching(false)
      }
    }, 300)

    return () => clearTimeout(debounceTimer)
  }, [searchQuery, importScope, isLibrary, libraryMode, open, designId])

  // --- Selection helpers ---

  const toggleItem = (id: string, item?: DesignItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
    setSelectedItemsMap((prev) => {
      const next = new Map(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (item) {
        next.set(id, item)
      }
      return next
    })
  }

  const toggleAllOnPage = (checked: boolean) => {
    const selectableItems = pageItems.filter(
      (item) => !affectedItemIds.has(item.id),
    )
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const item of selectableItems) {
        if (checked) {
          next.add(item.id)
        } else {
          next.delete(item.id)
        }
      }
      return next
    })
    setSelectedItemsMap((prev) => {
      const next = new Map(prev)
      for (const item of selectableItems) {
        if (checked) {
          next.set(item.id, item)
        } else {
          next.delete(item.id)
        }
      }
      return next
    })
  }

  // For normal mode — use accumulated map
  const selectedItems = Array.from(selectedItemsMap.values())

  // For import mode
  const selectedImportItems = importResults.filter((item) =>
    selectedIds.has(item.id),
  )

  const getItemAction = (item: DesignItem): ChangeAction => {
    return actionOverrides[item.id] ?? getDefaultChangeAction(item.state)
  }

  const setItemAction = (itemId: string, action: ChangeAction) => {
    setActionOverrides((prev) => ({ ...prev, [itemId]: action }))
  }

  // Normal mode submit
  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const itemsPayload = selectedItems.map((item) => {
        const action = getItemAction(item)
        const target = getTargetInfo(item.state, item.revision, action)
        return {
          affectedItemId: item.id,
          changeAction: action,
          currentState: item.state,
          currentRevision: item.revision,
          targetState: target.targetState,
          targetRevision: target.targetRevision,
          changeDescription: description || null,
        }
      })

      await apiFetch(`/api/change-orders/${changeOrderId}/affected-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsPayload }),
      })

      alert({
        title: 'Items Added',
        description: `${selectedItems.length} item${selectedItems.length !== 1 ? 's' : ''} added to ECO.`,
      })

      onOpenChange(false)
      onSuccess()
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to add items to ECO.',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  // Library import mode submit
  const handleImportSubmit = async () => {
    setSubmitting(true)
    try {
      // Step 1: Create usages in the Library design for each selected item
      const createdUsageIds: Array<string> = []

      for (const item of selectedImportItems) {
        const response = await apiFetch<{
          data: {
            items: Array<{ id: string; revision: string; state: string }>
          }
        }>(`/api/designs/${designId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            itemId: item.id,
            mode: 'usage_copy',
            branchId: branchId || undefined,
          }),
        })

        for (const created of response.data.items) {
          createdUsageIds.push(created.id)
        }
      }

      // Step 2: Register all created usages as ECO affected items with action 'add'
      if (createdUsageIds.length > 0) {
        const itemsPayload = createdUsageIds.map((id) => ({
          affectedItemId: id,
          changeAction: 'add' as const,
          currentState: null,
          currentRevision: null,
          targetState: 'Draft',
          targetRevision: '-',
          changeDescription: description || null,
        }))

        await apiFetch(`/api/change-orders/${changeOrderId}/affected-items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: itemsPayload }),
        })
      }

      alert({
        title: 'Parts Imported',
        description: `${selectedImportItems.length} part${selectedImportItems.length !== 1 ? 's' : ''} imported as usages into the Library.`,
      })

      onOpenChange(false)
      onSuccess()
    } catch {
      alert({
        title: 'Error',
        description:
          'Failed to import parts. Some items may have been partially imported.',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const getStateBadgeVariant = (state: string) => {
    switch (state) {
      case 'Released':
        return 'success' as const
      case 'Draft':
        return 'secondary' as const
      default:
        return 'default' as const
    }
  }

  const scopeOptions: Array<{ value: ImportDesignScope; label: string }> = [
    { value: 'all', label: 'All Designs' },
    { value: 'library', label: 'Standard Library' },
  ]

  // Determine effective selected items for display
  const effectiveSelectedCount =
    isLibrary && libraryMode === 'import'
      ? selectedImportItems.length
      : selectedIds.size

  // Switch library mode handler — clears selection state
  const switchLibraryMode = (mode: 'add' | 'import') => {
    if (mode === libraryMode) return
    setLibraryMode(mode)
    setSelectedIds(new Set())
    setSelectedItemsMap(new Map())
    setSearchQuery('')
    setDebouncedSearch('')
    setPage(1)
  }

  // --- DataGrid columns for design items ---
  const selectableOnPage = pageItems.filter(
    (item) => !affectedItemIds.has(item.id),
  )
  const allPageSelected =
    selectableOnPage.length > 0 &&
    selectableOnPage.every((item) => selectedIds.has(item.id))
  const somePageSelected = selectableOnPage.some((item) =>
    selectedIds.has(item.id),
  )

  const designItemColumns: Array<DataGridColumn<DesignItem>> = [
    {
      id: 'select',
      header: '', // We render a custom header via cell — but DataGrid uses string headers
      accessorFn: () => null,
      cell: ({ row }: { row: Row<DesignItem>; getValue: () => unknown }) => {
        const item = row.original
        const isAffected = affectedItemIds.has(item.id)
        const isSelected = selectedIds.has(item.id)
        return (
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => !isAffected && toggleItem(item.id, item)}
            disabled={isAffected}
          />
        )
      },
      enableSorting: false,
      enableFiltering: false,
      meta: { width: '40px' },
    },
    {
      id: 'itemNumber',
      header: 'Item',
      accessorKey: 'itemNumber',
      enableSorting: false,
      meta: { width: '140px' },
    },
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      enableSorting: false,
      cell: ({
        getValue,
      }: {
        row: Row<DesignItem>
        getValue: () => unknown
      }) => {
        const val = getValue() as string | null
        return (
          <span className="truncate text-slate-600 dark:text-slate-400">
            {val || '-'}
          </span>
        )
      },
    },
    {
      id: 'revision',
      header: 'Rev',
      accessorKey: 'revision',
      enableSorting: false,
      meta: { width: '60px', align: 'center' as const },
    },
    {
      id: 'state',
      header: 'State',
      accessorKey: 'state',
      enableSorting: false,
      cell: ({
        getValue,
      }: {
        row: Row<DesignItem>
        getValue: () => unknown
      }) => {
        const state = getValue() as string
        return (
          <Badge variant={getStateBadgeVariant(state)} className="text-xs">
            {state}
          </Badge>
        )
      },
      meta: { width: '100px', align: 'center' as const },
    },
    {
      id: 'eco',
      header: '',
      accessorFn: () => null,
      enableSorting: false,
      enableFiltering: false,
      cell: ({ row }: { row: Row<DesignItem>; getValue: () => unknown }) => {
        if (affectedItemIds.has(row.original.id)) {
          return (
            <Badge variant="outline" className="text-xs">
              Already in ECO
            </Badge>
          )
        }
        return null
      },
      meta: { width: '110px' },
    },
  ]

  // Render the design items DataGrid (shared between normal and library "add" modes)
  const renderDesignItemsGrid = () => (
    <div className="flex flex-col min-h-0 flex-1 gap-2">
      {/* Search + count + select-all */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Search by item number or name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8"
          />
        </div>
        {selectableOnPage.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer whitespace-nowrap">
            <Checkbox
              checked={allPageSelected}
              // Use string 'indeterminate' or boolean for indeterminate state
              {...(somePageSelected && !allPageSelected
                ? { 'data-state': 'indeterminate' }
                : {})}
              onCheckedChange={(checked) => toggleAllOnPage(!!checked)}
            />
            All on page
          </label>
        )}
        {selectedIds.size > 0 && (
          <Badge variant="default" className="text-xs whitespace-nowrap">
            {selectedIds.size} selected
          </Badge>
        )}
      </div>

      {/* DataGrid */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <DataGrid
          data={pageItems}
          columns={designItemColumns}
          getRowId={(row) => row.id}
          serverSidePagination
          serverSideOperations
          totalRows={totalItems}
          isLoading={loading}
          pagination={{ pageIndex: page - 1, pageSize }}
          onPaginationChange={(p) => {
            setPage(p.pageIndex + 1)
            setPageSize(p.pageSize)
          }}
          onPageChange={(p, ps) => {
            setPage(p)
            setPageSize(ps)
          }}
          enableGlobalFilter={false}
          enableFiltering={false}
          enableSorting={false}
          defaultPageSize={20}
          pageSizeOptions={[20, 50, 100]}
          emptyMessage={
            searchQuery
              ? 'No parts match your search.'
              : 'No parts found in this design.'
          }
        />
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {step === 'select'
              ? isLibrary
                ? `Add Parts to ${designName}`
                : `Add Parts from ${designName}`
              : `Review ${effectiveSelectedCount} Items`}
          </DialogTitle>
          <DialogDescription>
            {step === 'select'
              ? isLibrary
                ? 'Add existing library parts or import from other designs.'
                : 'Select parts to add as affected items in this ECO.'
              : isLibrary && libraryMode === 'import'
                ? 'Review the parts to be imported as usages.'
                : 'Review the change actions for each item before adding them.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'select' ? (
          isLibrary ? (
            /* Step 1 — Library Mode: Toggle between Add from Library / Import from Designs */
            <div className="space-y-3 py-2 overflow-hidden flex flex-col min-h-0">
              {/* Mode toggle */}
              <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => switchLibraryMode('add')}
                  className={cn(
                    'flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    libraryMode === 'add'
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
                  )}
                >
                  Add from Library
                </button>
                <button
                  type="button"
                  onClick={() => switchLibraryMode('import')}
                  className={cn(
                    'flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    libraryMode === 'import'
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
                  )}
                >
                  Import from Designs
                </button>
              </div>

              {libraryMode === 'import' ? (
                /* Import from Designs sub-mode */
                <>
                  {/* Scope selector */}
                  <div>
                    <Label className="text-sm font-medium mb-2 block">
                      Source
                    </Label>
                    <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                      {scopeOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setImportScope(option.value)}
                          className={cn(
                            'flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                            importScope === option.value
                              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Search + count */}
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <Input
                        placeholder="Search by part number or name (min 2 characters)..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9 h-8"
                      />
                    </div>
                    {selectedIds.size > 0 && (
                      <Badge
                        variant="default"
                        className="text-xs whitespace-nowrap"
                      >
                        {selectedIds.size} selected
                      </Badge>
                    )}
                  </div>

                  {/* Scrollable results */}
                  <div className="border rounded-lg dark:border-slate-700 overflow-y-auto min-h-0 flex-1">
                    {importSearching ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                      </div>
                    ) : searchQuery.length < 2 ? (
                      <div className="text-center py-8 text-sm text-slate-500">
                        Type at least 2 characters to search across designs.
                      </div>
                    ) : importResults.length === 0 ? (
                      <div className="text-center py-8 text-sm text-slate-500">
                        No parts found matching your search.
                      </div>
                    ) : (
                      <div className="divide-y dark:divide-slate-700">
                        {importResults.map((item) => {
                          const isAffected = affectedItemIds.has(item.id)
                          const isSelected = selectedIds.has(item.id)

                          return (
                            <label
                              key={item.id}
                              className={cn(
                                'flex items-center gap-3 px-3 py-1.5 text-sm cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800',
                                isAffected && 'opacity-50 cursor-not-allowed',
                              )}
                            >
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() =>
                                  !isAffected && toggleItem(item.id)
                                }
                                disabled={isAffected}
                              />
                              <span className="font-medium text-slate-900 dark:text-white min-w-[120px] truncate">
                                {item.itemNumber}
                              </span>
                              <span className="flex-1 text-slate-600 dark:text-slate-400 truncate">
                                {item.name || '-'}
                              </span>
                              <span className="text-xs text-slate-500 w-10 text-center">
                                {item.revision}
                              </span>
                              <Badge
                                variant={getStateBadgeVariant(item.state)}
                                className="text-xs"
                              >
                                {item.state}
                              </Badge>
                              {item.designCode && (
                                <Badge variant="outline" className="text-xs">
                                  {item.designCode}
                                </Badge>
                              )}
                              {isAffected && (
                                <Badge variant="outline" className="text-xs">
                                  Already in ECO
                                </Badge>
                              )}
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                /* Add from Library sub-mode — server-side paginated DataGrid */
                renderDesignItemsGrid()
              )}
            </div>
          ) : (
            /* Step 1 — Normal Mode: Select parts from same design */
            <div className="space-y-3 py-2 overflow-hidden flex flex-col min-h-0">
              {renderDesignItemsGrid()}
            </div>
          )
        ) : isLibrary && libraryMode === 'import' ? (
          /* Step 2 — Import Mode Review */
          <div className="space-y-4 py-2 overflow-y-auto min-h-0">
            {/* Info banner */}
            <div className="flex gap-3 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-blue-900 dark:text-blue-100">
                  Importing as Usages
                </p>
                <p className="text-blue-700 dark:text-blue-300 mt-0.5">
                  These parts will be imported as usages into the Library design
                  and registered as ECO affected items with action{' '}
                  <strong>Add</strong>.
                </p>
              </div>
            </div>

            <div className="border rounded-lg dark:border-slate-700">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                  <tr className="text-xs text-slate-600 dark:text-slate-400 font-medium">
                    <th className="text-left px-3 py-1.5">Item</th>
                    <th className="text-left px-3 py-1.5">Name</th>
                    <th className="text-center px-3 py-1.5">Rev</th>
                    <th className="text-center px-3 py-1.5">State</th>
                    <th className="text-center px-3 py-1.5">Source</th>
                    <th className="text-center px-3 py-1.5">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-slate-700">
                  {selectedImportItems.map((item) => (
                    <tr
                      key={item.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <td className="px-3 py-1.5 font-medium text-slate-900 dark:text-white whitespace-nowrap">
                        {item.itemNumber}
                      </td>
                      <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400 truncate max-w-[150px]">
                        {item.name || '-'}
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs text-slate-500 dark:text-slate-400">
                        {item.revision}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <Badge
                          variant={getStateBadgeVariant(item.state)}
                          className="text-xs"
                        >
                          {item.state}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {item.designCode && (
                          <Badge variant="outline" className="text-xs">
                            {item.designCode}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <Badge variant="success" className="text-xs">
                          Add
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2">
              <Label htmlFor="import-parts-description">
                Description (optional)
              </Label>
              <Textarea
                id="import-parts-description"
                placeholder="Describe why these parts are being imported..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        ) : (
          /* Step 2 — Normal Mode Review */
          <div className="space-y-4 py-2 overflow-y-auto min-h-0">
            <div className="border rounded-lg dark:border-slate-700">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                  <tr className="text-xs text-slate-600 dark:text-slate-400 font-medium">
                    <th className="text-left px-3 py-1.5">Item</th>
                    <th className="text-left px-3 py-1.5">Name</th>
                    <th className="text-center px-3 py-1.5">Rev</th>
                    <th className="text-center px-3 py-1.5">State</th>
                    <th className="text-center px-3 py-1.5">Action</th>
                    <th className="text-center px-3 py-1.5">Target</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-slate-700">
                  {selectedItems.map((item) => {
                    const action = getItemAction(item)
                    const available = getAvailableActions(item.state)
                    const target = getTargetInfo(
                      item.state,
                      item.revision,
                      action,
                    )

                    return (
                      <tr
                        key={item.id}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <td className="px-3 py-1.5 font-medium text-slate-900 dark:text-white whitespace-nowrap">
                          {item.itemNumber}
                        </td>
                        <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400 truncate max-w-[150px]">
                          {item.name || '-'}
                        </td>
                        <td className="px-3 py-1.5 text-center text-xs text-slate-500 dark:text-slate-400">
                          {item.revision}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <Badge
                            variant={getStateBadgeVariant(item.state)}
                            className="text-xs"
                          >
                            {item.state}
                          </Badge>
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {available.length > 1 ? (
                            <Select
                              value={action}
                              onValueChange={(v) =>
                                setItemAction(item.id, v as ChangeAction)
                              }
                            >
                              <SelectTrigger className="h-7 w-24 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {available.map((a) => (
                                  <SelectItem key={a.value} value={a.value}>
                                    {a.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge
                              variant={
                                action === 'release'
                                  ? 'success'
                                  : action === 'obsolete'
                                    ? 'destructive'
                                    : 'default'
                              }
                              className="text-xs"
                            >
                              {available[0]?.label ?? action}
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-center text-xs text-slate-500 dark:text-slate-400">
                          Rev {target.targetRevision} ({target.targetState})
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-2">
              <Label htmlFor="add-parts-description">
                Description (optional)
              </Label>
              <Textarea
                id="add-parts-description"
                placeholder="Describe the changes..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'review' && (
            <Button
              variant="outline"
              onClick={() => setStep('select')}
              className="mr-auto"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {step === 'select' ? (
            <Button
              onClick={() => setStep('review')}
              disabled={selectedIds.size === 0}
            >
              Review ({selectedIds.size})
            </Button>
          ) : (
            <Button
              onClick={
                isLibrary && libraryMode === 'import'
                  ? handleImportSubmit
                  : handleSubmit
              }
              disabled={submitting || effectiveSelectedCount === 0}
            >
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isLibrary && libraryMode === 'import'
                ? `Import ${effectiveSelectedCount} Part${effectiveSelectedCount !== 1 ? 's' : ''}`
                : `Add ${selectedItems.length} Item${selectedItems.length !== 1 ? 's' : ''} to ECO`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
