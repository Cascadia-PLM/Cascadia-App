import { useState } from 'react'
import { CheckCircle, Loader2, RefreshCw, XCircle } from 'lucide-react'
import type { WorkInstructionExecution } from '@/lib/items/types/work-instruction'
import { Button, Textarea } from '@/components/ui'

interface SignOffPanelProps {
  execution: WorkInstructionExecution
  onSignOff: (
    decision: 'approved' | 'rejected',
    comments?: string,
  ) => Promise<void>
  onResubmit?: () => Promise<void>
  canResubmit?: boolean
}

export function SignOffPanel({
  execution,
  onSignOff,
  onResubmit,
  canResubmit = false,
}: SignOffPanelProps) {
  const [comments, setComments] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleDecision = async (decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && !comments.trim()) {
      setError('Comments are required when rejecting')
      return
    }

    setLoading(decision)
    setError(null)
    try {
      await onSignOff(decision, comments.trim() || undefined)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(null)
    }
  }

  const handleResubmit = async () => {
    if (!onResubmit) return
    setLoading('resubmit')
    setError(null)
    try {
      await onResubmit()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(null)
    }
  }

  if (execution.status === 'Rejected') {
    return (
      <div className="border rounded-lg p-4 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700 space-y-4">
        <div className="flex items-center gap-2">
          <XCircle className="h-4 w-4 text-red-600" />
          <span className="text-sm font-medium text-red-700 dark:text-red-300">
            This execution was rejected
          </span>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {canResubmit && onResubmit && (
          <Button
            onClick={handleResubmit}
            disabled={loading !== null}
            variant="outline"
          >
            {loading === 'resubmit' ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Resubmit for Approval
          </Button>
        )}
      </div>
    )
  }

  if (execution.status !== 'Pending Approval') {
    return null
  }

  return (
    <div className="border rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
          This execution requires sign-off
        </span>
      </div>

      <div className="space-y-3">
        {/* Summary */}
        <div className="text-sm text-slate-600 dark:text-slate-400">
          <p>
            Executed by:{' '}
            <span className="font-medium text-slate-900 dark:text-white">
              {execution.executor?.name || execution.executor?.email}
            </span>
          </p>
          <p>
            Started:{' '}
            <span className="font-medium">
              {new Date(execution.startedAt).toLocaleString()}
            </span>
          </p>
          <p>
            Data fields captured:{' '}
            <span className="font-medium">
              {Object.keys(execution.stepData).length}
            </span>
          </p>
        </div>

        {/* Comments */}
        <div>
          <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
            Comments{' '}
            {loading === 'rejected' ? '(required for rejection)' : '(optional)'}
          </label>
          <Textarea
            value={comments}
            onChange={(e) => {
              setComments(e.target.value)
              setError(null)
            }}
            placeholder="Add review comments..."
            rows={2}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* Decision buttons */}
        <div className="flex gap-3">
          <Button
            onClick={() => handleDecision('approved')}
            disabled={loading !== null}
            className="bg-green-600 hover:bg-green-700 text-white"
          >
            {loading === 'approved' ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CheckCircle className="h-4 w-4 mr-2" />
            )}
            Approve
          </Button>
          <Button
            variant="outline"
            onClick={() => handleDecision('rejected')}
            disabled={loading !== null}
            className="text-red-600 border-red-300 hover:bg-red-50"
          >
            {loading === 'rejected' ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <XCircle className="h-4 w-4 mr-2" />
            )}
            Reject
          </Button>
        </div>
      </div>
    </div>
  )
}
