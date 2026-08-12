// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { VersionContext } from '@/lib/hooks/useVersionContext'
import { CommitGraphView } from '@/components/versioning/CommitGraphView'

interface HistoryTabProps {
  designId: string
  versionContext: VersionContext
  onViewHistoricalState: (context: VersionContext) => void
}

export function HistoryTab({
  designId,
  versionContext,
  onViewHistoricalState,
}: HistoryTabProps) {
  // Get selected branch from version context
  const selectedBranch =
    versionContext.type === 'branch' ? versionContext.branchId : 'main'

  return (
    <CommitGraphView
      designId={designId}
      branchId={
        selectedBranch && selectedBranch !== 'main' ? selectedBranch : undefined
      }
      onViewHistoricalState={onViewHistoricalState}
    />
  )
}
