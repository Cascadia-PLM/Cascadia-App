// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { BRANCH_TYPES } from '@cascadia/commons/versioning/branch-types'
import type { VersionContext } from '@/hooks/useVersionContext'
import type { BranchDetail } from '@/query/options/branches'
import { apiFetch } from '@/api/client'

export type ItemDeleteIntent =
  | { kind: 'item' }
  | { kind: 'branch'; branchId: string }
  | {
      kind: 'change-order'
      changeOrderId: string
      itemMasterId: string
    }

export interface ItemBranchActions {
  needsCheckout: boolean
  editButtonLabel: 'Edit' | 'Edit on Branch' | 'Revise'
  deleteButtonLabel: 'Delete' | 'Remove from ECO'
  deleteIntent: ItemDeleteIntent
  deleteTitle: string
  deleteDescription: string
}

/**
 * One policy for the action buttons shared by every version-aware Item page.
 * The server decides whether main is protected for the Item's configured
 * lifecycle; the client only translates that answer and the selected version
 * context into consistent labels and API intent.
 */
export function resolveItemBranchActions({
  itemLabel,
  itemNumber,
  itemMasterId,
  isCreateMode,
  isReleasedFamily,
  isMainProtected,
  context,
  branch,
}: {
  itemLabel: string
  itemNumber?: string
  itemMasterId?: string
  isCreateMode: boolean
  isReleasedFamily: boolean
  isMainProtected: boolean
  context: VersionContext
  branch?: BranchDetail
}): ItemBranchActions {
  const itemDisplay = itemNumber || `this ${itemLabel.toLowerCase()}`
  const needsCheckout =
    !isCreateMode && context.type === 'main' && isMainProtected
  const editButtonLabel = needsCheckout
    ? isReleasedFamily
      ? 'Revise'
      : 'Edit on Branch'
    : 'Edit'

  if (
    context.type === 'branch' &&
    context.branchId &&
    branch?.branchType === BRANCH_TYPES.changeOrder &&
    branch.changeOrderItemId &&
    itemMasterId
  ) {
    return {
      needsCheckout,
      editButtonLabel,
      deleteButtonLabel: 'Remove from ECO',
      deleteIntent: {
        kind: 'change-order',
        changeOrderId: branch.changeOrderItemId,
        itemMasterId,
      },
      deleteTitle: `Remove ${itemLabel} from ECO`,
      deleteDescription:
        `Remove ${itemDisplay} from ${branch.name}? ` +
        `Its unreleased changes and checkout on this ECO will be discarded. ` +
        `The ${itemLabel} on main will not be deleted.`,
    }
  }

  if (context.type === 'branch' && context.branchId) {
    return {
      needsCheckout,
      editButtonLabel,
      deleteButtonLabel: 'Delete',
      deleteIntent: { kind: 'branch', branchId: context.branchId },
      deleteTitle: `Delete ${itemLabel} on Branch`,
      deleteDescription:
        `Delete ${itemDisplay} on ${branch?.name ?? 'this branch'}? ` +
        `The ${itemLabel} on main will not be deleted until the branch is formally applied.`,
    }
  }

  return {
    needsCheckout,
    editButtonLabel,
    deleteButtonLabel: 'Delete',
    deleteIntent: { kind: 'item' },
    deleteTitle: `Delete ${itemLabel}`,
    deleteDescription: `Are you sure you want to delete ${itemDisplay}? This action cannot be undone.`,
  }
}

/** Execute the delete semantics selected by resolveItemBranchActions. */
export function deleteItemByIntent({
  itemId,
  mainDeletePath,
  intent,
}: {
  itemId: string
  mainDeletePath: string
  intent: ItemDeleteIntent
}): Promise<unknown> {
  if (intent.kind === 'change-order') {
    const query = new URLSearchParams({
      itemMasterId: intent.itemMasterId,
      discardBranchChanges: 'true',
    })
    return apiFetch(
      `/api/v1/change-orders/${intent.changeOrderId}/affected-items?${query}`,
      { method: 'DELETE' },
    )
  }

  if (intent.kind === 'branch') {
    const query = new URLSearchParams({ branchId: intent.branchId })
    return apiFetch(`/api/v1/items/${itemId}?${query}`, { method: 'DELETE' })
  }

  return apiFetch(mainDeletePath, { method: 'DELETE' })
}
