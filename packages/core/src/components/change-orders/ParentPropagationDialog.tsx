// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react'
import type { BOMTreeNode } from './EcoTreeTable'
import { changeActionOptionsQuery } from '@/lib/query'
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
        `/api/v1/change-orders/${changeOrderId}/items/${targetItem.itemId}/ancestors?designId=${designId}`,
      )

      setAncestors(response.data.ancestors)
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

  // What the server will do to the target and each ancestor. Replaces a
  // client-side prediction that grouped ancestors by the literal state names
  // 'Released'/'Draft' and previewed revisions with an increment that returned
  // '[' for an item at revision Z.
  const { data: actionOptions, isLoading: loadingOptions } = useQuery({
    ...changeActionOptionsQuery(changeOrderId, [
      targetItem.itemId,
      ...ancestors.map((a) => a.itemId),
    ]),
    enabled: open && !loading,
  })
  const optionsByItemId = new Map(
    (actionOptions ?? []).map((o) => [o.itemId, o]),
  )

  const describeTarget = (itemId: string): string | null => {
    const option = optionsByItemId.get(itemId)
    const action = option?.defaultAction
    if (!action) return option?.blockedReason ?? null
    const target = option.actions.find((a) => a.action === action)
    if (!target?.targetState) return option.actions[0]?.label ?? null
    return target.targetRevision
      ? `Rev ${target.targetRevision} (${target.targetState})`
      : target.targetState
  }

  // Auto-select the ancestors that will take a new revision — the parents
  // whose action assigns one, whatever their lifecycle calls that state.
  useEffect(() => {
    if (!actionOptions) return
    setSelectedAncestorIds(
      new Set(
        actionOptions
          .filter((option) => {
            if (option.itemId === targetItem.itemId) return false
            const action = option.defaultAction
            if (!action) return false
            return (
              option.actions.find((o) => o.action === action)?.targetRevision !=
              null
            )
          })
          .map((option) => option.itemId),
      ),
    )
  }, [actionOptions, targetItem.itemId])

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

      // Add target item first. Items with no available action are skipped
      // rather than sent with a guessed one.
      const targetAction = optionsByItemId.get(targetItem.itemId)?.defaultAction
      if (targetAction) {
        itemsToAdd.push({
          affectedItemId: targetItem.itemId,
          changeAction: targetAction,
          changeDescription: description || null,
        })
      }

      // Add selected ancestors
      for (const ancestor of ancestors) {
        if (selectedAncestorIds.has(ancestor.itemId)) {
          const action = optionsByItemId.get(ancestor.itemId)?.defaultAction
          if (!action) continue
          itemsToAdd.push({
            affectedItemId: ancestor.itemId,
            changeAction: action,
            changeDescription: `Parent of ${targetItem.itemNumber}`,
          })
        }
      }

      if (itemsToAdd.length === 0) {
        alert({
          title: 'Nothing to add',
          description:
            'None of the selected items are in a state this change order can act on.',
          variant: 'destructive',
        })
        return
      }

      // Batch add
      await apiFetch(`/api/v1/change-orders/${changeOrderId}/affected-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsToAdd }),
      })

      alert({
        title: 'Items Added',
        description: `${itemsToAdd.length} item(s) have been added to the ECO.`,
      })

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
      setSubmitting(false)
    }
  }

  // Split by what the ECO can actually do to each parent, not by state name:
  // parents that will take a new revision need a decision, the rest are shown
  // for context.
  const revisableAncestors = ancestors.filter((a) => {
    const option = optionsByItemId.get(a.itemId)
    const action = option?.defaultAction
    if (!action) return false
    return (
      option.actions.find((o) => o.action === action)?.targetRevision != null
    )
  })
  const otherAncestors = ancestors.filter(
    (a) => !revisableAncestors.includes(a),
  )

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

        {loading || loadingOptions ? (
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
                {describeTarget(targetItem.itemId) ?? 'no action available'}
              </div>
            </div>

            {/* Parents that will take a new revision */}
            {revisableAncestors.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  Parents that will take a new revision
                </div>
                {revisableAncestors.map((ancestor) => (
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
                        Rev {ancestor.revision} ({ancestor.state}) →{' '}
                        {describeTarget(ancestor.itemId)}
                      </div>
                    </div>
                    <Badge variant="warning" className="text-xs">
                      Level {ancestor.depth}
                    </Badge>
                  </div>
                ))}
              </div>
            )}

            {/* Parents this ECO will not re-revision */}
            {otherAncestors.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-500">
                  Other parents (no new revision)
                </div>
                {otherAncestors.map((ancestor) => (
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
                        Rev {ancestor.revision} ({ancestor.state}) —{' '}
                        {describeTarget(ancestor.itemId) ?? 'no change needed'}
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
