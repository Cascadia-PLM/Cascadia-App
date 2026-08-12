// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronRight, RotateCcw, Send, X } from 'lucide-react'
import { WorkflowTransitionDialog } from './WorkflowTransitionDialog'
import type { AvailableTransition } from '@/lib/workflows/types'
import { Button } from '@/components/ui'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { useInvalidateResources } from '@/lib/query'
import {
  changeOrderTransitionsQuery,
  changeOrderWorkflowQuery,
} from '@/lib/query/options/workflows'
import { apiFetch } from '@/lib/api/client'

interface TransitionResultResponse {
  data: {
    success: boolean
    fromState: string
    toState: string
    error?: string
  }
}

interface WorkflowTransitionActionsProps {
  itemId: string
  itemNumber: string
  onTransitionComplete?: () => void
}

export function WorkflowTransitionActions({
  itemId,
  itemNumber,
  onTransitionComplete,
}: WorkflowTransitionActionsProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [pendingTransitionId, setPendingTransitionId] = useState<string | null>(
    null,
  )

  const { data: workflow, isLoading: isWorkflowLoading } = useQuery(
    changeOrderWorkflowQuery(itemId),
  )
  const workflowInstance = workflow?.instance ?? null
  const workflowDefinition = workflow?.definition ?? null

  const { data: transitions, isLoading: areTransitionsLoading } = useQuery(
    changeOrderTransitionsQuery(itemId, !!workflowInstance),
  )
  const availableTransitions = transitions ?? []

  const isLoading =
    isWorkflowLoading || (!!workflowInstance && areTransitionsLoading)

  const handleTransition = async (toStateId: string, comments?: string) => {
    setIsSubmitting(true)
    try {
      const data = await apiFetch<TransitionResultResponse>(
        `/api/v1/change-orders/${itemId}/workflow/transition`,
        {
          method: 'POST',
          body: JSON.stringify({ toStateId, comments }),
        },
      )

      if (data.data.success) {
        const targetState = workflowDefinition?.states.find(
          (s) => s.id === toStateId,
        )
        showSuccess(
          'Workflow Transition Complete',
          `${itemNumber} has been transitioned to ${targetState?.name || toStateId}`,
        )
        setPendingTransitionId(null)
        // A transition can release the ECO, which rewrites revisions across
        // every affected item — the dependency graph fans this out.
        await invalidate('workflows')
        onTransitionComplete?.()
      } else {
        throw new Error(data.data.error || 'Transition failed')
      }
    } catch (error) {
      handleError(error, { title: 'Failed to complete workflow transition' })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Get current state from definition
  const currentState = workflowDefinition?.states.find(
    (s) => s.id === workflowInstance?.currentState,
  )

  // Filter to only transitions that can be executed
  const executableTransitions = availableTransitions.filter(
    (t) => t.canTransition,
  )

  // Don't render anything while loading
  if (isLoading) {
    return null
  }

  // Don't render if no workflow or no available transitions
  if (
    !workflowInstance ||
    !workflowDefinition ||
    executableTransitions.length === 0
  ) {
    // Check if there are transitions that failed guards - show them disabled
    if (availableTransitions.length > 0 && executableTransitions.length === 0) {
      return (
        <div className="text-sm text-muted-foreground">
          No workflow actions available (guards not satisfied)
        </div>
      )
    }
    return null
  }

  // Button styling from what the transition *does*, not from substring-matching
  // its name. The dangerous version of this reflex — deciding release-vs-cancel
  // by sniffing the state name — was removed from the release path; `finalKind`
  // is the property that actually says which is which, and a transition named
  // "Accept" or "Abandon" got the wrong colour under the old test.
  const getTransitionButtonStyle = (transition: AvailableTransition) => {
    // Reached only after the early return above proved the definition loaded
    const targetState = workflowDefinition.states.find(
      (s) => s.id === transition.transition.toStateId,
    )

    // Releases — irreversible, and the one to draw the eye
    if (targetState?.finalKind === 'release') {
      return { className: 'bg-green-600 hover:bg-green-700', icon: Check }
    }

    // Cancels/rejects — destructive, also final
    if (targetState?.finalKind === 'cancel') {
      return { variant: 'destructive' as const, icon: X }
    }

    // Backward, into the workflow's initial state: rework
    if (targetState?.isInitial === true) {
      return { variant: 'outline' as const, icon: RotateCcw }
    }

    // Forward into review
    if (currentState?.isInitial === true) {
      return { className: 'bg-blue-600 hover:bg-blue-700', icon: Send }
    }

    return { className: 'bg-primary', icon: ChevronRight }
  }

  return (
    <>
      <div className="flex items-center gap-3">
        {executableTransitions.map((at) => {
          const style = getTransitionButtonStyle(at)
          const Icon = style.icon

          return (
            <Button
              key={at.transition.id}
              onClick={() => setPendingTransitionId(at.transition.id)}
              disabled={isSubmitting}
              variant={style.variant}
              className={style.className}
            >
              <Icon className="h-4 w-4 mr-2" />
              {at.transition.name}
            </Button>
          )
        })}
      </div>

      {currentState && (
        <WorkflowTransitionDialog
          isOpen={pendingTransitionId !== null}
          onClose={() => setPendingTransitionId(null)}
          initialTransitionId={pendingTransitionId}
          changeOrderId={itemId}
          changeOrderNumber={itemNumber}
          currentState={currentState}
          availableTransitions={executableTransitions}
          allStates={workflowDefinition.states}
          onConfirm={handleTransition}
          isSubmitting={isSubmitting}
        />
      )}
    </>
  )
}
