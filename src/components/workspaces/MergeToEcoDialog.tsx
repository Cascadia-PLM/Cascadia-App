import { useEffect, useState } from 'react'
import { GitMerge, Loader2 } from 'lucide-react'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from '@/components/ui'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

interface ECO {
  id: string
  itemNumber: string
  name: string
  state: string
  changeType: string
}

interface MergeToEcoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  workspaceName: string
  designId: string
  itemCount: number
  onSuccess?: (ecoId: string) => void
}

export function MergeToEcoDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  designId,
  itemCount,
  onSuccess,
}: MergeToEcoDialogProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const [ecos, setEcos] = useState<Array<ECO>>([])
  const [selectedEcoId, setSelectedEcoId] = useState<string>('')
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  const [loading, setLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Fetch available ECOs for this design
  useEffect(() => {
    if (!open || !designId) return

    async function fetchEcos() {
      setLoading(true)
      try {
        // Fetch ECOs that can still accept items (scope not locked)
        const response = await apiFetch<{
          data: { changeOrders: Array<ECO> }
        }>(`/api/v1/change-orders/editable?designId=${designId}`)
        setEcos(response.data.changeOrders)
      } catch {
        setEcos([])
      } finally {
        setLoading(false)
      }
    }

    fetchEcos()
  }, [open, designId])

  const handleMerge = async () => {
    if (!selectedEcoId) {
      handleError(new Error('Please select an ECO'), {
        title: 'Validation Error',
      })
      return
    }

    setIsSubmitting(true)
    try {
      const response = await apiFetch<{
        data: {
          ecoId: string
          itemsAdded: number
          itemsSkipped: number
          workspaceDeleted: boolean
        }
      }>(`/api/v1/workspaces/${workspaceId}/merge-to-eco`, {
        method: 'POST',
        body: JSON.stringify({
          ecoId: selectedEcoId,
          deleteWorkspace,
        }),
      })

      const eco = ecos.find((e) => e.id === selectedEcoId)
      showSuccess(
        'Workspace merged to ECO',
        `Added ${response.data.itemsAdded} item${response.data.itemsAdded !== 1 ? 's' : ''} to ${eco?.itemNumber || 'ECO'}${response.data.itemsSkipped > 0 ? ` (${response.data.itemsSkipped} already present)` : ''}`,
      )

      onOpenChange(false)
      setSelectedEcoId('')
      setDeleteWorkspace(false)
      onSuccess?.(response.data.ecoId)
    } catch (error) {
      handleError(error, { title: 'Failed to merge workspace to ECO' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const selectedEco = ecos.find((e) => e.id === selectedEcoId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5" />
            Merge to Existing ECO
          </DialogTitle>
          <DialogDescription>
            Merge {itemCount} item{itemCount !== 1 ? 's' : ''} from workspace{' '}
            <strong>{workspaceName}</strong> into an existing ECO.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              <span className="ml-2 text-slate-500">Loading ECOs...</span>
            </div>
          ) : ecos.length === 0 ? (
            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                No editable ECOs found for this design. ECOs cannot accept items
                once their scope is locked.
              </p>
              <p className="text-sm text-amber-800 dark:text-amber-200 mt-2">
                Consider converting this workspace to a new ECO instead.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="eco-select">Select ECO *</Label>
                <Select value={selectedEcoId} onValueChange={setSelectedEcoId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose an ECO">
                      {selectedEco
                        ? `${selectedEco.itemNumber} - ${selectedEco.name}`
                        : 'Select ECO'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Available ECOs</SelectLabel>
                      {ecos.map((eco) => (
                        <SelectItem key={eco.id} value={eco.id}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {eco.itemNumber}
                            </span>
                            <span className="text-slate-600 dark:text-slate-400">
                              {eco.name}
                            </span>
                            <Badge
                              variant="secondary"
                              className="ml-auto text-xs"
                            >
                              {eco.state}
                            </Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              {selectedEco && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <div className="text-sm">
                    <div className="font-medium text-blue-900 dark:text-blue-100 mb-1">
                      {selectedEco.itemNumber}
                    </div>
                    <div className="text-blue-700 dark:text-blue-300">
                      {selectedEco.name}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary">
                        {selectedEco.changeType}
                      </Badge>
                      <Badge variant="secondary">{selectedEco.state}</Badge>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center space-x-2 pt-2">
                <Checkbox
                  id="delete-workspace-merge"
                  checked={deleteWorkspace}
                  onCheckedChange={(checked) =>
                    setDeleteWorkspace(checked === true)
                  }
                  disabled={isSubmitting}
                />
                <label
                  htmlFor="delete-workspace-merge"
                  className="text-sm font-medium leading-none text-slate-900 dark:text-slate-100 peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Delete workspace after merge
                </label>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleMerge}
            disabled={
              !selectedEcoId || isSubmitting || loading || ecos.length === 0
            }
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <GitMerge className="h-4 w-4 mr-2" />
                Merge to ECO
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
