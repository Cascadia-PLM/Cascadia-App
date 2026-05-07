import { useEffect, useRef, useState } from 'react'
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

interface ProgramOption {
  id: string
  name: string
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
  onSuccess: () => void
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
  const [searchResults, setSearchResults] = useState<Array<Item>>([])
  const [selectedItems, setSelectedItems] = useState<Array<Item>>([])
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Add mode: usage_copy (default) or cross_design_ref
  const [addMode, setAddMode] = useState<'usage_copy' | 'cross_design_ref'>(
    'usage_copy',
  )

  // Suffix checkbox state
  const [suffixItemNumbers, setSuffixItemNumbers] = useState(false)

  // Breadcrumb state
  const [programs, setPrograms] = useState<Array<ProgramOption>>([])
  const [designs, setDesigns] = useState<Array<DesignOption>>([])
  const [branches, setBranches] = useState<Array<BranchOption>>([])
  const [selectedProgramId, setSelectedProgramId] = useState('')
  const [selectedDesignId, setSelectedDesignId] = useState('')
  const [selectedBranchId, setSelectedBranchId] = useState('')

  // Search for parts via API
  const fetchParts = async (query: string) => {
    setSearching(true)
    try {
      const params = new URLSearchParams({ itemType: 'Part', limit: '50' })
      if (query.trim()) {
        params.set('q', query.trim())
        params.set('types', 'Part')
      }

      // Apply breadcrumb filters
      if (selectedDesignId) {
        params.set('designScope', 'current')
        params.set('contextDesignId', selectedDesignId)
      } else if (selectedProgramId && designs.length > 0) {
        // Program selected but no specific design — filter by all designs in the program
        const programDesignIds = designs.map((d) => d.id).join(',')
        params.set('designIds', programDesignIds)
      }

      const response = await fetch(`/api/v1/items/search?${params}`)
      if (response.ok) {
        const data = await response.json()
        // Filter out parts already in this design
        const availableParts = (data.data?.items ?? []).filter(
          (item: Item) => item.designId !== designId,
        )
        setSearchResults(availableParts)
      }
    } catch {
      // Silently fail - search results will remain empty
    } finally {
      setSearching(false)
    }
  }

  // Fetch programs when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedItems([])
      setSearchQuery('')
      setAddMode('usage_copy')
      setSuffixItemNumbers(false)
      setSelectedProgramId('')
      setSelectedDesignId('')
      setSelectedBranchId('')
      setDesigns([])
      setBranches([])

      // Fetch programs
      fetch('/api/v1/programs')
        .then((r) => r.json())
        .then((data) => setPrograms(data.data?.programs ?? data.data ?? []))
        .catch(() => setPrograms([]))

      fetchParts('')
    }
  }, [open])

  // Fetch designs when program changes
  useEffect(() => {
    if (!open) return
    setSelectedDesignId('')
    setSelectedBranchId('')
    setBranches([])

    if (selectedProgramId) {
      fetch(`/api/v1/designs?programId=${selectedProgramId}`)
        .then((r) => r.json())
        .then((data) => setDesigns(data.data?.designs ?? data.data ?? []))
        .catch(() => setDesigns([]))
    } else {
      setDesigns([])
    }
  }, [selectedProgramId, open])

  // Fetch branches when design changes
  useEffect(() => {
    if (!open) return
    setSelectedBranchId('')

    if (selectedDesignId) {
      fetch(`/api/v1/designs/${selectedDesignId}/branches`)
        .then((r) => r.json())
        .then((data) => setBranches(data.data?.branches ?? data.data ?? []))
        .catch(() => setBranches([]))
    } else {
      setBranches([])
    }
  }, [selectedDesignId, open])

  // Re-trigger search when breadcrumb selection changes
  useEffect(() => {
    if (!open) return
    fetchParts(searchQuery)
  }, [selectedProgramId, selectedDesignId])

  // Debounced search when query changes
  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchParts(searchQuery)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchQuery])

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

  const handleAdd = async () => {
    if (selectedItems.length === 0) return

    setLoading(true)
    try {
      // Add each selected part to the design
      const results = await Promise.allSettled(
        selectedItems.map((item) =>
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

      if (failedCount > 0) {
        alert({
          title: 'Partial Success',
          description: `Added ${successCount} part(s). ${failedCount} failed to add.`,
          variant: 'default',
        })
      }

      if (successCount > 0) {
        onSuccess()
        onOpenChange(false)
      }
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to add parts to design',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
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
                          <Badge
                            variant={
                              item.state === 'Released'
                                ? 'default'
                                : 'secondary'
                            }
                            className="text-xs"
                          >
                            {item.state}
                          </Badge>
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
                                className="text-xs text-amber-600"
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
            disabled={selectedItems.length === 0 || loading}
          >
            {loading
              ? 'Adding...'
              : `Add ${selectedItems.length > 0 ? `(${selectedItems.length})` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
