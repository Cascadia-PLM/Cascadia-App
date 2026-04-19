import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CheckCircle, Loader2, Plus, Search, X } from 'lucide-react'
import type { AffectedItem } from '@/lib/items/types/change-order'
import type { BaseItem } from '@/lib/items/types/base'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface AffectedItemsManagerProps {
  changeOrderId: string
  readOnly?: boolean
}

const actionColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  release: 'success',
  revise: 'default',
  obsolete: 'destructive',
  add: 'success',
  remove: 'destructive',
  promote: 'warning',
}

const actionLabels: Record<string, string> = {
  release: 'Release (Draft → Released)',
  revise: 'Revise (Create new revision)',
  obsolete: 'Obsolete',
  add: 'Add New Item',
  remove: 'Remove from BOMs',
}

export function AffectedItemsManager({
  changeOrderId,
  readOnly = false,
}: AffectedItemsManagerProps) {
  const { alert } = useAlertDialog()

  // Affected items state - fetched from API
  const [affectedItems, setAffectedItems] = useState<
    Array<AffectedItem & { affectedItemDetails?: BaseItem }>
  >([])
  const [isLoading, setIsLoading] = useState(true)

  const [changeAction, setChangeAction] = useState<string>('release')
  const [targetRevision, setTargetRevision] = useState('')
  const [replacementItemNumber, setReplacementItemNumber] = useState('')
  const [changeDescription, setChangeDescription] = useState('')

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<BaseItem>>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [selectedItem, setSelectedItem] = useState<BaseItem | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  // Search for items with debouncing
  const performSearch = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([])
      return
    }

    setIsSearching(true)
    try {
      const response = await fetch(
        `/api/items/search?q=${encodeURIComponent(query)}&types=Part,Document,Requirement`,
      )
      if (response.ok) {
        const { data } = await response.json()
        setSearchResults(data?.items || [])
        setShowDropdown(true)
      }
    } catch {
      // Search error handled silently
    } finally {
      setIsSearching(false)
    }
  }, [])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    if (searchQuery.length >= 2 && !selectedItem) {
      debounceRef.current = setTimeout(() => {
        performSearch(searchQuery)
      }, 300)
    } else {
      setSearchResults([])
      setShowDropdown(false)
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [searchQuery, selectedItem, performSearch])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Fetch affected items from API
  const fetchAffectedItems = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/change-orders/${changeOrderId}/affected-items`,
      )
      if (response.ok) {
        const { data } = await response.json()
        setAffectedItems(data?.affectedItems || [])
      }
    } catch {
      // Error fetching affected items handled silently
    } finally {
      setIsLoading(false)
    }
  }, [changeOrderId])

  useEffect(() => {
    fetchAffectedItems()
  }, [fetchAffectedItems])

  const handleSelectItem = (item: BaseItem) => {
    setSelectedItem(item)
    setSearchQuery(item.itemNumber ?? '')
    setShowDropdown(false)
  }

  const handleClearSelection = () => {
    setSelectedItem(null)
    setSearchQuery('')
    setSearchResults([])
  }

  const handleAdd = async () => {
    if (!selectedItem) {
      alert({
        title: 'Validation',
        description: 'Please search for and select an item',
        variant: 'default',
      })
      return
    }

    const newItem: Partial<AffectedItem> = {
      changeOrderId,
      affectedItemId: selectedItem.id,
      affectedItemMasterId: selectedItem.masterId,
      changeAction: changeAction as any,
      currentState: selectedItem.state,
      currentRevision: selectedItem.revision,
      changeDescription: changeDescription || null,
    }

    // Add revision info if action is revise
    if (changeAction === 'revise') {
      if (!targetRevision.trim()) {
        alert({
          title: 'Validation',
          description: 'Please specify target revision',
          variant: 'default',
        })
        return
      }
      newItem.targetRevision = targetRevision
      newItem.targetState = 'Released' // Assume releasing the new revision
    }

    // Set target state for release action
    if (changeAction === 'release') {
      newItem.targetState = 'Released'
      newItem.targetRevision = selectedItem.revision
    }

    // Set target state for obsolete
    if (changeAction === 'obsolete') {
      newItem.targetState = 'Obsolete'
      newItem.targetRevision = selectedItem.revision
    }

    try {
      const response = await fetch(
        `/api/change-orders/${changeOrderId}/affected-items`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newItem),
        },
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.details || 'Failed to add affected item')
      }

      // Refresh the list
      await fetchAffectedItems()

      // Reset form
      handleClearSelection()
      setTargetRevision('')
      setReplacementItemNumber('')
      setChangeDescription('')
    } catch (error) {
      alert({
        title: 'Error',
        description: `Failed to add affected item: ${(error as Error).message}`,
        variant: 'destructive',
      })
    }
  }

  const handleRemove = async (itemId: string) => {
    try {
      const response = await fetch(
        `/api/change-orders/${changeOrderId}/affected-items?itemId=${itemId}`,
        {
          method: 'DELETE',
        },
      )

      if (!response.ok) {
        throw new Error('Failed to remove affected item')
      }

      // Refresh the list
      await fetchAffectedItems()
    } catch (error) {
      alert({
        title: 'Error',
        description: `Failed to remove affected item: ${(error as Error).message}`,
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Affected Items</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add Item Form */}
        {!readOnly && (
          <div className="space-y-3 p-4 border rounded-lg bg-slate-50 dark:bg-slate-900">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Item Number Search with Autocomplete */}
              <div className="relative">
                <label className="text-sm font-medium mb-1 block">
                  Item Number
                </label>
                <div className="relative">
                  <Input
                    ref={searchInputRef}
                    placeholder="Search for item (e.g., P-1001)"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value)
                      if (selectedItem) {
                        setSelectedItem(null)
                      }
                    }}
                    onFocus={() => {
                      if (searchResults.length > 0 && !selectedItem) {
                        setShowDropdown(true)
                      }
                    }}
                    className={`pr-10 ${selectedItem ? 'border-green-500' : ''}`}
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    {isSearching ? (
                      <Loader2 className="h-4 w-4 text-slate-400 animate-spin" />
                    ) : selectedItem ? (
                      <button
                        type="button"
                        onClick={handleClearSelection}
                        className="text-slate-400 hover:text-slate-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    ) : (
                      <Search className="h-4 w-4 text-slate-400" />
                    )}
                  </div>
                </div>

                {/* Selected item indicator */}
                {selectedItem && (
                  <div className="mt-1 flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                    <Check className="h-3 w-3" />
                    <span>
                      {selectedItem.itemNumber} -{' '}
                      {selectedItem.name || 'Untitled'}
                      <span className="text-slate-500 ml-1">
                        ({selectedItem.itemType}, {selectedItem.state}{' '}
                        {selectedItem.revision})
                      </span>
                    </span>
                  </div>
                )}

                {/* Search Results Dropdown */}
                {showDropdown && searchResults.length > 0 && !selectedItem && (
                  <div
                    ref={dropdownRef}
                    className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md shadow-lg max-h-60 overflow-y-auto"
                  >
                    {searchResults.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectItem(item)}
                        className="w-full px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-700 last:border-0"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">
                            {item.itemNumber}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {item.name || 'Untitled'}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="secondary" className="text-xs">
                            {item.itemType}
                          </Badge>
                          <Badge
                            variant={
                              item.state === 'Released' ? 'success' : 'default'
                            }
                            className="text-xs"
                          >
                            {item.state} {item.revision}
                          </Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* No results message */}
                {showDropdown &&
                  searchQuery.length >= 2 &&
                  searchResults.length === 0 &&
                  !isSearching &&
                  !selectedItem && (
                    <div className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md shadow-lg p-3 text-sm text-slate-500 dark:text-slate-400 text-center">
                      No items found matching "{searchQuery}"
                    </div>
                  )}
              </div>

              {/* Change Action */}
              <div>
                <label className="text-sm font-medium mb-1 block">Action</label>
                <Select value={changeAction} onValueChange={setChangeAction}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select action" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(actionLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Conditional fields based on action */}
              {changeAction === 'revise' && (
                <div>
                  <label className="text-sm font-medium mb-1 block">
                    New Revision
                  </label>
                  <Input
                    placeholder="e.g., B"
                    value={targetRevision}
                    onChange={(e) => setTargetRevision(e.target.value)}
                  />
                </div>
              )}

              {changeAction === 'obsolete' && (
                <div>
                  <label className="text-sm font-medium mb-1 block">
                    Replacement Item (Optional)
                  </label>
                  <Input
                    placeholder="Search for replacement item"
                    value={replacementItemNumber}
                    onChange={(e) => setReplacementItemNumber(e.target.value)}
                  />
                </div>
              )}

              {/* Change Description */}
              <div className="md:col-span-2">
                <label className="text-sm font-medium mb-1 block">
                  Description of Change
                </label>
                <Input
                  placeholder="Briefly describe what's changing..."
                  value={changeDescription}
                  onChange={(e) => setChangeDescription(e.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={handleAdd} size="sm" disabled={!selectedItem}>
                <Plus className="h-4 w-4 mr-2" />
                Add Item
              </Button>
            </div>
          </div>
        )}

        {/* Affected Items Table */}
        {isLoading ? (
          <div className="text-center py-8 border rounded-lg">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-slate-400" />
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">
              Loading affected items...
            </p>
          </div>
        ) : affectedItems.length === 0 ? (
          <div className="text-center py-8 border rounded-lg">
            <p className="text-slate-500 dark:text-slate-400">
              No items added yet
            </p>
            <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
              Add items that will be affected by this change order
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item Number</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Status</TableHead>
                {!readOnly && (
                  <TableHead className="text-right">Actions</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {affectedItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">
                    {item.affectedItemDetails?.itemNumber || '(New)'}
                  </TableCell>
                  <TableCell className="text-slate-600 dark:text-slate-400">
                    {item.affectedItemDetails?.name || '-'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {item.affectedItemDetails?.itemType || '-'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={actionColors[item.changeAction]}>
                      {item.changeAction}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {item.currentState && item.currentRevision
                      ? `${item.currentState} ${item.currentRevision}`
                      : '-'}
                  </TableCell>
                  <TableCell>
                    {item.targetState && item.targetRevision
                      ? `${item.targetState} ${item.targetRevision}`
                      : item.targetRevision || item.targetState || '-'}
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {item.changeDescription || '-'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="success">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      OK
                    </Badge>
                  </TableCell>
                  {!readOnly && (
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => item.id && handleRemove(item.id)}
                        title="Remove item"
                      >
                        <X className="h-4 w-4 text-red-600" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
