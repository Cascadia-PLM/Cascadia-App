import { useEffect, useState } from 'react'
import { Box, Check } from 'lucide-react'
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

interface Design {
  id: string
  code: string
  name: string
  programId: string
  programName?: string
  designType: 'Engineering' | 'Library'
  phase: string
}

interface AddDesignToEcoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  changeOrderId: string
  changeOrderNumber?: string
  existingDesignIds: Array<string>
  onSuccess: () => void
}

export function AddDesignToEcoDialog({
  open,
  onOpenChange,
  changeOrderId,
  changeOrderNumber,
  existingDesignIds,
  onSuccess,
}: AddDesignToEcoDialogProps) {
  const { alert } = useAlertDialog()
  const [searchQuery, setSearchQuery] = useState('')
  const [allDesigns, setAllDesigns] = useState<Array<Design>>([])
  const [selectedDesigns, setSelectedDesigns] = useState<Array<Design>>([])
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)

  // Fetch all accessible designs
  const fetchDesigns = async () => {
    setFetching(true)
    try {
      const response = await fetch('/api/designs')
      if (response.ok) {
        const data = await response.json()
        // Filter out designs already added to this ECO
        const availableDesigns = (data.data?.designs ?? []).filter(
          (design: Design) => !existingDesignIds.includes(design.id),
        )
        setAllDesigns(availableDesigns)
      }
    } catch {
      // Fetch failed silently
    } finally {
      setFetching(false)
    }
  }

  // Load designs when dialog opens
  useEffect(() => {
    if (open) {
      fetchDesigns()
      setSelectedDesigns([])
      setSearchQuery('')
    }
  }, [open, existingDesignIds.join(',')])

  const toggleDesignSelection = (design: Design) => {
    setSelectedDesigns((prev) => {
      const isSelected = prev.some((d) => d.id === design.id)
      if (isSelected) {
        return prev.filter((d) => d.id !== design.id)
      } else {
        return [...prev, design]
      }
    })
  }

  const handleAdd = async () => {
    if (selectedDesigns.length === 0) return

    setLoading(true)
    try {
      // Add each selected design to the ECO
      const results = await Promise.allSettled(
        selectedDesigns.map((design) =>
          fetch(`/api/change-orders/${changeOrderId}/designs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ designId: design.id }),
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
          description: `Added ${successCount} design(s). ${failedCount} failed to add.`,
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
        description: 'Failed to add designs to ECO',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  // Filter designs based on search query
  const filteredDesigns = searchQuery
    ? allDesigns.filter(
        (design) =>
          design.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
          design.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : allDesigns

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto auto-hide-scroll">
        <DialogHeader>
          <DialogTitle>Add Designs to ECO</DialogTitle>
          <DialogDescription>
            Select designs to associate with this ECO
            {changeOrderNumber ? ` (${changeOrderNumber})` : ''}. ECO branches
            will be created when you check out items from these designs.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search Input */}
          <div>
            <Label>Search Designs</Label>
            <Input
              type="text"
              placeholder="Search by code or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Selected Designs */}
          {selectedDesigns.length > 0 && (
            <div className="p-3 bg-cyan-50 dark:bg-cyan-900/20 rounded-lg">
              <Label className="text-xs text-cyan-700 dark:text-cyan-300">
                Selected ({selectedDesigns.length})
              </Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {selectedDesigns.map((design) => (
                  <Badge
                    key={design.id}
                    variant="default"
                    className="cursor-pointer hover:bg-cyan-600"
                    onClick={() => toggleDesignSelection(design)}
                  >
                    {design.code} &times;
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Design List */}
          <div className="border border-slate-300 dark:border-slate-700 rounded-lg max-h-60 overflow-y-auto auto-hide-scroll">
            {fetching ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                Loading designs...
              </div>
            ) : filteredDesigns.length === 0 ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                {allDesigns.length === 0
                  ? 'No designs available to add. All designs may already be associated with this ECO.'
                  : 'No designs match your search.'}
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-700">
                {filteredDesigns.map((design) => {
                  const isSelected = selectedDesigns.some(
                    (d) => d.id === design.id,
                  )
                  return (
                    <button
                      key={design.id}
                      type="button"
                      onClick={() => toggleDesignSelection(design)}
                      className={`w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors ${
                        isSelected ? 'bg-cyan-50 dark:bg-cyan-950' : ''
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`flex-shrink-0 w-5 h-5 rounded border flex items-center justify-center ${
                            isSelected
                              ? 'bg-cyan-500 border-cyan-500'
                              : 'border-slate-300 dark:border-slate-600'
                          }`}
                        >
                          {isSelected && (
                            <Check className="h-3 w-3 text-white" />
                          )}
                        </div>
                        <Box className="h-4 w-4 text-slate-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                              {design.code}
                            </span>
                            <Badge variant="outline" className="text-xs">
                              {design.designType}
                            </Badge>
                            <Badge
                              variant={
                                design.phase === 'Production'
                                  ? 'default'
                                  : 'secondary'
                              }
                              className="text-xs"
                            >
                              {design.phase}
                            </Badge>
                          </div>
                          <p className="text-sm text-slate-600 dark:text-slate-400 truncate">
                            {design.name}
                          </p>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
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
            disabled={selectedDesigns.length === 0 || loading}
          >
            {loading
              ? 'Adding...'
              : `Add${selectedDesigns.length > 0 ? ` (${selectedDesigns.length})` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
