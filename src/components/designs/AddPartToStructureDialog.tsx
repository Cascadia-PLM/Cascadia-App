import { useEffect, useState } from 'react'
import { ExternalLink, Info, Search } from 'lucide-react'
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
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'

type DesignScope = 'current' | 'all' | 'library'

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

interface AddPartToStructureDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentItemId: string
  parentItemNumber: string
  currentDesignId: string
  currentDesignCode: string
  onSuccess: () => void
}

export function AddPartToStructureDialog({
  open,
  onOpenChange,
  parentItemId,
  parentItemNumber,
  currentDesignId,
  currentDesignCode,
  onSuccess,
}: AddPartToStructureDialogProps) {
  const { alert } = useAlertDialog()
  const [designScope, setDesignScope] = useState<DesignScope>('current')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<EnrichedItem>>([])
  const [selectedItem, setSelectedItem] = useState<EnrichedItem | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [findNumber, setFindNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)

  // Search for parts based on scope and query
  const handleSearch = async () => {
    if (searchQuery.length < 2) {
      setSearchResults([])
      return
    }

    setSearching(true)
    try {
      const params = new URLSearchParams({
        q: searchQuery,
        types: 'Part',
        limit: '50',
        designScope,
        contextDesignId: currentDesignId,
      })

      const response = await fetch(`/api/items/search?${params}`)
      if (response.ok) {
        const data = await response.json()
        // Filter out the parent item itself
        const items = (data.data?.items ?? []).filter(
          (item: EnrichedItem) => item.id !== parentItemId,
        )
        setSearchResults(items)
      }
    } catch {
      // Silently fail - search results will remain empty
    } finally {
      setSearching(false)
    }
  }

  // Search when query or scope changes
  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (searchQuery.length >= 2) {
        handleSearch()
      } else {
        setSearchResults([])
      }
    }, 300)

    return () => clearTimeout(debounceTimer)
  }, [searchQuery, designScope])

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setDesignScope('current')
      setSearchQuery('')
      setSearchResults([])
      setSelectedItem(null)
      setQuantity('1')
      setFindNumber('')
    }
  }, [open])

  const handleAdd = async () => {
    if (!selectedItem) return

    setLoading(true)
    try {
      await apiFetch(`/api/items/${parentItemId}/relationships`, {
        method: 'POST',
        body: JSON.stringify({
          targetId: selectedItem.id,
          relationshipType: 'BOM',
          quantity: quantity || '1',
          findNumber: findNumber ? parseInt(findNumber) : undefined,
        }),
      })

      onSuccess()
      onOpenChange(false)
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to add part to structure',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const scopeOptions: Array<{ value: DesignScope; label: string }> = [
    { value: 'current', label: 'This Design' },
    { value: 'all', label: 'All Designs' },
    { value: 'library', label: 'Standard Library' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto auto-hide-scroll">
        <DialogHeader>
          <DialogTitle>Add Part to BOM</DialogTitle>
          <DialogDescription>
            Add a child part to{' '}
            <span className="font-medium">{parentItemNumber}</span> in{' '}
            <span className="font-medium">{currentDesignCode}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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
                        <Badge
                          variant={
                            item.state === 'Released' ? 'default' : 'secondary'
                          }
                          className="text-xs"
                        >
                          {item.state}
                        </Badge>
                        {/* External design badge */}
                        {item.isExternal && item.designCode && (
                          <Badge
                            variant="outline"
                            className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600"
                          >
                            <ExternalLink className="h-3 w-3 mr-1" />
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

          {/* External Part Info Banner */}
          {selectedItem?.isExternal && (
            <div className="flex gap-3 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-blue-900 dark:text-blue-100">
                  Cross-Design Reference
                </p>
                <p className="text-blue-700 dark:text-blue-300 mt-0.5">
                  This part belongs to{' '}
                  <strong>{selectedItem.designName}</strong> (
                  {selectedItem.designCode}). It will appear in your BOM
                  structure, but changes to it require an ECO in its home
                  design.
                </p>
              </div>
            </div>
          )}

          {/* BOM Fields */}
          {selectedItem && (
            <div className="grid grid-cols-2 gap-4 pt-2 border-t">
              <div>
                <Label>Quantity</Label>
                <Input
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="1"
                />
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
            disabled={!selectedItem || loading}
          >
            {loading ? 'Adding...' : 'Add to BOM'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
