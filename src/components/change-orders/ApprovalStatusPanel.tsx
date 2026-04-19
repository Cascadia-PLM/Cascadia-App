import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  User,
  Users,
  X,
} from 'lucide-react'
import { ApprovalDialog } from './ApprovalDialog'
import type {
  ApprovalStatus,
  ApprovalsByState,
  CanApproveResult,
} from '@/lib/workflows/types'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface ApprovalStatusPanelProps {
  changeOrderId: string
  onApprovalChange?: () => void
}

interface ApprovalData {
  instanceId: string
  currentState: string
  approvals: ApprovalsByState
  canApprove: CanApproveResult
}

export function ApprovalStatusPanel({
  changeOrderId,
  onApprovalChange,
}: ApprovalStatusPanelProps) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ApprovalData | null>(null)
  const [expandedStates, setExpandedStates] = useState<Set<string>>(new Set())
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false)
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null)

  const fetchApprovals = useCallback(async () => {
    try {
      const result = await apiFetch<{ data: ApprovalData }>(
        `/api/change-orders/${changeOrderId}/approvals`,
      )
      setData(result.data)

      // Auto-expand current state
      if (result.data.currentState) {
        setExpandedStates(new Set([result.data.currentState]))
      }
    } catch (error) {
      console.error('Failed to fetch approvals:', error)
    } finally {
      setLoading(false)
    }
  }, [changeOrderId])

  useEffect(() => {
    fetchApprovals()
  }, [fetchApprovals])

  const toggleState = (stateId: string) => {
    setExpandedStates((prev) => {
      const next = new Set(prev)
      if (next.has(stateId)) {
        next.delete(stateId)
      } else {
        next.add(stateId)
      }
      return next
    })
  }

  const handleApprovalSubmitted = () => {
    fetchApprovals()
    onApprovalChange?.()
  }

  const openApprovalDialog = (stateId: string) => {
    setSelectedStateId(stateId)
    setApprovalDialogOpen(true)
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
            <span className="text-slate-500">Loading approvals...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-center text-slate-500 dark:text-slate-400">
            No approval information available
          </p>
        </CardContent>
      </Card>
    )
  }

  // Get states in order (we'll use the order from the approvals object)
  const states = Object.values(data.approvals)

  // Separate current, completed, and upcoming states
  const currentStateIndex = states.findIndex(
    (s) => s.stateId === data.currentState,
  )

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Approvals</CardTitle>
          <CardDescription>
            Review and submit approvals for each workflow state
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {states.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 italic">
              No approval requirements configured for this workflow
            </p>
          ) : (
            states.map((state, index) => {
              const isCurrentState = state.stateId === data.currentState
              const isCompleted = index < currentStateIndex
              const isUpcoming = index > currentStateIndex
              const isExpanded = expandedStates.has(state.stateId)
              const hasApprovers =
                state.requiredApprovers.length > 0 ||
                state.optionalApprovers.length > 0

              return (
                <StateApprovalSection
                  key={state.stateId}
                  state={state}
                  isCurrentState={isCurrentState}
                  isCompleted={isCompleted}
                  isUpcoming={isUpcoming}
                  isExpanded={isExpanded}
                  hasApprovers={hasApprovers}
                  canApprove={isCurrentState ? data.canApprove : null}
                  onToggle={() => toggleState(state.stateId)}
                  onApprove={() => openApprovalDialog(state.stateId)}
                />
              )
            })
          )}
        </CardContent>
      </Card>

      {selectedStateId && (
        <ApprovalDialog
          open={approvalDialogOpen}
          onOpenChange={setApprovalDialogOpen}
          changeOrderId={changeOrderId}
          stateId={selectedStateId}
          canApprove={data.canApprove}
          onApprovalSubmitted={handleApprovalSubmitted}
        />
      )}
    </>
  )
}

interface StateApprovalSectionProps {
  state: ApprovalStatus
  isCurrentState: boolean
  isCompleted: boolean
  isUpcoming: boolean
  isExpanded: boolean
  hasApprovers: boolean
  canApprove: CanApproveResult | null
  onToggle: () => void
  onApprove: () => void
}

