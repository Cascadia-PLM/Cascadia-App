// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2, Plus } from 'lucide-react'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@/components/ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { designItemsQuery } from '@/lib/query'
import { ItemLink } from '@/components/items/ItemLink'
import { StateBadge } from '@/components/items/StateBadge'

interface AllItemsTabProps {
  designId: string
  versionContext: VersionContext
  isHistoricalView: boolean
  onCreateItem?: () => void
}

export function AllItemsTab({
  designId,
  versionContext,
  isHistoricalView,
  onCreateItem,
}: AllItemsTabProps) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [stateFilter, setStateFilter] = useState<string>('all')

  const {
    data: items = [],
    isPending: loading,
    error: loadError,
  } = useQuery(
    designItemsQuery(designId, {
      branch: versionContext.branchId,
      tag: versionContext.tagId,
      commit: versionContext.commitId,
    }),
  )
  const error = loadError
    ? 'Failed to load items. The API endpoint may not be implemented yet.'
    : null

  // Filter items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      // Search filter
      if (search) {
        const searchLower = search.toLowerCase()
        const matchesSearch =
          item.itemNumber.toLowerCase().includes(searchLower) ||
          item.name.toLowerCase().includes(searchLower)
        if (!matchesSearch) return false
      }

      // Type filter
      if (typeFilter !== 'all' && item.itemType !== typeFilter) {
        return false
      }

      // State filter
      if (stateFilter !== 'all' && item.state !== stateFilter) {
        return false
      }

      return true
    })
  }, [items, search, typeFilter, stateFilter])

  // Get unique types and states for filters
  const itemTypes = useMemo(() => {
    const types = new Set(items.map((i) => i.itemType))
    return Array.from(types).sort()
  }, [items])

  const itemStates = useMemo(() => {
    const states = new Set(items.map((i) => i.state))
    return Array.from(states).sort()
  }, [items])

  // Get item type badge variant
  const getTypeBadgeVariant = (itemType: string) => {
    switch (itemType) {
      case 'Part':
        return 'default' as const
      case 'Document':
        return 'secondary' as const
      case 'Requirement':
        return 'outline' as const
      default:
        return 'default' as const
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Input
            placeholder="Search items..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64"
          />
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {itemTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="State" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All States</SelectItem>
              {itemStates.map((state) => (
                <SelectItem key={state} value={state}>
                  {state}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {onCreateItem && (
          <Button onClick={onCreateItem} disabled={isHistoricalView}>
            <Plus className="h-4 w-4 mr-2" />
            New Item
          </Button>
        )}
      </div>

      {/* Error message */}
      {error && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800">
          <CardContent className="py-4">
            <p className="text-amber-700 dark:text-amber-300">{error}</p>
            <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">
              This feature requires the items API endpoint to be implemented.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Items List */}
      <Card>
        <CardHeader>
          <CardTitle>All Items</CardTitle>
          <CardDescription>
            {filteredItems.length} of {items.length} items
            {isHistoricalView && (
              <span className="text-amber-600 dark:text-amber-400 ml-2">
                (viewing historical state)
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredItems.length > 0 ? (
            <div className="border rounded-lg divide-y dark:border-slate-700 dark:divide-slate-700">
              {/* Header */}
              <div className="flex items-center gap-4 py-2 px-4 bg-slate-50 dark:bg-slate-800 text-sm font-medium text-slate-500 dark:text-slate-400">
                <div className="w-24">Number</div>
                <div className="w-20">Type</div>
                <div className="flex-1">Name</div>
                <div className="w-16 text-center">Rev</div>
                <div className="w-24 text-center">State</div>
                <div className="w-32">Modified</div>
                <div className="w-20"></div>
              </div>

              {/* Rows */}
              {filteredItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-4 py-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <div className="w-24 font-medium text-slate-900 dark:text-white">
                    {item.itemNumber}
                  </div>
                  <div className="w-20">
                    <Badge
                      variant={getTypeBadgeVariant(item.itemType)}
                      className="text-xs"
                    >
                      {item.itemType}
                    </Badge>
                  </div>
                  <div className="flex-1 text-slate-600 dark:text-slate-400 truncate">
                    {item.name}
                  </div>
                  <div className="w-16 text-center text-sm text-slate-500">
                    {item.revision}
                  </div>
                  <div className="w-24 text-center">
                    <StateBadge
                      itemType={item.itemType}
                      state={item.state}
                      className="text-xs"
                    />
                  </div>
                  <div className="w-32 text-sm text-slate-500">
                    {item.modifiedAt
                      ? new Date(item.modifiedAt).toLocaleDateString()
                      : '-'}
                  </div>
                  <div className="w-20">
                    <ItemLink itemType={item.itemType} itemId={item.id}>
                      <Button variant="ghost" size="sm">
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    </ItemLink>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            !error && (
              <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                {items.length === 0
                  ? 'No items found in this design.'
                  : 'No items match your filters.'}
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  )
}
