// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, GitBranch } from 'lucide-react'
import { Badge, Card } from '@/components/ui'
import { workspaceDetailQuery } from '@/lib/query'

interface WorkspaceContextBannerProps {
  branchId: string
}

export function WorkspaceContextBanner({
  branchId,
}: WorkspaceContextBannerProps) {
  // Shares the workspace detail cache entry with the workspace pages. A
  // branch that turns out not to be a workspace puts the query in an error
  // state, which renders as nothing — the banner is a probe, not a gate.
  const { data: workspace } = useQuery(workspaceDetailQuery(branchId))

  if (!workspace) {
    return null
  }

  const displayName = workspace.name.replace('workspace/', '')

  return (
    <Card className="border-cyan-200 bg-cyan-50 dark:border-cyan-800 dark:bg-cyan-900/20">
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GitBranch className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-cyan-900 dark:text-cyan-100">
                  Viewing in Workspace
                </span>
                <Badge variant="secondary" className="text-xs">
                  {displayName}
                </Badge>
              </div>
              <p className="text-sm text-cyan-700 dark:text-cyan-300 mt-0.5">
                You are viewing this item in your workspace context. Changes
                made here are private until you convert to an ECO or merge with
                main.
              </p>
            </div>
          </div>
          <Link
            to="/designs/workspaces/$id"
            params={{ id: workspace.id }}
            className="flex items-center gap-1 text-sm font-medium text-cyan-700 hover:text-cyan-900 dark:text-cyan-300 dark:hover:text-cyan-100 whitespace-nowrap"
          >
            View Workspace
            <ExternalLink className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </Card>
  )
}
