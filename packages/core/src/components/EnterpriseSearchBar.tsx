// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, Loader2, Search } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import { enterpriseSearchQuery } from '@/lib/query'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import {
  getItemDetailPath,
  getItemTypeIconByName,
} from '@/lib/items/item-type-ui'

interface SearchResultItem {
  id: string
  itemNumber: string
  name?: string
  state?: string
  itemType: string
  designCode?: string | null
  designName?: string | null
  [key: string]: unknown
}

interface SearchResultGroup {
  itemType: string
  label: string
  icon: string
  items: Array<SearchResultItem>
  total: number
}

interface SearchResults {
  results: Array<SearchResultGroup>
}

function getShortcutHint(): string {
  if (typeof navigator === 'undefined') return ''

  const userAgent = navigator.userAgent.toLowerCase()

  // Check for mobile devices first - no shortcut hint
  const isMobile =
    /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
      userAgent,
    ) ||
    ('maxTouchPoints' in navigator && navigator.maxTouchPoints > 0)

  if (isMobile) return ''

  // Check for Mac
  const isMac =
    navigator.platform.toLowerCase().includes('mac') ||
    userAgent.includes('mac')

  return isMac ? ' (Cmd+K)' : ' (Ctrl+K)'
}

export function EnterpriseSearchBar() {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [shortcutHint, setShortcutHint] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  // Detect platform for shortcut hint on mount
  useEffect(() => {
    setShortcutHint(getShortcutHint())
  }, [])

  // Global keyboard shortcut (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Check for Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const isShortcut = e.key === 'k' && (isMac ? e.metaKey : e.ctrlKey)

      if (isShortcut) {
        e.preventDefault()
        e.stopPropagation()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }

    // Use capture phase to intercept before Chrome handles it
    document.addEventListener('keydown', handleGlobalKeyDown, { capture: true })
    return () =>
      document.removeEventListener('keydown', handleGlobalKeyDown, {
        capture: true,
      })
  }, [])

  // One request per typing pause, keyed on the settled term — a repeated
  // search resolves from cache instead of hitting the endpoint again.
  const debouncedQuery = useDebouncedValue(query)
  const { data: results = null, isFetching: isLoading } = useQuery(
    enterpriseSearchQuery<SearchResults>(debouncedQuery),
  )

  // Flatten results for keyboard navigation
  const flatResults =
    results?.results.flatMap((group) =>
      group.items.map((item) => ({ ...item, itemType: group.itemType })),
    ) || []

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Escape always works to blur the input
      if (e.key === 'Escape') {
        e.preventDefault()
        setIsOpen(false)
        setQuery('')
        inputRef.current?.blur()
        return
      }

      // Enter opens the highlighted item; with nothing to highlight it
      // falls through to the full results page.
      if (e.key === 'Enter') {
        e.preventDefault()
        const selected = isOpen ? flatResults[selectedIndex] : undefined
        if (selected) {
          navigateToItem(selected)
        } else if (query.trim().length >= 2) {
          navigateToResultsPage()
        }
        return
      }

      if (!isOpen || flatResults.length === 0) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % flatResults.length)
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(
            (prev) => (prev - 1 + flatResults.length) % flatResults.length,
          )
          break
      }
    },
    [isOpen, flatResults, selectedIndex, query],
  )

  const navigateToItem = (item: SearchResultItem) => {
    const path = getItemDetailPath(item.itemType, item.id)
    if (path) {
      navigate({ to: path })
      setQuery('')
      setIsOpen(false)
    }
  }

  const navigateToResultsPage = () => {
    navigate({ to: '/search', search: { search: query.trim() } })
    setIsOpen(false)
    inputRef.current?.blur()
  }

  const getIcon = (iconName: string) => getItemTypeIconByName(iconName)

  return (
    <div
      ref={containerRef}
      className="relative w-full max-w-md"
      data-testid="enterprise-search"
    >
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500"
          size={18}
        />
        <Input
          ref={inputRef}
          type="text"
          placeholder={`Search items...${shortcutHint}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => query.length >= 2 && setIsOpen(true)}
          autoComplete="off"
          className="pl-10 pr-10 h-9 text-sm bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700"
        />
        {isLoading && (
          <Loader2
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 animate-spin"
            size={16}
          />
        )}
      </div>

      {/* Search Results Dropdown */}
      {isOpen && results && (
        <div className="absolute top-full mt-2 w-full max-w-2xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-lg max-h-[32rem] overflow-y-auto z-50">
          {results.results.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">
              <Search className="mx-auto mb-2" size={32} />
              <p>No items found for "{query}"</p>
            </div>
          ) : (
            <div className="py-2">
              {results.results.map((group, groupIndex) => {
                const Icon = getIcon(group.icon)
                const currentFlatIndex = results.results
                  .slice(0, groupIndex)
                  .reduce((sum, g) => sum + g.items.length, 0)

                return (
                  <div key={group.itemType} className="mb-2 last:mb-0">
                    <div className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                      <Icon size={14} />
                      {group.label}
                      <span className="text-gray-400 dark:text-gray-600">
                        ({group.total})
                      </span>
                    </div>
                    <div className="space-y-1 px-2">
                      {group.items.map((item, itemIndex) => {
                        const flatIndex = currentFlatIndex + itemIndex
                        const isSelected = flatIndex === selectedIndex

                        return (
                          <button
                            key={item.id}
                            onClick={() => navigateToItem(item)}
                            onMouseEnter={() => setSelectedIndex(flatIndex)}
                            className={cn(
                              'w-full text-left px-3 py-2 rounded-md transition-colors',
                              'flex items-center justify-between gap-3',
                              isSelected
                                ? 'bg-cyan-500 text-white'
                                : 'hover:bg-gray-100 dark:hover:bg-gray-800',
                            )}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm font-medium">
                                  {item.itemNumber}
                                </span>
                                {item.state && (
                                  <span
                                    className={cn(
                                      'text-xs px-2 py-0.5 rounded-full',
                                      isSelected
                                        ? 'bg-white/20 text-white'
                                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
                                    )}
                                  >
                                    {item.state}
                                  </span>
                                )}
                              </div>
                              {item.name && (
                                <div
                                  className={cn(
                                    'text-sm mt-0.5 truncate',
                                    isSelected
                                      ? 'text-white'
                                      : 'text-gray-600 dark:text-gray-400',
                                  )}
                                >
                                  {item.name}
                                </div>
                              )}
                              {item.designCode && (
                                <div
                                  className={cn(
                                    'text-xs mt-0.5 flex items-center gap-1',
                                    isSelected
                                      ? 'text-white/80'
                                      : 'text-gray-500 dark:text-gray-500',
                                  )}
                                >
                                  <span>Design:</span>
                                  <span className="font-mono">
                                    {item.designCode}
                                  </span>
                                  {item.designName && (
                                    <span>• {item.designName}</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <button
            onClick={navigateToResultsPage}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium text-cyan-600 dark:text-cyan-400 border-t border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            View all results for "{query}"
            <ArrowRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
