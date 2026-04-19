import { useState } from 'react'
import { CheckCircle, Loader2, Play, XCircle } from 'lucide-react'
import type { WorkOrderStatus } from '@/lib/items/types/work-order'
import { Button } from '@/components/ui'

interface WorkOrderStatusActionsProps {
  workOrderId: string
  status: WorkOrderStatus
  onStatusChange: (newStatus: WorkOrderStatus) => void
}

export function WorkOrderStatusActions({
  workOrderId,
  status,
  onStatusChange,
}: WorkOrderStatusActionsProps) {
  const [loading, setLoading] = useState<string | null>(null)

  const handleTransition = async (newStatus: WorkOrderStatus) => {
    setLoading(newStatus)
    try {
      const response = await fetch(`/api/work-orders/${workOrderId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to update status')
      }

      onStatusChange(newStatus)
    } catch (error) {
      console.error('Status transition failed:', error)
    } finally {
      setLoading(null)
    }
  }

  if (status === 'Complete' || status === 'Cancelled') {
    return null
  }

  return (
    <div className="flex gap-2">
      {status === 'Not Started' && (
        <Button
          onClick={() => handleTransition('In Progress')}
          disabled={loading !== null}
        >
          {loading === 'In Progress' ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Play className="h-4 w-4 mr-2" />
          )}
          Start
        </Button>
      )}
      {status === 'In Progress' && (
        <Button
          onClick={() => handleTransition('Complete')}
          disabled={loading !== null}
        >
          {loading === 'Complete' ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <CheckCircle className="h-4 w-4 mr-2" />
          )}
          Complete
        </Button>
      )}
      {(status === 'Not Started' || status === 'In Progress') && (
        <Button
          variant="outline"
          onClick={() => handleTransition('Cancelled')}
          disabled={loading !== null}
          className="text-red-600 hover:text-red-700"
        >
          {loading === 'Cancelled' ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4 mr-2" />
          )}
          Cancel
        </Button>
      )}
    </div>
  )
}
