import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import type { BreadcrumbDropdownProps } from './breadcrumb-types'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover'

const INITIAL_VISIBLE_COUNT = 5

/**
 * BreadcrumbDropdown - A searchable dropdown for selecting programs or designs in breadcrumbs.
 * Supports grouped items for the design dropdown (regular designs vs libraries).
 * Shows a search input and limits initial display to 5 items per group.
 */
export function BreadcrumbDropdown({
  type,
  items,
  selectedId,
  onSelect,
  placeholder,
}: BreadcrumbDropdownProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [expandedRegular, setExpandedRegular] = useState(false)
  const [expandedLibrary, setExpandedLibrary] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedItem = items.find((item) => item.id === selectedId)

  // For design dropdown, separate regular designs from libraries
  const regularItems =
    type === 'design'
      ? items.filter((item) => item.designType !== 'Library')
      : items
  const libraryItems =
    type === 'design'
      ? items.filter((item) => item.designType === 'Library')
      : []

  // Filter items based on search query
  const query = search.toLowerCase().trim()
  const isSearching = query.length > 0

  const filteredRegular = useMemo(
    () =>
      isSearching
        ? regularItems.filter(
            (item) =>
              item.code.toLowerCase().includes(query) ||
              item.name.toLowerCase().includes(query),
          )
        : regularItems,
    [regularItems, query, isSearching],
  )

  const filteredLibrary = useMemo(
    () =>
      isSearching
        ? libraryItems.filter(
            (item) =>
              item.code.toLowerCase().includes(query) ||
              item.name.toLowerCase().includes(query),
          )
        : libraryItems,
    [libraryItems, query, isSearching],
  )

  // Determine visible items (no cap when searching or expanded)
  const visibleRegular =
    isSearching || expandedRegular
      ? filteredRegular
      : filteredRegular.slice(0, INITIAL_VISIBLE_COUNT)
  const visibleLibrary =
    isSearching || expandedLibrary
      ? filteredLibrary
      : filteredLibrary.slice(0, INITIAL_VISIBLE_COUNT)

  const hasMoreRegular =
    !isSearching &&
    !expandedRegular &&
    filteredRegular.length > INITIAL_VISIBLE_COUNT
  const hasMoreLibrary =
    !isSearching &&
    !expandedLibrary &&
    filteredLibrary.length > INITIAL_VISIBLE_COUNT

  const noResults =
    isSearching && filteredRegular.length === 0 && filteredLibrary.length === 0

  // Reset state when popover closes
  useEffect(() => {
    if (!open) {
      setSearch('')
      setExpandedRegular(false)
      setExpandedLibrary(false)
    }
  }, [open])

  // Auto-focus search input when popover opens
  useEffect(() => {
    if (open) {
      // Small delay to let the popover render
      const timer = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(timer)
    }
  }, [open])

  const handleSelect = (id: string) => {
    onSelect(id)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors outline-none">
        <span
          className={
            selectedItem ? 'font-medium text-slate-900 dark:text-white' : ''
          }
        >
          {selectedItem ? selectedItem.code : placeholder}
        </span>
        <ChevronDown className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
          <Search className="h-4 w-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-slate-400 text-slate-900 dark:text-slate-100"
          />
        </div>

        {/* Scrollable item list */}
        <div className="max-h-64 overflow-y-auto py-1">
          {/* Clear selection item */}
          {!isSearching && (
            <>
              <button
                type="button"
                onClick={() => handleSelect('')}
                className="w-full text-left px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                {placeholder}
              </button>
              {(visibleRegular.length > 0 || visibleLibrary.length > 0) && (
                <div className="mx-3 my-1 border-t border-slate-200 dark:border-slate-800" />
              )}
            </>
          )}

          {/* Regular items */}
          {visibleRegular.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => handleSelect(item.id)}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center"
            >
              <span className="font-medium">{item.code}</span>
              <span className="ml-2 text-slate-500 truncate">{item.name}</span>
            </button>
          ))}

          {/* Show all button for regular items */}
          {hasMoreRegular && (
            <button
              type="button"
              onClick={() => setExpandedRegular(true)}
              className="w-full text-left px-3 py-1.5 text-xs text-cyan-600 dark:text-cyan-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              Show all {filteredRegular.length} items
            </button>
          )}

          {/* Library section */}
          {(visibleLibrary.length > 0 || hasMoreLibrary) && (
            <>
              <div className="mx-3 my-1 border-t border-slate-200 dark:border-slate-800" />
              <div className="px-3 py-1 text-xs font-medium text-slate-500">
                Libraries
              </div>
              {visibleLibrary.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => handleSelect(item.id)}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center"
                >
                  <span className="font-medium">{item.code}</span>
                  <span className="ml-2 text-slate-500 truncate">
                    {item.name}
                  </span>
                </button>
              ))}

              {/* Show all button for library items */}
              {hasMoreLibrary && (
                <button
                  type="button"
                  onClick={() => setExpandedLibrary(true)}
                  className="w-full text-left px-3 py-1.5 text-xs text-cyan-600 dark:text-cyan-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Show all {filteredLibrary.length} libraries
                </button>
              )}
            </>
          )}

          {/* No results message */}
          {noResults && (
            <div className="px-3 py-3 text-sm text-slate-400 text-center">
              No results found
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
