import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import type { CheckoutStatus } from '@/lib/services/CheckoutService'
import { apiFetch } from '@/lib/api/client'

export interface CheckoutStatusBadgeProps {
  itemId: string
  branchId: string
  currentUserId: string
  onStatusLoaded?: (status: CheckoutStatus) => void
}

/**
 * Format the duration since checkout in a human-readable way
 */
function formatDuration(date: Date | string): string {
  const checkedOutAt = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diffMs = now.getTime() - checkedOutAt.getTime()

  const minutes = Math.floor(diffMs / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ago`
  }
  if (hours > 0) {
    return `${hours}h ago`
  }
  if (minutes > 0) {
    return `${minutes}m ago`
  }
  return 'just now'
}

/**
 * Displays checkout status for an item on a specific branch.
 * Shows nothing when item is not checked out (reduces visual noise).
 * Shows amber lock icon with user name when checked out.
 */
export function CheckoutStatusBadge({
  itemId,
  branchId,
  currentUserId,
  onStatusLoaded,
}: CheckoutStatusBadgeProps) {
  const [status, setStatus] = useState<CheckoutStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!branchId || !itemId) {
      setStatus(null)
      setLoading(false)
      return
    }

    const fetchStatus = async () => {
      setLoading(true)
      try {
        const response = await apiFetch<{ data: { status: CheckoutStatus } }>(
          `/api/v1/items/${itemId}/checkout?branchId=${branchId}`,
        )
        setStatus(response.data.status)
        onStatusLoaded?.(response.data.status)
      } catch {
        // Silently fail - item may not be on this branch
        setStatus(null)
      } finally {
        setLoading(false)
      }
    }

    fetchStatus()
  }, [itemId, branchId, onStatusLoaded])

  // Don't show anything while loading or if not checked out
  if (loading || !status?.isCheckedOut) {
    return null
  }

  const isCheckedOutByCurrentUser = status.checkedOutBy?.id === currentUserId
  const userName =
    status.checkedOutBy?.name || status.checkedOutBy?.email || 'Unknown user'
  const duration = status.checkedOutAt
    ? formatDuration(status.checkedOutAt)
    : ''

  return (
    <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
      <Lock className="w-3 h-3" />
      <span className="text-xs">
        {isCheckedOutByCurrentUser
          ? 'Checked out by you'
          : `Checked out by ${userName}`}
        {duration && ` (${duration})`}
      </span>
    </div>
  )
}

/**
 * Hook to fetch checkout status for an item on a branch.
 * Returns the status and a refetch function.
 */
export function useCheckoutStatus(
  itemId: string | undefined,
  branchId: string | undefined,
) {
  const [status, setStatus] = useState<CheckoutStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchStatus = async () => {
    if (!branchId || !itemId) {
      setStatus(null)
      return
    }

    setLoading(true)
    try {
      const response = await apiFetch<{ data: { status: CheckoutStatus } }>(
        `/api/v1/items/${itemId}/checkout?branchId=${branchId}`,
      )
      setStatus(response.data.status)
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
  }, [itemId, branchId])

  return { status, loading, refetch: fetchStatus }
}
