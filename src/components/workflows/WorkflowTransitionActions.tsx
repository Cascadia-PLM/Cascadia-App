import { useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Check, ChevronRight, RotateCcw, Send, X } from 'lucide-react'
import { WorkflowTransitionDialog } from './WorkflowTransitionDialog'
import type {
  AvailableTransition,
  WorkflowDefinition,
} from '@/lib/workflows/types'
import { Button } from '@/components/ui'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

interface WorkflowInstance {
  id: string
  workflowDefinitionId: string
  itemId: string
  currentState: string
  completedAt: string | null
}

// Response types for API calls
interface WorkflowDataResponse {
  data: {
    instance: WorkflowInstance | null
    definition: WorkflowDefinition | null
  }
}

// V1 API response format - transitions wrapped in data.transitions
interface TransitionsResponse {
  data: {
    transitions: Array<AvailableTransition>
  }
}

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
  const router = useRouter()
  const { handleError, showSuccess } = useErrorHandler()
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  const [workflowInstance, setWorkflowInstance] =
    useState<WorkflowInstance | null>(null)
  const [workflowDefinition, setWorkflowDefinition] =
    useState<WorkflowDefinition | null>(null)
  const [availableTransitions, setAvailableTransitions] = useState<
    Array<AvailableTransition>
  >([])

  // Fetch workflow instance and available transitions
  useEffect(() => {
    const fetchWorkflowData = async () => {
      setIsLoading(true)
      try {
        // Get workflow instance and definition
        const workflowData = await apiFetch<WorkflowDataResponse>(
          `/api/v1/change-orders/${itemId}/workflow`,
        )

        if (!workflowData.data.instance) {
          // No workflow instance - nothing to show
          setWorkflowInstance(null)
          setWorkflowDefinition(null)
          setAvailableTransitions([])
          return
        }

        setWorkflowInstance(workflowData.data.instance)
        setWorkflowDefinition(workflowData.data.definition)

        // Get available transitions
        const transitionsData = await apiFetch<TransitionsResponse>(
          `/api/v1/change-orders/${itemId}/workflow/transition`,
        )
        setAvailableTransitions(transitionsData.data.transitions)
      } catch {
        setAvailableTransitions([])
      } finally {
        setIsLoading(false)
      }
    }

    fetchWorkflowData()
  }, [itemId, refreshTrigger])

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
        setIsDialogOpen(false)
        // Refresh workflow data to show updated state/transitions
        setRefreshTrigger((prev) => prev + 1)
        onTransitionComplete?.()
        router.invalidate()
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

  // Determine button styling based on transition type
  const getTransitionButtonStyle = (transition: AvailableTransition) => {
    const name = transition.transition.name.toLowerCase()
    const toStateId = transition.transition.toStateId.toLowerCase()

    // Approve - green
    if (name.includes('approve') || toStateId.includes('approved')) {
      return {
        className: 'bg-green-600 hover:bg-green-700',
        icon: Check,
      }
    }

    // Reject - red/destructive
    if (name.includes('reject') || toStateId.includes('rejected')) {
      return {
        variant: 'destructive' as const,
        icon: X,
      }
    }

    // Cancel - red/destructive
    if (name.includes('cancel') || toStateId.includes('cancel')) {
      return {
        variant: 'destructive' as const,
        icon: X,
      }
    }

    // Submit - blue
    if (name.includes('submit')) {
      return {
        className: 'bg-blue-600 hover:bg-blue-700',
        icon: Send,
      }
    }

    // Return/Revise - gray
    if (
      name.includes('return') ||
      name.includes('revise') ||
      name.includes('revision')
    ) {
      return {
        variant: 'outline' as const,
        icon: RotateCcw,
      }
    }

    // Default
    return {
      className: 'bg-primary',
      icon: ChevronRight,
    }
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
              onClick={() => setIsDialogOpen(true)}
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
          isOpen={isDialogOpen}
          onClose={() => setIsDialogOpen(false)}
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
