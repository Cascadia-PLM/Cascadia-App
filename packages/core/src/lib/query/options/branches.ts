// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/**
 * Whether a design's main branch is under change control, and which branch
 * types may be created against it.
 *
 * The canonical shape for `/api/v1/designs/:id/status` — the branch selector,
 * the phase badge and the initial-release helper all read it, and each used
 * to declare its own narrower copy.
 */
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

/**
 * Branch protection and available branch types for one design.
 *
 * Keyed beneath the design, alongside its branch list, so releasing an ECO —
 * which flips a design from pre-release to change control — refreshes the
 * badge and the pickers without any of them re-fetching on their own.
 */
export function designStatusQuery(designId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('designs', designId, 'status'),
    queryFn: async (): Promise<DesignStatus> => {
      const result = await apiFetch<{ data: DesignStatus }>(
        `/api/v1/designs/${designId}/status`,
      )
      return result.data
    },
    enabled: enabled && Boolean(designId),
  })
}
