// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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
import { editableChangeOrdersQuery } from '@/lib/query'

interface MergeToChangeOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  workspaceName: string
  designId: string
  itemCount: number
  onSuccess?: (changeOrderId: string) => void
}

export function MergeToChangeOrderDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  designId,
  itemCount,
  onSuccess,
}: MergeToChangeOrderDialogProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const [selectedChangeOrderId, setSelectedChangeOrderId] = useState<string>('')
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // ECOs that can still accept items (scope not locked), for this design
  const { data: changeOrders = [], isLoading: loading } = useQuery({
    ...editableChangeOrdersQuery(designId),
    enabled: open && !!designId,
  })

  const handleMerge = async () => {
    if (!selectedChangeOrderId) {
      handleError(new Error('Please select a change order'), {
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
      }>(`/api/v1/workspaces/${workspaceId}/merge-to-change-order`, {
        method: 'POST',
        body: JSON.stringify({
          ecoId: selectedChangeOrderId,
          deleteWorkspace,
        }),
      })

      const changeOrder = changeOrders.find(
        (e) => e.id === selectedChangeOrderId,
      )
      showSuccess(
        'Workspace merged into the change order',
        `Added ${response.data.itemsAdded} item${response.data.itemsAdded !== 1 ? 's' : ''} to ${changeOrder?.itemNumber || 'ECO'}${response.data.itemsSkipped > 0 ? ` (${response.data.itemsSkipped} already present)` : ''}`,
      )

      onOpenChange(false)
      setSelectedChangeOrderId('')
      setDeleteWorkspace(false)
      onSuccess?.(response.data.ecoId)
    } catch (error) {
      handleError(error, {
        title: 'Failed to merge the workspace into the change order',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const selectedChangeOrder = changeOrders.find(
    (e) => e.id === selectedChangeOrderId,
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5" />
            Merge to Existing Change Order
          </DialogTitle>
          <DialogDescription>
            Merge {itemCount} item{itemCount !== 1 ? 's' : ''} from workspace{' '}
            <strong>{workspaceName}</strong> into an existing change order.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              <span className="ml-2 text-slate-500">
                Loading change orders...
              </span>
            </div>
          ) : changeOrders.length === 0 ? (
            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                No editable change orders found for this design. Change orders
                cannot accept items once their scope is locked.
              </p>
              <p className="text-sm text-amber-800 dark:text-amber-200 mt-2">
                Consider converting this workspace to a new change order
                instead.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="eco-select">Select Change Order *</Label>
                <Select
                  value={selectedChangeOrderId}
                  onValueChange={setSelectedChangeOrderId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a change order">
                      {selectedChangeOrder
                        ? `${selectedChangeOrder.itemNumber}${selectedChangeOrder.name ? ` - ${selectedChangeOrder.name}` : ''}`
                        : 'Select change order'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Available change orders</SelectLabel>
                      {changeOrders.map((changeOrder) => (
                        <SelectItem key={changeOrder.id} value={changeOrder.id}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {changeOrder.itemNumber}
                            </span>
                            <span className="text-slate-600 dark:text-slate-400">
                              {changeOrder.name}
                            </span>
                            <Badge
                              variant="secondary"
                              className="ml-auto text-xs"
                            >
                              {changeOrder.state}
                            </Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              {selectedChangeOrder && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <div className="text-sm">
                    <div className="font-medium text-blue-900 dark:text-blue-100 mb-1">
                      {selectedChangeOrder.itemNumber}
                    </div>
                    <div className="text-blue-700 dark:text-blue-300">
                      {selectedChangeOrder.name}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary">
                        {selectedChangeOrder.changeType}
                      </Badge>
                      <Badge variant="secondary">
                        {selectedChangeOrder.state}
                      </Badge>
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
              !selectedChangeOrderId ||
              isSubmitting ||
              loading ||
              changeOrders.length === 0
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
                Merge to Change Order
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
