import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  Clock,
  MessageSquare,
  Play,
  RefreshCw,
  User,
  XCircle,
} from 'lucide-react'
import type {
  AvailableTransition,
  WorkflowDefinition,
  WorkflowHistoryEntry,
  WorkflowInstance,
} from '@/lib/workflows/types'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface WorkflowStatusPanelProps {
  itemId: string
  onStateChange?: () => void
}

const stateColors: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  submitted: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  approved:
    'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
  released:
    'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  implemented:
    'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
  closed: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  obsolete: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
}

function getStateColor(state: string): string {
  const key = state.toLowerCase().replace(/\s+/g, '')
  return stateColors[key] || stateColors.draft
}

export function WorkflowStatusPanel({
  itemId,
  onStateChange,
}: WorkflowStatusPanelProps) {
  const { alert } = useAlertDialog()
  const [loading, setLoading] = useState(true)
  const [instance, setInstance] = useState<WorkflowInstance | null>(null)
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)
  const [history, setHistory] = useState<Array<WorkflowHistoryEntry>>([])
  const [availableTransitions, setAvailableTransitions] = useState<
    Array<AvailableTransition>
  >([])
  const [showComments, setShowComments] = useState(false)
  const [comments, setComments] = useState('')
  const [transitioning, setTransitioning] = useState(false)
  const [selectedTransition, setSelectedTransition] = useState<string | null>(
    null,
  )

  // Fetch workflow data
  const loadWorkflowData = useCallback(async () => {
    setLoading(true)
    try {
      // Get workflow instance and definition
      const response = await fetch(`/api/change-orders/${itemId}/workflow`)
      if (response.ok) {
        const data = await response.json()
        setInstance(data.instance)
        setDefinition(data.definition)

        if (data.instance) {
          // Get history
          const historyRes = await fetch(
            `/api/change-orders/${itemId}/workflow/history`,
          )
          if (historyRes.ok) {
            const historyData = await historyRes.json()
            setHistory(historyData.history || [])
          }

          // Get available transitions (V1 response format - wrapped in data.transitions)
          const transitionsRes = await fetch(
            `/api/change-orders/${itemId}/workflow/transition`,
          )
          if (transitionsRes.ok) {
            const transitionsData = await transitionsRes.json()
            setAvailableTransitions(transitionsData.data?.transitions || [])
          }
        }
      }
    } catch {
      // Silently fail - workflow data may not be available
    } finally {
      setLoading(false)
    }
  }, [itemId])

  useEffect(() => {
    loadWorkflowData()
  }, [loadWorkflowData])

  // Execute a transition
  const handleTransition = async (toStateId: string) => {
    setTransitioning(true)
    try {
      const response = await fetch(
        `/api/change-orders/${itemId}/workflow/transition`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toStateId,
            comments: comments.trim() || undefined,
          }),
        },
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.details || error.error || 'Transition failed')
      }

      // V1 response format - result wrapped in data.transitionResult
      const responseData = await response.json()
      const result = responseData.data?.transitionResult

      // Refresh data
      await loadWorkflowData()
      setComments('')
      setShowComments(false)
      setSelectedTransition(null)

      // Notify parent
      onStateChange?.()

      alert({
        title: 'Success',
        description: `Transitioned from ${result?.fromState} to ${result?.toState}`,
      })
    } catch (error) {
      alert({
        title: 'Transition Failed',
        description: (error as Error).message,
        variant: 'destructive',
      })
    } finally {
      setTransitioning(false)
    }
  }

  const initiateTransition = (transition: AvailableTransition) => {
    if (!transition.canTransition) {
      const reasons = transition.guardResults
        .filter((g) => !g.passed)
        .map((g) => g.errorMessage || `Guard "${g.guardName}" failed`)

      alert({
        title: 'Cannot Perform Transition',
        description: reasons.join('\n'),
        variant: 'destructive',
      })
      return
    }

    setSelectedTransition(transition.transition.toStateId)
    setShowComments(true)
  }

  const executeSelectedTransition = () => {
    if (selectedTransition) {
      handleTransition(selectedTransition)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center text-slate-500">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            Loading workflow...
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!instance || !definition) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Workflow Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4 text-slate-500 dark:text-slate-400">
            <p>No workflow started for this change order.</p>
            <p className="text-sm mt-2">
              Start a workflow to track approval and implementation.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const currentState = definition.states.find(
    (s) => s.id === instance.currentState,
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>Workflow Status</CardTitle>
          <Badge className={getStateColor(instance.currentState)}>
            {currentState?.name || instance.currentState}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current State Info */}
        <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
          <div className="text-sm text-slate-600 dark:text-slate-400">
            Current State
          </div>
          <div className="text-lg font-semibold mt-1">
            {currentState?.name || instance.currentState}
          </div>
          {currentState?.description && (
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              {currentState.description}
            </p>
          )}
        </div>

        {/* Available Transitions */}
        {availableTransitions.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Available Actions
            </h4>
            <div className="flex flex-wrap gap-2">
              {availableTransitions.map((t) => {
                const targetState = definition.states.find(
                  (s) => s.id === t.transition.toStateId,
                )
                return (
                  <Button
                    key={t.transition.id}
                    variant={t.canTransition ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => initiateTransition(t)}
                    disabled={transitioning}
                    className={!t.canTransition ? 'opacity-50' : ''}
                  >
                    {t.canTransition ? (
                      <Play className="h-3 w-3 mr-1" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 mr-1" />
                    )}
                    {t.transition.name}
                    <ChevronRight className="h-3 w-3 ml-1" />
                    {targetState?.name || t.transition.toStateId}
                  </Button>
                )
              })}
            </div>
          </div>
        )}

        {/* Comment Form */}
        {showComments && selectedTransition && (
          <div className="space-y-2 p-3 border rounded-lg bg-blue-50 dark:bg-blue-900/20">
            <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-300">
              <MessageSquare className="h-4 w-4" />
              Add Comments (Optional)
            </div>
            <Input
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Enter any comments for this transition..."
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowComments(false)
                  setSelectedTransition(null)
                  setComments('')
                }}
                disabled={transitioning}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={executeSelectedTransition}
                disabled={transitioning}
              >
                {transitioning ? (
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <CheckCircle className="h-3 w-3 mr-1" />
                )}
                Confirm
              </Button>
            </div>
          </div>
        )}

        {/* Workflow History */}
        {history.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300">
              History
            </h4>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 p-2 border rounded-lg bg-white dark:bg-slate-950"
                >
                  <div className="mt-0.5">
                    {entry.toState === 'Rejected' ? (
                      <XCircle className="h-4 w-4 text-red-500" />
                    ) : (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">
                        {entry.action}
                      </span>
                      {entry.fromState && (
                        <>
                          <span className="text-slate-400">
                            {entry.fromState}
                          </span>
                          <ChevronRight className="h-3 w-3 text-slate-400" />
                        </>
                      )}
                      <span className="text-slate-700 dark:text-slate-300">
                        {entry.toState}
                      </span>
                    </div>
                    {entry.comments && (
                      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        "{entry.comments}"
                      </p>
                    )}
                    <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                      {entry.actorId && (
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {entry.actorId.slice(0, 8)}...
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Workflow Info */}
        <div className="text-xs text-slate-500 dark:text-slate-400 pt-2 border-t">
          <p>
            Workflow: <strong>{definition.name}</strong> (v{definition.version})
          </p>
          <p>Started: {new Date(instance.startedAt).toLocaleString()}</p>
          {instance.completedAt && (
            <p>Completed: {new Date(instance.completedAt).toLocaleString()}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
