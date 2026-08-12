// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import type { BOMTreeNode } from './EcoTreeTable'
import type { ChangeAction } from '@/lib/types/lifecycle'
import { changeActionOptionsQuery } from '@/lib/query'
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
  const [selectedAction, setSelectedAction] = useState<ChangeAction | null>(
    null,
  )
  const [description, setDescription] = useState('')

  // What the server will actually do, resolved from the item's lifecycle
  const { data: options, isLoading: loadingOptions } = useQuery({
    ...changeActionOptionsQuery(changeOrderId, [item.itemId]),
    enabled: open,
  })
  const itemOptions = options?.at(0)
  const availableActions = itemOptions?.actions ?? []
  const changeAction = selectedAction ?? itemOptions?.defaultAction ?? null
  const targetInfo = availableActions.find((a) => a.action === changeAction)

  const handleSubmit = async () => {
    if (!changeAction) return
    setLoading(true)
    try {
      await apiFetch(`/api/v1/change-orders/${changeOrderId}/affected-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          affectedItemId: item.itemId,
          changeAction,
          changeDescription: description || null,
        }),
      })

      alert({
        title: 'Item Added',
        description: `${item.itemNumber} has been added to the ECO.`,
      })

      onSuccess()
    } catch (error) {
      alert({
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Failed to add item to ECO.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

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
            {loadingOptions ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Resolving available actions...
              </div>
            ) : availableActions.length > 0 ? (
              <Select
                value={changeAction ?? undefined}
                onValueChange={(v) => setSelectedAction(v as ChangeAction)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select action" />
                </SelectTrigger>
                <SelectContent>
                  {availableActions.map((action) => (
                    <SelectItem key={action.action} value={action.action}>
                      {action.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="text-sm text-slate-500 dark:text-slate-400">
                {itemOptions?.blockedReason ??
                  `No change action is available for items in ${item.state} state.`}
              </div>
            )}
          </div>

          {/* Target info. Revision is what the server predicts today; for a
              revision it is recomputed against main at release. */}
          {targetInfo?.targetState && (
            <div className="text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                Target:{' '}
              </span>
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {targetInfo.targetRevision
                  ? `Rev ${targetInfo.targetRevision} (${targetInfo.targetState})`
                  : targetInfo.targetState}
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
            disabled={loading || loadingOptions || !changeAction}
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Add to ECO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
