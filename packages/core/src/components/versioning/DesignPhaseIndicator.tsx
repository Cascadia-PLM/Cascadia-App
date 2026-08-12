// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import { Lock, Unlock } from 'lucide-react'
import type { DesignStatus } from '@/lib/query/options/branches'
import { Badge } from '@/components/ui'
import { designStatusQuery } from '@/lib/query/options/branches'

/** Re-exported so the forms that read a design's phase keep one import path. */
export type { DesignStatus }

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
  // A caller that already holds the status passes it in rather than paying for
  // a second request.
  const { data: fetchedStatus, isLoading: loading } = useQuery(
    designStatusQuery(designId, !initialStatus),
  )

  const status = initialStatus ?? fetchedStatus

  if (loading) {
    return (
      <div className="h-6 w-24 animate-pulse bg-slate-200 dark:bg-slate-700 rounded-full" />
    )
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
