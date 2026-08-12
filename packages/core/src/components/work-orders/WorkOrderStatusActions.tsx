// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { CheckCircle, Loader2, Play, XCircle } from 'lucide-react'
import type { WorkOrderStatus } from '@/lib/items/types/work-order'
import { Button } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { useInvalidateResources } from '@/lib/query'

interface WorkOrderStatusActionsProps {
  workOrderId: string
  status: WorkOrderStatus
}

export function WorkOrderStatusActions({
  workOrderId,
  status,
}: WorkOrderStatusActionsProps) {
  const { handleError } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [loading, setLoading] = useState<string | null>(null)

  const handleTransition = async (newStatus: WorkOrderStatus) => {
    setLoading(newStatus)
    try {
      await apiFetch(`/api/v1/work-orders/${workOrderId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      })

      await invalidate('work-orders')
    } catch (error) {
      handleError(error, { title: 'Failed to update status' })
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
      <Button
        variant="outline"
        onClick={() => handleTransition('Cancelled')}
        disabled={loading !== null}
        className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
      >
        {loading === 'Cancelled' ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <XCircle className="h-4 w-4 mr-2" />
        )}
        Cancel
      </Button>
    </div>
  )
}
