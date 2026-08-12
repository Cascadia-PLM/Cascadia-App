// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import type { AvailableTransition, WorkflowState } from '@/lib/workflows/types'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { changeOrderReleasePreviewQuery } from '@/lib/query/options/change-orders'

interface WorkflowTransitionDialogProps {
  isOpen: boolean
  onClose: () => void
  changeOrderId: string
  changeOrderNumber: string
  currentState: WorkflowState
  availableTransitions: Array<AvailableTransition>
  allStates: Array<WorkflowState>
  /** The transition the user clicked, preselected on open */
  initialTransitionId?: string | null
  onConfirm: (toStateId: string, comments?: string) => Promise<void>
  isSubmitting?: boolean
}

export function WorkflowTransitionDialog({
  isOpen,
  onClose,
  changeOrderId,
  changeOrderNumber,
  currentState,
  availableTransitions,
  allStates,
  initialTransitionId,
  onConfirm,
  isSubmitting = false,
}: WorkflowTransitionDialogProps) {
  // The transition the user actually clicked. Every button used to open this
  // dialog with nothing chosen, so pressing "Approve" made you pick Approve
  // again from a list that also offered Cancel.
  const defaultTransitionId =
    initialTransitionId ??
    (availableTransitions.length === 1
      ? (availableTransitions[0]?.transition.id ?? null)
      : null)
  const [selectedTransitionId, setSelectedTransitionId] = useState<
    string | null
  >(defaultTransitionId)
  const [comments, setComments] = useState('')

  // Re-seed when the dialog opens or the clicked transition changes
  useEffect(() => {
    if (!isOpen) return
    setSelectedTransitionId(
      initialTransitionId ??
        (availableTransitions.length === 1
          ? (availableTransitions[0]?.transition.id ?? null)
          : null),
    )
  }, [isOpen, initialTransitionId, availableTransitions])

  const selectedTransition = availableTransitions.find(
    (t) => t.transition.id === selectedTransitionId,
  )

  const getTargetState = (toStateId: string) => {
    return allStates.find((s) => s.id === toStateId)
  }

  // Whether the selected transition releases. Keyed on `finalKind`, not on
  // `isFinal`: a cancellation is also final but merges nothing, and gating on
  // `isFinal` showed "N item(s) will be merged to main" with a list of revision
  // assignments to someone about to abandon the change order.
  const selectedTargetState = selectedTransition
    ? getTargetState(selectedTransition.transition.toStateId)
    : null
  const isReleaseTransition = selectedTargetState?.finalKind === 'release'
  const isCancelTransition = selectedTargetState?.finalKind === 'cancel'

  // Previewed only once a releasing transition is actually selected.
  const { data: releasePreview, isFetching: loadingPreview } = useQuery(
    changeOrderReleasePreviewQuery(changeOrderId, isReleaseTransition),
  )

  // A release the preview says cannot happen must not be offered. It used to
  // render the reasons in red and leave Confirm enabled, so the user pressed it
  // and got the same refusal back as an error.
  const releaseBlocked =
    isReleaseTransition && releasePreview?.canRelease === false

  const handleConfirm = async () => {
    if (!selectedTransition) return
    await onConfirm(
      selectedTransition.transition.toStateId,
      comments || undefined,
    )
  }

  const handleClose = () => {
    setSelectedTransitionId(defaultTransitionId)
    setComments('')
    onClose()
  }

  // Get color for state badge - using !important-style classes to override Badge defaults
  const getStateColor = (color?: string) => {
    const colorMap: Record<string, string> = {
      gray: 'bg-slate-200 border-slate-400 dark:bg-slate-700 dark:border-slate-500 [&]:text-slate-900 dark:[&]:text-slate-100',
      blue: 'bg-blue-100 border-blue-400 dark:bg-blue-800 dark:border-blue-600 [&]:text-blue-900 dark:[&]:text-blue-100',
      green:
        'bg-green-100 border-green-400 dark:bg-green-800 dark:border-green-600 [&]:text-green-900 dark:[&]:text-green-100',
      red: 'bg-red-100 border-red-400 dark:bg-red-800 dark:border-red-600 [&]:text-red-900 dark:[&]:text-red-100',
      yellow:
        'bg-yellow-100 border-yellow-400 dark:bg-yellow-800 dark:border-yellow-600 [&]:text-yellow-900 dark:[&]:text-yellow-100',
      purple:
        'bg-purple-100 border-purple-400 dark:bg-purple-800 dark:border-purple-600 [&]:text-purple-900 dark:[&]:text-purple-100',
      orange:
        'bg-orange-100 border-orange-400 dark:bg-orange-800 dark:border-orange-600 [&]:text-orange-900 dark:[&]:text-orange-100',
    }
    return colorMap[color || 'gray'] || colorMap.gray
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent
        className={cn(isReleaseTransition ? 'max-w-lg' : 'max-w-md')}
      >
        <DialogHeader>
          <DialogTitle>Sign Off Workflow</DialogTitle>
          <DialogDescription>
            Transition {changeOrderNumber} to the next workflow step
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {/* Current State */}
          <div>
            <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Current State
            </label>
            <div className="mt-1">
              <Badge
                className={cn('border', getStateColor(currentState.color))}
              >
                {currentState.name}
              </Badge>
            </div>
          </div>

          {/* Target State Selection */}
          <div>
            <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {availableTransitions.length === 1
                ? 'Target State'
                : 'Select Target State'}
            </label>
            <div className="mt-2 space-y-2">
              {availableTransitions.map((at) => {
                const targetState = getTargetState(at.transition.toStateId)
                const isSelected = selectedTransitionId === at.transition.id
                const canTransition = at.canTransition
                const failedGuards = at.guardResults.filter((g) => !g.passed)

                return (
                  <div key={at.transition.id}>
                    <button
                      type="button"
                      onClick={() =>
                        canTransition &&
                        setSelectedTransitionId(at.transition.id)
                      }
                      disabled={!canTransition || isSubmitting}
                      className={cn(
                        'w-full p-3 rounded-lg border-2 text-left transition-all relative',
                        isSelected
                          ? 'border-green-500 dark:border-green-400 bg-green-500/10 dark:bg-green-500/15 ring-2 ring-green-500/30 ring-offset-1 ring-offset-background'
                          : canTransition
                            ? 'border-slate-300 dark:border-slate-500 hover:border-slate-400 dark:hover:border-slate-400 hover:bg-muted/50'
                            : 'border-muted bg-muted/50 opacity-60 cursor-not-allowed',
                      )}
                    >
                      {isSelected && (
                        <div className="absolute top-2 right-2 h-5 w-5 rounded-full bg-green-500 flex items-center justify-center">
                          <Check className="h-3 w-3 text-white" />
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <Badge
                          className={cn(
                            'border',
                            getStateColor(currentState.color),
                          )}
                        >
                          {currentState.name}
                        </Badge>
                        <ArrowRight className="h-4 w-4 text-slate-500 dark:text-slate-400" />
                        <Badge
                          className={cn(
                            'border',
                            getStateColor(targetState?.color),
                          )}
                        >
                          {targetState?.name || at.transition.toStateId}
                        </Badge>
                      </div>
                      <div className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">
                        {at.transition.name}
                      </div>
                      {at.transition.description && (
                        <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
                          {at.transition.description}
                        </div>
                      )}
                    </button>

                    {/* Show guard failures */}
                    {failedGuards.length > 0 && (
                      <div className="mt-1 ml-2 text-xs text-destructive">
                        {failedGuards.map((g, idx) => (
                          <div key={idx}>
                            {g.errorMessage || `Guard "${g.guardName}" failed`}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Release Preview (shown when the transition releases) */}
          {isReleaseTransition && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-3">
              <div className="text-sm font-medium text-amber-900 dark:text-amber-100 mb-2">
                Release Preview
              </div>
              {loadingPreview ? (
                <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading preview...
                </div>
              ) : releasePreview ? (
                <div className="space-y-2 text-sm">
                  {(releasePreview.validationIssues ?? []).length > 0 && (
                    <div className="space-y-1">
                      {(releasePreview.validationIssues ?? []).map(
                        (issue, idx) => (
                          <div
                            key={idx}
                            className={cn(
                              'text-xs',
                              releasePreview.canRelease
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-red-600 dark:text-red-400',
                            )}
                          >
                            {issue}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  <div className="text-amber-800 dark:text-amber-200">
                    {(releasePreview.designs ?? []).length} design(s),{' '}
                    {releasePreview.totalItems} item(s) will be merged to main
                  </div>
                  {(releasePreview.designs ?? []).map((design) => {
                    const items = design.items ?? []
                    return (
                      <div
                        key={design.designId}
                        className="ml-2 text-xs text-amber-700 dark:text-amber-300"
                      >
                        <span className="font-medium">{design.designName}</span>
                        {' — '}
                        {items.length} item(s)
                        {items.length > 0 && (
                          <span>
                            , revisions:{' '}
                            {items
                              .map(
                                (r) =>
                                  `${r.itemNumber} ${r.currentRevision}→${r.newRevision}`,
                              )
                              .join(', ')}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="text-sm text-amber-700 dark:text-amber-300">
                  This transition will merge ECO changes to main and assign
                  revisions.
                </div>
              )}
            </div>
          )}

          {/* Cancellation notice — merges nothing, consumes no revisions */}
          {isCancelTransition && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50 p-3">
              <div className="text-sm font-medium text-red-900 dark:text-red-100 mb-1">
                This will abandon {changeOrderNumber}
              </div>
              <div className="text-sm text-red-700 dark:text-red-300">
                Nothing is merged to main and no revisions are assigned. The
                change order&apos;s branches are archived for audit, and the
                work on them is not released.
              </div>
            </div>
          )}

          {/* Comments */}
          <div>
            <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Comments (Optional)
            </label>
            <Textarea
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Add any notes about this transition..."
              rows={3}
              className="mt-1"
              disabled={isSubmitting}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={
              !selectedTransition?.canTransition ||
              isSubmitting ||
              loadingPreview ||
              releaseBlocked
            }
          >
            {isSubmitting ? 'Processing...' : 'Confirm Transition'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
