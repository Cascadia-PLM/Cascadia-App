import { useEffect, useState } from 'react'
import { Package, Search } from 'lucide-react'
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
import { Badge } from '@/components/ui/Badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/RadioGroup'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'

interface DesignOption {
  id: string
  code: string
  name: string
  designType: string
  parentDesignId: string | null
}

interface AddMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  familyDesignId: string
  familyDesignCode: string
  programId: string | null
  existingMemberIds: Array<string>
  onSuccess: () => void
}

export function AddMemberDialog({
  open,
  onOpenChange,
  familyDesignId,
  familyDesignCode,
  programId,
  existingMemberIds,
  onSuccess,
}: AddMemberDialogProps) {
  const { alert } = useAlertDialog()
  const [searchQuery, setSearchQuery] = useState('')
  const [availableDesigns, setAvailableDesigns] = useState<Array<DesignOption>>(
    [],
  )
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)

  // Fetch available designs (same program, no parent, not already a member)
  useEffect(() => {
    const fetchDesigns = async () => {
      if (!open) return

      setSearching(true)
      try {
        const params = programId ? `?programId=${programId}` : ''
        const response = await fetch(`/api/designs${params}`)
        if (response.ok) {
          const { data } = await response.json()
          // Filter to designs that can be added:
          // - Same program
          // - Type 'design' (not family or library)
          // - No existing parent (standalone)
          // - Not already a member
          // - Not the family itself
          const eligible = (data?.designs || []).filter(
            (d: DesignOption) =>
              d.designType === 'Engineering' &&
              d.parentDesignId === null &&
              !existingMemberIds.includes(d.id) &&
              d.id !== familyDesignId,
          )
          setAvailableDesigns(eligible)
        }
      } catch {
        setAvailableDesigns([])
      } finally {
        setSearching(false)
      }
    }

    fetchDesigns()
  }, [open, programId, existingMemberIds, familyDesignId])

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      setSelectedDesignId(null)
    }
  }, [open])

  // Filter designs based on search query
  const filteredDesigns = availableDesigns.filter(
    (d) =>
      d.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      d.name.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const handleAdd = async () => {
    if (!selectedDesignId) return

    setLoading(true)
    try {
      await apiFetch(`/api/designs/${familyDesignId}/members`, {
        method: 'POST',
        body: JSON.stringify({ designId: selectedDesignId }),
      })

      onSuccess()
      onOpenChange(false)
    } catch (error) {
      alert({
        title: 'Error',
        description: `Failed to add design to family: ${(error as Error).message}`,
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto auto-hide-scroll">
        <DialogHeader>
          <DialogTitle>Add Member to Family</DialogTitle>
          <DialogDescription>
            Select a standalone design to add to the{' '}
            <span className="font-medium">{familyDesignCode}</span> family
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              type="text"
              placeholder="Search designs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Design List */}
          <div className="border border-slate-300 dark:border-slate-700 rounded-lg max-h-64 overflow-y-auto auto-hide-scroll">
            {searching ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                Loading designs...
              </div>
            ) : filteredDesigns.length === 0 ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                {searchQuery
                  ? `No designs matching "${searchQuery}"`
                  : 'No eligible designs found. Designs must be standalone (no parent) and in the same program.'}
              </div>
            ) : (
              <RadioGroup
                value={selectedDesignId || ''}
                onValueChange={setSelectedDesignId}
                className="divide-y divide-slate-200 dark:divide-slate-700"
              >
                {filteredDesigns.map((design) => {
                  const isSelected = selectedDesignId === design.id
                  return (
                    <label
                      key={design.id}
                      className={cn(
                        'flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors',
                        isSelected && 'bg-cyan-50 dark:bg-cyan-950',
                      )}
                    >
                      <RadioGroupItem value={design.id} className="mt-0.5" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-cyan-500" />
                          <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                            {design.code}
                          </span>
                          <Badge variant="secondary" className="text-xs">
                            {design.designType}
                          </Badge>
                        </div>
                        {design.name && (
                          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                            {design.name}
                          </p>
                        )}
                      </div>
                    </label>
                  )
                })}
              </RadioGroup>
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
            disabled={!selectedDesignId || loading}
          >
            {loading ? 'Adding...' : 'Add to Family'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