function StateApprovalSection({
  state,
  isCurrentState,
  isCompleted,
  isUpcoming,
  isExpanded,
  hasApprovers,
  canApprove,
  onToggle,
  onApprove,
}: StateApprovalSectionProps) {
  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div
        className={`rounded-lg border ${
          isCurrentState
            ? 'border-cyan-200 bg-cyan-50 dark:border-cyan-900 dark:bg-cyan-950'
            : isCompleted
              ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'
              : 'border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800'
        }`}
      >
        <CollapsibleTrigger asChild>
          <button className="w-full px-4 py-3 flex items-center justify-between hover:opacity-80 transition-opacity">
            <div className="flex items-center gap-3">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-slate-500" />
              ) : (
                <ChevronRight className="h-4 w-4 text-slate-500" />
              )}
              <span className="font-medium text-slate-900 dark:text-white">
                {state.stateName}
              </span>
              {isCurrentState && (
                <Badge variant="default" className="text-xs">
                  Current
                </Badge>
              )}
              {isCompleted && (
                <Badge variant="success" className="text-xs">
                  Completed
                </Badge>
              )}
              {isUpcoming && (
                <Badge variant="secondary" className="text-xs">
                  Upcoming
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {hasApprovers && (
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {state.approvedCount}/{state.requiredCount} required
                </span>
              )}
              {state.isComplete && hasApprovers && (
                <Check className="h-4 w-4 text-green-500" />
              )}
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-4 pb-4 pt-1 space-y-3">
            {!hasApprovers ? (
              <p className="text-sm text-slate-500 dark:text-slate-400 italic">
                No approvers configured for this state
              </p>
            ) : (
              <>
                {/* Required Approvers */}
                {state.requiredApprovers.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                      Required Approvals
                    </h4>
                    {state.requiredApprovers.map((approver, idx) => (
                      <ApproverRow key={idx} approver={approver} />
                    ))}
                  </div>
                )}

                {/* Optional Approvers */}
                {state.optionalApprovers.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                      Optional Approvals
                    </h4>
                    {state.optionalApprovers.map((approver, idx) => (
                      <ApproverRow key={idx} approver={approver} />
                    ))}
                  </div>
                )}

                {/* Approve Button */}
                {isCurrentState && canApprove?.canApprove && (
                  <div className="pt-2 border-t border-slate-300 dark:border-slate-700">
                    <Button size="sm" onClick={onApprove}>
                      <Check className="h-4 w-4 mr-2" />
                      Submit Approval
                    </Button>
                  </div>
                )}

                {/* Already voted message */}
                {isCurrentState && canApprove?.alreadyVoted && (
                  <div className="pt-2 border-t border-slate-300 dark:border-slate-700">
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      You have already voted:{' '}
                      <Badge
                        variant={
                          canApprove.existingVote === 'approved'
                            ? 'success'
                            : 'destructive'
                        }
                      >
                        {canApprove.existingVote}
                      </Badge>
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface ApproverRowProps {
  approver: {
    approverType: 'user' | 'role'
    approverId: string
    approverName: string
    isRequired: boolean
    vote?: 'approved' | 'rejected' | null
    votedBy?: { id: string; name: string }
    votedAt?: Date
    comments?: string
  }
}

function ApproverRow({ approver }: ApproverRowProps) {
  const hasVoted = approver.vote !== null && approver.vote !== undefined

  return (
    <div className="flex items-start gap-3 p-2 rounded-md bg-white dark:bg-slate-900">
      <div className="flex-shrink-0 mt-0.5">
        {hasVoted ? (
          approver.vote === 'approved' ? (
            <div className="w-5 h-5 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
              <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
            </div>
          ) : (
            <div className="w-5 h-5 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center">
              <X className="h-3 w-3 text-red-600 dark:text-red-400" />
            </div>
          )
        ) : (
          <div className="w-5 h-5 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
            <Clock className="h-3 w-3 text-slate-400" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {approver.approverType === 'role' ? (
            <Users className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
          ) : (
            <User className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
          )}
          <span className="text-sm font-medium text-slate-900 dark:text-white truncate">
            {approver.approverName}
          </span>
          <span className="text-xs text-slate-500">
            ({approver.approverType})
          </span>
        </div>

        {hasVoted && approver.votedBy && (
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {approver.vote === 'approved' ? 'Approved' : 'Rejected'} by{' '}
            {approver.votedBy.name}
            {approver.votedAt && (
              <> on {new Date(approver.votedAt).toLocaleDateString()}</>
            )}
          </div>
        )}

        {approver.comments && (
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 italic">
            "{approver.comments}"
          </p>
        )}

        {!hasVoted && <span className="text-xs text-slate-400">Pending</span>}
      </div>
    </div>
  )
}
