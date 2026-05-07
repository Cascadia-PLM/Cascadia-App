import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  CheckSquare,
  FileText,
  GitBranch,
  ListChecks,
  Loader2,
  Package,
  Search,
} from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

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

const iconMap: Record<
  string,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  Package,
  FileText,
  CheckSquare,
  ListChecks,
  GitBranch,
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
  const [results, setResults] = useState<SearchResults | null>(null)
  const [isLoading, setIsLoading] = useState(false)
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

  // Flatten results for keyboard navigation
  const flatResults =
    results?.results.flatMap((group) =>
      group.items.map((item) => ({ ...item, itemType: group.itemType })),
    ) || []

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults(null)
      setIsOpen(false)
      return
    }

    setIsLoading(true)
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/enterprise-search?q=${encodeURIComponent(query)}&limit=20`,
        )
        const data = await response.json()
        setResults(data.data)
        setIsOpen(true)
        setSelectedIndex(0)
      } catch {
        setResults(null)
      } finally {
        setIsLoading(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [query])

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
        case 'Enter':
          e.preventDefault()
          if (flatResults[selectedIndex]) {
            navigateToItem(flatResults[selectedIndex])
          }
          break
      }
    },
    [isOpen, flatResults, selectedIndex],
  )

  const navigateToItem = (item: SearchResultItem) => {
    const routes: Record<string, string> = {
      Part: '/parts',
      Document: '/documents',
      Task: '/tasks',
      Requirement: '/requirements',
      ChangeOrder: '/change-orders',
    }

    const basePath = routes[item.itemType]
    if (basePath) {
      navigate({ to: `${basePath}/${item.id}` })
      setQuery('')
      setIsOpen(false)
    }
  }

  const getIcon = (iconName: string) => {
    const IconComponent = iconMap[iconName] ?? Search
    return IconComponent
  }

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
                let currentFlatIndex = 0
                for (let i = 0; i < groupIndex; i++) {
                  currentFlatIndex += results.results[i].items.length
                }

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
        </div>
      )}
    </div>
  )
}
