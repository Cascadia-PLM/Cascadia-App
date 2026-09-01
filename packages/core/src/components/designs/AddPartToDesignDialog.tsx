// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
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
import { Checkbox } from '@/components/ui/Checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import {
  designBranchesQuery,
  designListQuery,
  itemSearchQuery,
  itemTextSearchQuery,
  programListQuery,
  useResourceMutation,
} from '@/lib/query'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import { StateBadge } from '@/components/items/StateBadge'

interface Item {
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

interface DesignOption {
  id: string
  name: string
  code: string
}

interface BranchOption {
  id: string
  name: string
}

interface AddPartToDesignDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  designId: string
  designCode: string
  designName: string
  onSuccess?: () => void
}

export function AddPartToDesignDialog({
  open,
  onOpenChange,
  designId,
  designCode,
  designName,
  onSuccess,
}: AddPartToDesignDialogProps) {
  const { alert } = useAlertDialog()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedItems, setSelectedItems] = useState<Array<Item>>([])

  // Add mode: usage_copy (default) or cross_design_ref
  const [addMode, setAddMode] = useState<'usage_copy' | 'cross_design_ref'>(
    'usage_copy',
  )

  // Suffix checkbox state
  const [suffixItemNumbers, setSuffixItemNumbers] = useState(false)

  // Breadcrumb state
  const [selectedProgramId, setSelectedProgramId] = useState('')
  const [selectedDesignId, setSelectedDesignId] = useState('')
  const [selectedBranchId, setSelectedBranchId] = useState('')

  // The three breadcrumb lists, each enabled by the one above it.
  const { data: programs = [] } = useQuery({
    ...programListQuery(),
    enabled: open,
  })
  const { data: designs = [] } = useQuery({
    ...designListQuery<DesignOption>(selectedProgramId || undefined),
    enabled: open && Boolean(selectedProgramId),
  })
  const { data: branches = [] } = useQuery(
    designBranchesQuery<BranchOption>(
      selectedDesignId,
      true,
      open && Boolean(selectedDesignId),
    ),
  )

  // Which designs the search is confined to, following the breadcrumb: a
  // chosen design narrows to itself, a chosen program to everything under it.
  const scope = selectedDesignId
    ? { designScope: 'current' as const, contextDesignId: selectedDesignId }
    : selectedProgramId && designs.length > 0
      ? { designIds: designs.map((d) => d.id).join(',') }
      : {}

  // An empty box lists parts by type; typing switches to the ranked text
  // search. The endpoint serves one or the other, so exactly one is enabled.
  const debouncedQuery = useDebouncedValue(searchQuery.trim())
  const { data: partsByType = [], isFetching: listing } = useQuery(
    itemSearchQuery<Item>(
      { itemType: 'Part', limit: 50, ...scope },
      !debouncedQuery,
    ),
  )
  const { data: partsByText = [], isFetching: textSearching } = useQuery(
    itemTextSearchQuery<Item>(
      { q: debouncedQuery, types: ['Part'], limit: 50, ...scope },
      Boolean(debouncedQuery),
    ),
  )
  const searching = debouncedQuery ? textSearching : listing

  // A part already in this design is not a candidate for adding to it.
  const searchResults = (debouncedQuery ? partsByText : partsByType).filter(
    (item) => item.designId !== designId,
  )

  // Start every visit from a clean form.
  useEffect(() => {
    if (open) {
      setSelectedItems([])
      setSearchQuery('')
      setAddMode('usage_copy')
      setSuffixItemNumbers(false)
      setSelectedProgramId('')
      setSelectedDesignId('')
      setSelectedBranchId('')
    }
  }, [open])

  // A narrower breadcrumb level cannot outlive the choice above it.
  useEffect(() => {
    setSelectedDesignId('')
    setSelectedBranchId('')
  }, [selectedProgramId])

  useEffect(() => {
    setSelectedBranchId('')
  }, [selectedDesignId])

  const toggleItemSelection = (item: Item) => {
    setSelectedItems((prev) => {
      const isSelected = prev.some((i) => i.id === item.id)
      if (isSelected) {
        return prev.filter((i) => i.id !== item.id)
      } else {
        return [...prev, item]
      }
    })
  }

  // A fan-out of one POST per selected part, with partial-success reporting.
  // Resolves (rather than rejects) on a partial failure so the successful
  // writes still get invalidated; only a total failure rejects, since there
  // is then nothing new in the cache to refresh.
  const addParts = useResourceMutation({
    mutationFn: async (items: Array<Item>) => {
      const results = await Promise.allSettled(
        items.map((item) =>
          apiFetch(`/api/v1/designs/${designId}/items`, {
            method: 'POST',
            body: JSON.stringify({
              itemId: item.id,
              mode: addMode,
              suffixItemNumber:
                addMode === 'usage_copy'
                  ? suffixItemNumbers || undefined
                  : undefined,
            }),
          }),
        ),
      )

      const successCount = results.filter(
        (r) => r.status === 'fulfilled',
      ).length
      const failedCount = results.filter((r) => r.status === 'rejected').length

      if (successCount === 0) {
        throw new Error('Failed to add parts to design')
      }

      return { successCount, failedCount }
    },
    invalidates: ['designs'],
    onSuccess: ({ successCount, failedCount }) => {
      if (failedCount > 0) {
        alert({
          title: 'Partial Success',
          description: `Added ${successCount} part(s). ${failedCount} failed to add.`,
          variant: 'default',
        })
      }
      onSuccess?.()
      onOpenChange(false)
    },
    onError: () => {
      alert({
        title: 'Error',
        description: 'Failed to add parts to design',
        variant: 'destructive',
      })
    },
  })

  const handleAdd = () => {
    if (selectedItems.length === 0) return
    addParts.mutate(selectedItems)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto auto-hide-scroll">
        <DialogHeader>
          <DialogTitle>Add Parts to Design</DialogTitle>
          <DialogDescription>
            {addMode === 'usage_copy'
              ? `Selected parts will be copied as usages in ${designName}.`
              : `Selected parts will be linked as read-only references in ${designName}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Mode Toggle */}
          <div className="flex rounded-lg border border-slate-300 dark:border-slate-600 overflow-hidden">
            <button
              type="button"
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                addMode === 'usage_copy'
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
              }`}
              onClick={() => setAddMode('usage_copy')}
            >
              Usage Copy
            </button>
            <button
              type="button"
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors border-l border-slate-300 dark:border-slate-600 ${
                addMode === 'cross_design_ref'
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
              }`}
              onClick={() => setAddMode('cross_design_ref')}
            >
              Cross-Design Reference
            </button>
          </div>

          {/* Breadcrumb Filters */}
          <div className="flex items-center gap-1.5">
            <Select
              value={selectedProgramId || '__all__'}
              onValueChange={(v) =>
                setSelectedProgramId(v === '__all__' ? '' : v)
              }
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="All Programs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Programs</SelectItem>
                {programs.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <ChevronRight className="h-4 w-4 text-slate-400 flex-shrink-0" />

            <Select
              value={selectedDesignId || '__all__'}
              onValueChange={(v) =>
                setSelectedDesignId(v === '__all__' ? '' : v)
              }
              disabled={!selectedProgramId}
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="All Designs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Designs</SelectItem>
                {designs.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.code} — {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <ChevronRight className="h-4 w-4 text-slate-400 flex-shrink-0" />

            <Select
              value={selectedBranchId || '__all__'}
              onValueChange={(v) =>
                setSelectedBranchId(v === '__all__' ? '' : v)
              }
              disabled={!selectedDesignId}
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="All Branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Search Input */}
          <div>
            <Label>Search Parts</Label>
            <Input
              type="text"
              placeholder="Search by part number or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Selected Items */}
          {selectedItems.length > 0 && (
            <div className="p-3 bg-cyan-50 dark:bg-cyan-900/20 rounded-lg">
              <Label className="text-xs text-cyan-700 dark:text-cyan-300">
                Selected ({selectedItems.length})
              </Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {selectedItems.map((item) => (
                  <Badge
                    key={item.id}
                    variant="default"
                    className="cursor-pointer hover:bg-cyan-600"
                    onClick={() => toggleItemSelection(item)}
                  >
                    {item.itemNumber} &times;
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Search Results */}
          <div className="border border-slate-300 dark:border-slate-700 rounded-lg max-h-60 overflow-y-auto auto-hide-scroll">
            {searching ? (
              <div className="p-4 text-center text-sm text-slate-500">
                Searching...
              </div>
            ) : searchResults.length === 0 ? (
              <div className="p-4 text-center text-sm text-slate-500">
                No parts found. Try a different search term.
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-700">
                {searchResults.map((item) => {
                  const isSelected = selectedItems.some((i) => i.id === item.id)
                  return (
                    <label
                      key={item.id}
                      className={`flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors ${
                        isSelected ? 'bg-cyan-50 dark:bg-cyan-950' : ''
                      }`}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleItemSelection(item)}
                        className="mt-0.5"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
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
                          {item.designCode && (
                            <Badge
                              variant="outline"
                              className="text-xs text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600"
                            >
                              {item.designCode}
                            </Badge>
                          )}
                          {item.designId &&
                            item.designId !== designId &&
                            !item.designCode && (
                              <Badge
                                variant="outline"
                                className="text-xs text-amber-600 dark:text-amber-400"
                              >
                                Assigned elsewhere
                              </Badge>
                            )}
                        </div>
                        {item.name && (
                          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                            {item.name}
                          </p>
                        )}
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* Suffix Item Numbers Checkbox (only for usage copy mode) */}
          {addMode === 'usage_copy' && (
            <>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="suffixItemNumbers"
                  checked={suffixItemNumbers}
                  onCheckedChange={(checked) =>
                    setSuffixItemNumbers(checked as boolean)
                  }
                />
                <Label
                  htmlFor="suffixItemNumbers"
                  className="text-sm font-normal cursor-pointer"
                >
                  Suffix item numbers with design code
                </Label>
              </div>
              {suffixItemNumbers && designCode && (
                <p className="text-xs text-slate-500 dark:text-slate-400 ml-6">
                  e.g., PN-000001-{designCode}
                </p>
              )}
            </>
          )}

          {/* Cross-design reference info */}
          {addMode === 'cross_design_ref' && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Referenced parts appear read-only in the BOM tree. You can later
              &ldquo;pull in&rdquo; a reference to convert it to a full usage
              copy.
            </p>
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
            disabled={selectedItems.length === 0 || addParts.isPending}
          >
            {addParts.isPending
              ? 'Adding...'
              : `Add ${selectedItems.length > 0 ? `(${selectedItems.length})` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
