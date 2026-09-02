// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info, Link2, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Badge } from '@/components/ui/Badge'
import { isValidQuantity } from '@/components/items/bom-quantity'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import { itemTextSearchQuery } from '@/lib/query/options/item-search'
import { cn } from '@/lib/utils'
import { StateBadge } from '@/components/items/StateBadge'

type DesignScope = 'current' | 'library'

interface EnrichedItem {
  id: string
  itemNumber: string
  revision: string
  itemType: string
  name: string
  state: string
  designId?: string | null
  designCode?: string | null
  designName?: string | null
  isExternal?: boolean
}

interface AddBomChildToEcoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ecoId: string
  parentItemId: string
  parentItemNumber: string
  currentDesignId: string
  currentDesignCode: string
  onSuccess: () => void
}

export function AddBomChildToEcoDialog({
  open,
  onOpenChange,
  ecoId,
  parentItemId,
  parentItemNumber,
  currentDesignId,
  currentDesignCode,
  onSuccess,
}: AddBomChildToEcoDialogProps) {
  const { alert } = useAlertDialog()
  const [designScope, setDesignScope] = useState<DesignScope>('current')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedItem, setSelectedItem] = useState<EnrichedItem | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [findNumber, setFindNumber] = useState('')
  const [loading, setLoading] = useState(false)

  // One request per typing pause, keyed on the settled term
  const debouncedQuery = useDebouncedValue(searchQuery)
  const { data: matches = [], isFetching: searching } = useQuery(
    itemTextSearchQuery<EnrichedItem>(
      {
        q: debouncedQuery,
        types: ['Part'],
        designScope,
        contextDesignId: currentDesignId,
      },
      debouncedQuery.length >= 2,
    ),
  )
  // An assembly cannot be its own child
  const searchResults = matches.filter((item) => item.id !== parentItemId)

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setDesignScope('current')
      setSearchQuery('')
      setSelectedItem(null)
      setQuantity('1')
      setFindNumber('')
    }
  }, [open])

  const quantityInvalid = !isValidQuantity(quantity)

  const handleAdd = async () => {
    if (!selectedItem || quantityInvalid) return

    setLoading(true)
    try {
      await apiFetch(`/api/v1/change-orders/${ecoId}/bom-changes`, {
        method: 'POST',
        body: JSON.stringify({
          parentItemId,
          childItemId: selectedItem.id,
          // parseFloat, not parseInt — BOM quantities are decimals ("2.5")
          quantity: parseFloat(quantity),
          findNumber: findNumber ? parseInt(findNumber) : undefined,
          action: 'add',
        }),
      })

      onSuccess()
      onOpenChange(false)
    } catch (error) {
      alert({
        title: 'Failed to add BOM relationship',
        description:
          error instanceof Error && error.message
            ? error.message
            : 'Failed to add BOM relationship. Make sure the parent item is an affected item in this ECO.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const scopeOptions: Array<{ value: DesignScope; label: string }> = [
    { value: 'current', label: 'This Design' },
    { value: 'library', label: 'Standard Library' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto auto-hide-scroll">
        <DialogHeader>
          <DialogTitle>Add BOM Child</DialogTitle>
          <DialogDescription>
            Add a child part to{' '}
            <span className="font-medium">{parentItemNumber}</span> in{' '}
            <span className="font-medium">{currentDesignCode}</span> through
            this ECO
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ECO BOM Change Info Banner */}
          <div className="flex gap-3 p-3 bg-cyan-50 dark:bg-cyan-950/30 border border-cyan-200 dark:border-cyan-800 rounded-lg">
            <Info className="h-5 w-5 text-cyan-600 dark:text-cyan-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-cyan-900 dark:text-cyan-100">
                BOM Change via ECO
              </p>
              <p className="text-cyan-700 dark:text-cyan-300 mt-0.5">
                This BOM change will be tracked by the ECO. The child part will{' '}
                <strong>not</strong> be automatically added as an affected item
                - only the parent's BOM is being modified.
              </p>
            </div>
          </div>

          {/* Source Selector */}
          <div>
            <Label className="text-sm font-medium mb-2 block">Source</Label>
            <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
              {scopeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setDesignScope(option.value)}
                  className={cn(
                    'flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    designScope === option.value
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Search Input */}
          <div>
            <Label>Search Parts</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                type="text"
                placeholder="Search by part number or name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {/* Search Results */}
          <div className="border border-slate-300 dark:border-slate-700 rounded-lg max-h-48 overflow-y-auto auto-hide-scroll">
            {searching ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                Searching...
              </div>
            ) : searchQuery.length < 2 ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                Type at least 2 characters to search
              </div>
            ) : searchResults.length === 0 ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                No parts found matching "{searchQuery}"
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-700">
                {searchResults.map((item) => {
                  const isSelected = selectedItem?.id === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedItem(item)}
                      className={cn(
                        'w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors',
                        isSelected && 'bg-cyan-50 dark:bg-cyan-950',
                      )}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <div
                          className={cn(
                            'flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center',
                            isSelected
                              ? 'border-slate-900 dark:border-slate-50'
                              : 'border-slate-300 dark:border-slate-600',
                          )}
                        >
                          {isSelected && (
                            <div className="w-2 h-2 rounded-full bg-slate-900 dark:bg-slate-50" />
                          )}
                        </div>
                        <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                          {item.itemNumber}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          {item.revision}
                        </Badge>
                        <StateBadge
                          itemType={item.itemType}
                          state={item.state}
                          className="text-xs"
                        />
                        {/* External design badge */}
                        {item.isExternal && item.designCode && (
                          <Badge
                            variant="outline"
                            className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600"
                          >
                            <Link2 className="h-3 w-3 mr-1" />
                            {item.designCode}
                          </Badge>
                        )}
                      </div>
                      {item.name && (
                        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 ml-6">
                          {item.name}
                        </p>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* BOM Fields */}
          {selectedItem && (
            <div className="grid grid-cols-2 gap-4 pt-2 border-t">
              <div>
                <Label>Quantity</Label>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="1"
                  className={cn(
                    quantityInvalid &&
                      'border-red-500 focus-visible:ring-red-500 dark:border-red-500',
                  )}
                />
                {quantityInvalid && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    A BOM line needs a decimal quantity, e.g. 4 or 2.5
                  </p>
                )}
              </div>
              <div>
                <Label>Find Number</Label>
                <Input
                  type="number"
                  min="1"
                  value={findNumber}
                  onChange={(e) => setFindNumber(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleAdd}
            disabled={!selectedItem || quantityInvalid || loading}
          >
            {loading ? 'Adding...' : 'Add to BOM'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
