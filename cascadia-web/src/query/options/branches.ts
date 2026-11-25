// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { BranchProtectionScope } from '@cascadia/commons/types/program'
import { apiFetch } from '@/api/client'

/** One branch, as `/api/v1/branches/:id` returns it. */
export interface BranchDetail {
  id: string
  name: string
  branchType: string
  designId: string | null
  changeOrderItemId: string | null
}

/**
 * One branch by id.
 *
 * Keyed under `branches`, so a checkout, a merge, or a workspace conversion
 * refreshes every reader — the pages that only wanted to know "is this a
 * workspace?" used to each fetch it themselves.
 */
export function branchDetailQuery(branchId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.detail('branches', branchId),
    queryFn: async (): Promise<BranchDetail> => {
      const result = await apiFetch<{ data: { branch: BranchDetail } }>(
        `/api/v1/branches/${branchId}`,
      )
      return result.data.branch
    },
    enabled: enabled && Boolean(branchId),
  })
}

/**
 * Whether a design's main branch is under change control, and which branch
 * types may be created against it.
 *
 * The canonical shape for `/api/v1/designs/:id/status` — the branch selector,
 * the phase badge and the initial-release helper all read it, and each used
 * to declare its own narrower copy.
 *
 * `isMainBranchProtected` / `phase` say main is under change control; what
 * that protects is `branchProtectionScope`. Under `released-items` an item's
 * own answer is its edit-context (`isMainProtected`), and whether a new item
 * may go straight onto main is `branchOptions.canCreateOnMain` — read through
 * `createRequiresBranch`, never re-derived from the phase.
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
    branchProtectionScope: BranchProtectionScope
  }
  branchOptions: {
    phase: 'pre-release' | 'post-release'
    /** Every item on main is directly editable — false once main is protected. */
    canEditMainDirectly: boolean
    /** A new item may be created directly on main. */
    canCreateOnMain: boolean
    branchProtectionScope: BranchProtectionScope
    availableBranchTypes: Array<'eco' | 'workspace' | 'release'>
  }
}

/**
 * Whether creating an item in this design has to name a branch.
 *
 * The server's answer (`canCreateOnMain`), not the phase: a design under the
 * `released-items` scope is post-release and still takes new drafts on main.
 * False while the status is unknown, as the phase check it replaces was.
 */
export function createRequiresBranch(
  status: DesignStatus | null | undefined,
): boolean {
  return status ? !status.branchOptions.canCreateOnMain : false
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
