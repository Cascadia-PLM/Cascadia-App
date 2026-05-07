import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  getAvailableActions,
  getDefaultChangeAction,
  getTargetInfo,
} from './eco-helpers'
import type { BOMTreeNode } from './EcoTreeTable'
import type { ChangeAction } from '@/lib/types/lifecycle'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface AddToEcoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  changeOrderId: string
  item: BOMTreeNode
  onSuccess: () => void
}

export function AddToEcoDialog({
  open,
  onOpenChange,
  changeOrderId,
  item,
  onSuccess,
}: AddToEcoDialogProps) {
  const { alert } = useAlertDialog()
  const [loading, setLoading] = useState(false)
  const [changeAction, setChangeAction] = useState<ChangeAction>(() =>
    getDefaultChangeAction(item.state),
  )
  const [description, setDescription] = useState('')

  const handleSubmit = async () => {
    setLoading(true)
    try {
      const target = getTargetInfo(item.state, item.revision, changeAction)

      await apiFetch(`/api/v1/change-orders/${changeOrderId}/affected-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          affectedItemId: item.itemId,
          changeAction,
          currentState: item.state,
          currentRevision: item.revision,
          targetState: target.targetState,
          targetRevision: target.targetRevision,
          changeDescription: description || null,
        }),
      })

      alert({
        title: 'Item Added',
        description: `${item.itemNumber} has been added to the ECO.`,
      })

      onSuccess()
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to add item to ECO.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const availableActions = getAvailableActions(item.state)
  const targetInfo = getTargetInfo(item.state, item.revision, changeAction)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to ECO</DialogTitle>
          <DialogDescription>
            Add {item.itemNumber} to this engineering change order.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Item info */}
          <div className="bg-slate-50 dark:bg-slate-800 p-3 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {item.itemNumber}
              </span>
              <Badge variant="outline">{item.itemType}</Badge>
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              {item.name}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Current: Rev {item.revision} ({item.state})
            </div>
          </div>

          {/* Change action */}
          <div className="space-y-2">
            <Label>Change Action</Label>
            {availableActions.length > 0 ? (
              <Select
                value={changeAction}
                onValueChange={(v) => setChangeAction(v as ChangeAction)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select action" />
                </SelectTrigger>
                <SelectContent>
                  {availableActions.map((action) => (
                    <SelectItem key={action.value} value={action.value}>
                      {action.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="text-sm text-slate-500 dark:text-slate-400">
                No actions available for items in {item.state} state.
              </div>
            )}
          </div>

          {/* Target info */}
          {availableActions.length > 0 && (
            <div className="text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                Target:{' '}
              </span>
              <span className="font-medium text-slate-900 dark:text-slate-100">
                Rev {targetInfo.targetRevision} ({targetInfo.targetState})
              </span>
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
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading || availableActions.length === 0}
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Add to ECO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
