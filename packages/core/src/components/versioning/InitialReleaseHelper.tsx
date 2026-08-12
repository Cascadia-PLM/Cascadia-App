// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, FileText, Info, Rocket } from 'lucide-react'
import type { DesignStatus } from '@/lib/query/options/branches'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { designStatusQuery } from '@/lib/query/options/branches'

interface InitialReleaseHelperProps {
  designId: string
  /**
   * Optional: Pass pre-fetched status to avoid additional API call
   */
  status?: DesignStatus
  /**
   * Called when user clicks to create initial release ECO
   */
  onCreateEco?: () => void
  className?: string
}

/**
 * Helper component shown on design page when in pre-release phase.
 * Guides user to create an ECO for initial release.
 */
export function InitialReleaseHelper({
  designId,
  status: initialStatus,
  onCreateEco,
  className,
}: InitialReleaseHelperProps) {
  // A caller that already holds the status passes it in rather than paying for
  // a second request.
  const { data: fetchedStatus, isLoading: loading } = useQuery(
    designStatusQuery(designId, !initialStatus),
  )

  const status = initialStatus ?? fetchedStatus

  if (loading) {
    return (
      <div className="h-32 animate-pulse bg-slate-200 dark:bg-slate-700 rounded-lg" />
    )
  }

  // Only show in pre-release phase
  if (!status || status.protection.phase !== 'pre-release') {
    return null
  }

  const { draftItemCount, totalItemCount } = status.protection

  return (
    <Card
      className={`border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950 ${className ?? ''}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Info className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <CardTitle className="text-lg text-blue-900 dark:text-blue-100">
            Pre-Release Phase
          </CardTitle>
          <Badge variant="warning" className="ml-2">
            {draftItemCount} Draft Items
          </Badge>
        </div>
        <CardDescription className="text-blue-700 dark:text-blue-300">
          This design is in the initial development phase. You can create and
          edit items directly on the main branch. When your items are ready,
          create an ECO to release them with revision letters and enable change
          control.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 text-sm text-blue-600 dark:text-blue-400">
            <div className="flex items-center gap-1">
              <FileText className="h-4 w-4" />
              <span>{totalItemCount} total items</span>
            </div>
            {draftItemCount > 0 && (
              <div className="flex items-center gap-1">
                <Rocket className="h-4 w-4" />
                <span>{draftItemCount} ready for release</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {onCreateEco ? (
              <Button onClick={onCreateEco} variant="default">
                <Rocket className="h-4 w-4 mr-2" />
                Create Initial Release ECO
              </Button>
            ) : (
              <Link to="/change-orders/new">
                <Button variant="default">
                  <Rocket className="h-4 w-4 mr-2" />
                  Create Initial Release ECO
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </Link>
            )}
          </div>
        </div>

        {/* Guidance steps */}
        <div className="mt-4 pt-4 border-t border-blue-200 dark:border-blue-800">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
            Initial Release Steps:
          </p>
          <ol className="list-decimal list-inside text-sm text-blue-700 dark:text-blue-300 space-y-1">
            <li>Create a new Change Order (ECO) with type "Initial Release"</li>
            <li>Add all draft items to the affected items list</li>
            <li>Submit for approval and release</li>
            <li>
              Items will receive revision letters (A, B, C...) and change
              control will activate
            </li>
          </ol>
        </div>
      </CardContent>
    </Card>
  )
}
