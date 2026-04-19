import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react'
import {
  getDefaultChangeAction,
  getTargetInfo,
  incrementRevision,
} from './eco-helpers'
import type { BOMTreeNode } from './EcoTreeTable'
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
  Textarea,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface AncestorNode {
  itemId: string
  itemNumber: string
  revision: string
  name: string
  itemType: string
  state: string
  designId: string | null
  depth: number
}

interface ParentPropagationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  changeOrderId: string
  designId: string
  targetItem: BOMTreeNode
  onSuccess: () => void
}

export function ParentPropagationDialog({
  open,
  onOpenChange,
  changeOrderId,
  designId,
  targetItem,
  onSuccess,
}: ParentPropagationDialogProps) {
  const { alert } = useAlertDialog()
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [ancestors, setAncestors] = useState<Array<AncestorNode>>([])
  const [selectedAncestorIds, setSelectedAncestorIds] = useState<Set<string>>(
    new Set(),
  )
  const [description, setDescription] = useState('')

  // Fetch ancestors
  const fetchAncestors = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiFetch<{
        data: {
          item: any
          ancestors: Array<AncestorNode>
          releasedCount: number
          draftCount: number
        }
      }>(
        `/api/change-orders/${changeOrderId}/items/${targetItem.itemId}/ancestors?designId=${designId}`,
      )

      const fetchedAncestors = response.data.ancestors
      setAncestors(fetchedAncestors)

      // Auto-select released ancestors (they need revision)
      const releasedIds = new Set(
        fetchedAncestors
          .filter((a) => a.state === 'Released')
          .map((a) => a.itemId),
      )
      setSelectedAncestorIds(releasedIds)
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to load parent items.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [changeOrderId, targetItem.itemId, designId, alert])

  useEffect(() => {
    if (open) {
      fetchAncestors()
    }
  }, [open, fetchAncestors])

  // Toggle ancestor selection
  const toggleAncestor = (itemId: string) => {
    setSelectedAncestorIds((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) {
        next.delete(itemId)
      } else {
        next.add(itemId)
      }
      return next
    })
  }

  // Submit - add all selected items to ECO
  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      // Build items to add: target + selected ancestors
      const itemsToAdd = []

      // Add target item first
      const targetAction = getDefaultChangeAction(targetItem.state)
      const targetTarget = getTargetInfo(
        targetItem.state,
        targetItem.revision,
        targetAction,
      )
      itemsToAdd.push({
        affectedItemId: targetItem.itemId,
        changeAction: targetAction,
        currentState: targetItem.state,
        currentRevision: targetItem.revision,
        targetState: targetTarget.targetState,
        targetRevision: targetTarget.targetRevision,
        changeDescription: description || null,
      })

      // Add selected ancestors
      for (const ancestor of ancestors) {
        if (selectedAncestorIds.has(ancestor.itemId)) {
          const action = getDefaultChangeAction(ancestor.state)
          const target = getTargetInfo(
            ancestor.state,
            ancestor.revision,
            action,
          )
          itemsToAdd.push({
            affectedItemId: ancestor.itemId,
            changeAction: action,
            currentState: ancestor.state,
            currentRevision: ancestor.revision,
            targetState: target.targetState,
            targetRevision: target.targetRevision,
            changeDescription: `Parent of ${targetItem.itemNumber}`,
          })
        }
      }

      // Batch add
      await apiFetch(`/api/change-orders/${changeOrderId}/affected-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsToAdd }),
      })

      alert({
        title: 'Items Added',
        description: `${itemsToAdd.length} item(s) have been added to the ECO.`,
      })

      onSuccess()
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to add items to ECO.',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  // Separate released and draft ancestors
  const releasedAncestors = ancestors.filter((a) => a.state === 'Released')
  const draftAncestors = ancestors.filter((a) => a.state === 'Draft')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Item with Parent Chain</DialogTitle>
          <DialogDescription>
            {targetItem.itemNumber} has parent assemblies. Select which parents
            to include in this ECO.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        ) : (
          <div className="space-y-4 py-4 max-h-96 overflow-y-auto auto-hide-scroll">
            {/* Target item */}
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
              <div className="flex items-center gap-2">
                <Badge variant="default">Target</Badge>
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {targetItem.itemNumber}
                </span>
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  {targetItem.name}
                </span>
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                Rev {targetItem.revision} ({targetItem.state}) →{' '}
                {targetItem.state === 'Released'
                  ? `Rev ${incrementRevision(targetItem.revision)}`
                  : 'Release'}
              </div>
            </div>

            {/* Released ancestors (need revision) */}
            {releasedAncestors.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  Released parents (require revision)
                </div>
                {releasedAncestors.map((ancestor) => (
                  <div
                    key={ancestor.itemId}
                    className="flex items-center gap-3 p-2 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800"
                  >
                    <Checkbox
                      id={`ancestor-${ancestor.itemId}`}
                      checked={selectedAncestorIds.has(ancestor.itemId)}
                      onCheckedChange={() => toggleAncestor(ancestor.itemId)}
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <ChevronRight className="h-3 w-3 text-slate-400" />
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {ancestor.itemNumber}
                        </span>
                        <span className="text-sm text-slate-600 dark:text-slate-400 truncate">
                          {ancestor.name}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 dark:text-slate-400 ml-5">
                        Rev {ancestor.revision} ({ancestor.state}) → Rev{' '}
                        {incrementRevision(ancestor.revision)}
                      </div>
                    </div>
                    <Badge variant="warning" className="text-xs">
                      Level {ancestor.depth}
                    </Badge>
                  </div>
                ))}
              </div>
            )}

            {/* Draft ancestors (no action needed) */}
            {draftAncestors.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-500">
                  Draft parents (no revision needed)
                </div>
                {draftAncestors.map((ancestor) => (
                  <div
                    key={ancestor.itemId}
                    className="flex items-center gap-3 p-2 bg-slate-50 dark:bg-slate-800 rounded-lg opacity-60"
                  >
                    <Checkbox
                      id={`ancestor-${ancestor.itemId}`}
                      disabled
                      checked={false}
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <ChevronRight className="h-3 w-3 text-slate-400" />
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {ancestor.itemNumber}
                        </span>
                        <span className="text-sm text-slate-600 dark:text-slate-400 truncate">
                          {ancestor.name}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 dark:text-slate-400 ml-5">
                        Rev {ancestor.revision} (Draft - no change needed)
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-xs">
                      Level {ancestor.depth}
                    </Badge>
                  </div>
                ))}
              </div>
            )}

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                placeholder="Describe the change..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading || submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Add {1 + selectedAncestorIds.size} Item
            {1 + selectedAncestorIds.size !== 1 ? 's' : ''} to ECO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
