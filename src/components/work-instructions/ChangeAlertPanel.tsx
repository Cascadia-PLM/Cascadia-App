import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, CheckCheck, Clock, X } from 'lucide-react'
import type { WorkInstructionChangeAlert } from '@/lib/items/types/work-instruction'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { cn } from '@/lib/utils'

interface ChangeAlertPanelProps {
  workInstructionId: string
  onError?: (error: Error) => void
  onSuccess?: (message: string) => void
  onCountsChange?: (counts: { pending: number; total: number }) => void
}

export function ChangeAlertPanel({
  workInstructionId,
  onError,
  onSuccess,
  onCountsChange,
}: ChangeAlertPanelProps) {
  const [alerts, setAlerts] = useState<Array<WorkInstructionChangeAlert>>([])
  const [counts, setCounts] = useState({ pending: 0, total: 0 })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | null>(null)

  const loadAlerts = useCallback(async () => {
    try {
      const url = filter
        ? `/api/v1/work-instructions/${workInstructionId}/alerts?status=${filter}`
        : `/api/v1/work-instructions/${workInstructionId}/alerts`
      const response = await fetch(url)
      if (!response.ok) throw new Error('Failed to load alerts')
      const data = await response.json()
      setAlerts(data.data?.alerts ?? [])
      if (data.data?.counts) {
        setCounts(data.data.counts)
        onCountsChange?.(data.data.counts)
      }
    } catch (error) {
      onError?.(error as Error)
    } finally {
      setLoading(false)
    }
  }, [workInstructionId, filter, onError, onCountsChange])

  useEffect(() => {
    loadAlerts()
  }, [loadAlerts])

  const handleAction = async (
    alertId: string,
    action: 'acknowledge' | 'dismiss',
  ) => {
    try {
      const response = await fetch(
        `/api/v1/work-instructions/${workInstructionId}/alerts`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertId, action }),
        },
      )
      if (!response.ok) throw new Error(`Failed to ${action} alert`)

      // Update local state
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId
            ? {
                ...a,
                status: action === 'acknowledge' ? 'acknowledged' : 'dismissed',
              }
            : a,
        ),
      )
      setCounts((prev) => ({
        ...prev,
        pending: Math.max(0, prev.pending - 1),
      }))
      onCountsChange?.({
        ...counts,
        pending: Math.max(0, counts.pending - 1),
      })
      onSuccess?.(
        `Alert ${action === 'acknowledge' ? 'acknowledged' : 'dismissed'}`,
      )
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const handleBulkAcknowledge = async () => {
    try {
      const response = await fetch(
        `/api/v1/work-instructions/${workInstructionId}/alerts`,
        { method: 'POST' },
      )
      if (!response.ok) throw new Error('Failed to acknowledge alerts')
      const data = await response.json()

      // Reload
      await loadAlerts()
      onSuccess?.(
        `${data.data?.acknowledged ?? 0} alert${data.data?.acknowledged !== 1 ? 's' : ''} acknowledged`,
      )
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const getChangeTypeLabel = (type: string) => {
    switch (type) {
      case 'part_modified':
        return 'Part Modified'
      case 'part_obsoleted':
        return 'Part Obsoleted'
      case 'parametric_stale':
        return 'Parametric Stale'
      default:
        return type
    }
  }

  const getChangeTypeBadge = (type: string) => {
    switch (type) {
      case 'part_modified':
        return 'warning' as const
      case 'part_obsoleted':
        return 'destructive' as const
      case 'parametric_stale':
        return 'secondary' as const
      default:
        return 'default' as const
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return <Clock className="h-4 w-4 text-amber-500" />
      case 'acknowledged':
        return <Check className="h-4 w-4 text-green-500" />
      case 'dismissed':
        return <X className="h-4 w-4 text-slate-400" />
      default:
        return null
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Change Alerts
              {counts.pending > 0 && (
                <Badge variant="warning">{counts.pending} pending</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Notifications when linked parts are modified by ECOs
            </CardDescription>
          </div>
          {counts.pending > 0 && (
            <Button variant="outline" size="sm" onClick={handleBulkAcknowledge}>
              <CheckCheck className="h-4 w-4 mr-2" />
              Acknowledge All
            </Button>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mt-4">
          {[null, 'pending', 'acknowledged', 'dismissed'].map((f) => (
            <button
              key={f || 'all'}
              className={cn(
                'text-xs px-3 py-1 rounded-full transition-colors',
                filter === f
                  ? 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400',
              )}
              onClick={() => setFilter(f)}
            >
              {f ? f.charAt(0).toUpperCase() + f.slice(1) : 'All'}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-slate-500 text-center py-4">Loading alerts...</p>
        ) : alerts.length === 0 ? (
          <p className="text-slate-500 text-center py-8">
            {filter
              ? `No ${filter} alerts.`
              : 'No change alerts for this work instruction.'}
          </p>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-lg border',
                  alert.status === 'pending'
                    ? 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800'
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700',
                )}
              >
                {getStatusIcon(alert.status)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={getChangeTypeBadge(alert.changeType)}>
                      {getChangeTypeLabel(alert.changeType)}
                    </Badge>
                    {alert.part && (
                      <span className="text-sm font-medium text-slate-900 dark:text-white">
                        {alert.part.itemNumber}
                      </span>
                    )}
                    {alert.part?.name && (
                      <span className="text-sm text-slate-500 truncate">
                        {alert.part.name}
                      </span>
                    )}
                  </div>
                  {alert.changedFields && alert.changedFields.length > 0 && (
                    <p className="text-xs text-slate-500 mb-1">
                      Changed: {alert.changedFields.join(', ')}
                    </p>
                  )}
                  {alert.eco && (
                    <p className="text-xs text-slate-400">
                      ECO: {alert.eco.itemNumber}
                      {alert.eco.name ? ` - ${alert.eco.name}` : ''}
                    </p>
                  )}
                  {alert.createdAt && (
                    <p className="text-xs text-slate-400 mt-1">
                      {new Date(alert.createdAt).toLocaleString()}
                    </p>
                  )}
                </div>
                {alert.status === 'pending' && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-green-600 hover:text-green-700"
                      onClick={() => handleAction(alert.id, 'acknowledge')}
                    >
                      <Check className="h-3 w-3 mr-1" />
                      Ack
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-slate-400 hover:text-slate-600"
                      onClick={() => handleAction(alert.id, 'dismiss')}
                    >
                      <X className="h-3 w-3 mr-1" />
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
