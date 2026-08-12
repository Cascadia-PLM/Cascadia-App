// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import type { BOMTreeNode } from './EcoTreeTable'
import type { ChangeAction } from '@/lib/types/lifecycle'
import { changeActionOptionsQuery } from '@/lib/query'
import { StateBadge } from '@/components/items/StateBadge'
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

  // Per-item action overrides; the default comes from the server
  const [actionOverrides, setActionOverrides] = useState<
    Record<string, ChangeAction>
  >({})

  const { data: options, isLoading: loadingOptions } = useQuery({
    ...changeActionOptionsQuery(
      changeOrderId,
      items.map((i) => i.itemId),
    ),
    enabled: open,
  })
  const optionsByItemId = new Map((options ?? []).map((o) => [o.itemId, o]))

  const getItemAction = (item: BOMTreeNode): ChangeAction | null => {
    return (
      actionOverrides[item.itemId] ??
      optionsByItemId.get(item.itemId)?.defaultAction ??
      null
    )
  }

  const setItemAction = (itemId: string, action: ChangeAction) => {
    setActionOverrides((prev) => ({ ...prev, [itemId]: action }))
  }

  const addableCount = items.filter((i) => getItemAction(i) !== null).length

  const handleSubmit = async () => {
    setLoading(true)
    try {
      // Items with no available action are left out rather than sent with a
      // guessed one - the server would reject them anyway, and a partial batch
      // is worse than a short one.
      const itemsPayload = items.flatMap((item) => {
        const action = getItemAction(item)
        if (!action) return []
        return [
          {
            affectedItemId: item.itemId,
            changeAction: action,
            changeDescription: description || null,
          },
        ]
      })

      if (itemsPayload.length === 0) {
        alert({
          title: 'Nothing to add',
          description:
            'None of the selected items are in a state this change order can act on.',
          variant: 'destructive',
        })
        return
      }

      await apiFetch(`/api/v1/change-orders/${changeOrderId}/affected-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsPayload }),
      })

      alert({
        title: 'Items Added',
        description: `${itemsPayload.length} item${itemsPayload.length !== 1 ? 's' : ''} added to ECO.`,
      })

      setDescription('')
      setActionOverrides({})
      onSuccess()
    } catch (error) {
      alert({
        title: 'Error',
        description:
          error instanceof Error
            ? error.message
            : 'Failed to add items to ECO.',
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
                  const itemOptions = optionsByItemId.get(item.itemId)
                  const available = itemOptions?.actions ?? []
                  const target = available.find((a) => a.action === action)

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
                        <StateBadge
                          itemType={item.itemType}
                          state={item.state}
                          className="text-xs"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {loadingOptions ? (
                          <Loader2 className="h-3 w-3 animate-spin mx-auto text-slate-400" />
                        ) : available.length > 1 ? (
                          <Select
                            value={action ?? undefined}
                            onValueChange={(v) =>
                              setItemAction(item.itemId, v as ChangeAction)
                            }
                          >
                            <SelectTrigger className="h-7 w-24 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {available.map((a) => (
                                <SelectItem key={a.action} value={a.action}>
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
                                  : action
                                    ? 'default'
                                    : 'outline'
                            }
                            className="text-xs"
                          >
                            {available.at(0)?.label ?? 'No action available'}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs text-slate-500 dark:text-slate-400">
                        {target?.targetState
                          ? target.targetRevision
                            ? `Rev ${target.targetRevision} (${target.targetState})`
                            : target.targetState
                          : (itemOptions?.blockedReason ?? '—')}
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
            disabled={loading || loadingOptions || addableCount === 0}
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Add {addableCount} Item{addableCount !== 1 ? 's' : ''} to ECO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
