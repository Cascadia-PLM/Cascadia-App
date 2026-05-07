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

interface BatchAddToEcoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  changeOrderId: string
  items: Array<BOMTreeNode>
  onSuccess: () => void
}

export function BatchAddToEcoDialog({
  open,
  onOpenChange,
  changeOrderId,
  items,
  onSuccess,
}: BatchAddToEcoDialogProps) {
  const { alert } = useAlertDialog()
  const [loading, setLoading] = useState(false)
  const [description, setDescription] = useState('')

  // Per-item action overrides (defaults computed from state)
  const [actionOverrides, setActionOverrides] = useState<
    Record<string, ChangeAction>
  >({})

  const getItemAction = (item: BOMTreeNode): ChangeAction => {
    return actionOverrides[item.itemId] ?? getDefaultChangeAction(item.state)
  }

  const setItemAction = (itemId: string, action: ChangeAction) => {
    setActionOverrides((prev) => ({ ...prev, [itemId]: action }))
  }

  const handleSubmit = async () => {
    setLoading(true)
    try {
      const itemsPayload = items.map((item) => {
        const action = getItemAction(item)
        const target = getTargetInfo(item.state, item.revision, action)
        return {
          affectedItemId: item.itemId,
          changeAction: action,
          currentState: item.state,
          currentRevision: item.revision,
          targetState: target.targetState,
          targetRevision: target.targetRevision,
          changeDescription: description || null,
        }
      })

      await apiFetch(`/api/v1/change-orders/${changeOrderId}/affected-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsPayload }),
      })

      alert({
        title: 'Items Added',
        description: `${items.length} item${items.length !== 1 ? 's' : ''} added to ECO.`,
      })

      setDescription('')
      setActionOverrides({})
      onSuccess()
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to add items to ECO.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add {items.length} Items to ECO</DialogTitle>
          <DialogDescription>
            Review the change actions for each item before adding them to the
            ECO.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 overflow-y-auto min-h-0">
          {/* Items table */}
          <div className="border rounded-lg dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                <tr className="text-xs text-slate-600 dark:text-slate-400 font-medium">
                  <th className="text-left px-3 py-1.5">Item</th>
                  <th className="text-left px-3 py-1.5">Name</th>
                  <th className="text-center px-3 py-1.5">Rev</th>
                  <th className="text-center px-3 py-1.5">State</th>
                  <th className="text-center px-3 py-1.5">Action</th>
                  <th className="text-center px-3 py-1.5">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-slate-700">
                {items.map((item) => {
                  const action = getItemAction(item)
                  const available = getAvailableActions(item.state)
                  const target = getTargetInfo(
                    item.state,
                    item.revision,
                    action,
                  )

                  return (
                    <tr
                      key={item.itemId}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <td className="px-3 py-1.5 font-medium text-slate-900 dark:text-white whitespace-nowrap">
                        {item.itemNumber}
                      </td>
                      <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400 truncate max-w-[150px]">
                        {item.name}
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs text-slate-500 dark:text-slate-400">
                        {item.revision}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <Badge
                          variant={
                            item.state === 'Released'
                              ? 'success'
                              : item.state === 'Draft'
                                ? 'secondary'
                                : 'default'
                          }
                          className="text-xs"
                        >
                          {item.state}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {available.length > 1 ? (
                          <Select
                            value={action}
                            onValueChange={(v) =>
                              setItemAction(item.itemId, v as ChangeAction)
                            }
                          >
                            <SelectTrigger className="h-7 w-24 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {available.map((a) => (
                                <SelectItem key={a.value} value={a.value}>
                                  {a.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge
                            variant={
                              action === 'release'
                                ? 'success'
                                : action === 'obsolete'
                                  ? 'destructive'
                                  : 'default'
                            }
                            className="text-xs"
                          >
                            {available[0]?.label ?? action}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs text-slate-500 dark:text-slate-400">
                        Rev {target.targetRevision} ({target.targetState})
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="batch-description">Description (optional)</Label>
            <Textarea
              id="batch-description"
              placeholder="Describe the changes..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading || items.length === 0}
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Add {items.length} Item{items.length !== 1 ? 's' : ''} to ECO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
