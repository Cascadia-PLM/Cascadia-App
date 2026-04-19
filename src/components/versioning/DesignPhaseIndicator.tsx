import { useEffect, useState } from 'react'
import { Lock, Unlock } from 'lucide-react'
import { Badge } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

export interface DesignStatus {
  protection: {
    designId: string
    phase: 'pre-release' | 'post-release'
    hasReleasedItems: boolean
    releasedItemCount: number
    draftItemCount: number
    totalItemCount: number
    isMainBranchProtected: boolean
  }
  branchOptions: {
    phase: 'pre-release' | 'post-release'
    canEditMainDirectly: boolean
    availableBranchTypes: Array<'eco' | 'workspace' | 'release'>
  }
}

interface DesignPhaseIndicatorProps {
  designId: string
  className?: string
  showDetails?: boolean
  /**
   * Optional: Pass pre-fetched status to avoid additional API call
   */
  status?: DesignStatus
}

/**
 * Displays the current development phase of a design:
 * - Pre-Release: Items can be created/edited directly on main branch
 * - Post-Release: Main branch is protected, must use ECO/workspace branches
 */
export function DesignPhaseIndicator({
  designId,
  className,
  showDetails = false,
  status: initialStatus,
}: DesignPhaseIndicatorProps) {
  const [status, setStatus] = useState<DesignStatus | null>(
    initialStatus ?? null,
  )
  const [loading, setLoading] = useState(!initialStatus)

  useEffect(() => {
    // Skip fetch if status was provided
    if (initialStatus) {
      setStatus(initialStatus)
      setLoading(false)
      return
    }

    if (!designId) {
      setStatus(null)
      setLoading(false)
      return
    }

    async function fetchStatus() {
      setLoading(true)
      try {
        const result = await apiFetch<{ data: DesignStatus }>(
          `/api/designs/${designId}/status`,
        )
        setStatus(result.data)
      } catch {
        setStatus(null)
      } finally {
        setLoading(false)
      }
    }

    fetchStatus()
  }, [designId, initialStatus])

  if (loading) {
    return <div className="h-6 w-24 animate-pulse bg-slate-200 rounded-full" />
  }

  if (!status) {
    return null
  }

  const { phase, releasedItemCount, draftItemCount } = status.protection
  const isPreRelease = phase === 'pre-release'

  // Build tooltip text
  const tooltipText = isPreRelease
    ? `Pre-Release Phase: Create and edit items directly on main branch. ${draftItemCount} draft item(s) ready for release.`
    : `Change Control Active: Main branch is protected. Use ECO branches to make changes. ${releasedItemCount} item(s) released.`

  return (
    <div
      className={`inline-flex items-center gap-2 ${className ?? ''}`}
      title={tooltipText}
    >
      <Badge
        variant={isPreRelease ? 'warning' : 'success'}
        className="flex items-center gap-1 cursor-help"
      >
        {isPreRelease ? (
          <>
            <Unlock className="h-3 w-3" />
            Pre-Release
          </>
        ) : (
          <>
            <Lock className="h-3 w-3" />
            Change Control
          </>
        )}
      </Badge>
      {showDetails && (
        <span className="text-xs text-slate-500">
          {draftItemCount} draft, {releasedItemCount} released
        </span>
      )}
    </div>
  )
}
