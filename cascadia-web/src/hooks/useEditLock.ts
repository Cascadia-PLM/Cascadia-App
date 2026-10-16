// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VersionContext } from '@/hooks/useVersionContext'
import { apiFetch } from '@/api/client'
import { authSessionQuery, itemEditContextQuery } from '@/query'
import { itemCheckoutQuery } from '@/query/options/checkout'

export interface EditLockStatus {
  isCheckedOut: boolean
  checkedOutBy?: { id: string; name: string | null; email: string }
  checkedOutAt?: string | Date
}

/**
 * Where the server says this item may be edited: the branch carrying its edit
 * lock, and whether main is protected *for this item's type*.
 *
 * Both answers are the server's to give. Protection is a property of the
 * design (one released item protects main for everything in it) crossed with
 * the item type's lifecycle kind (a Free or Driving lifecycle is exempt and
 * stays editable on that same protected main), and the lock branch follows the
 * item's own branch row when it has one. A client cannot derive any of that
 * from the fields on the item, and every page that tried got it wrong in a
 * different way.
 */
export interface ItemEditContext {
  lockBranchId: string | null
  branchType: string | null
  existsOnMain: boolean
  isBranchLocked: boolean
  isMainProtected: boolean
  checkedOutBy: { id: string; name: string | null; email: string } | null
  state: string | null
  designId: string | null
}

/** Read the edit context for an item. Shares a cache key with `useEditLock`. */
export function useItemEditContext(
  itemId: string | undefined,
): ItemEditContext | null {
  const { data } = useQuery(
    itemEditContextQuery<ItemEditContext>(itemId ?? '', Boolean(itemId)),
  )
  return data ?? null
}

export interface UseEditLockOptions {
  /** Current item version id (the id the detail page loaded) */
  itemId: string | undefined
  context: VersionContext
  /** From `useItemEditContext`. Passed in so the page can gate on it too. */
  editContext: ItemEditContext | null
  currentUserId?: string
}

/**
 * The server-side edit lock behind the Edit button.
 *
 * Editing an item is gated on holding its checkout (branch_items.checkedOutBy)
 * — the server rejects content mutations without it. This hook resolves which
 * branch the lock lives on for the current version context, reads the lock
 * status, and exposes acquire/checkin/cancel operations:
 *
 * - branch context: the lock lives on that branch
 * - main context: wherever `editContext.lockBranchId` says — the item's own
 *   branch row if it has one, else main while main is unprotected
 * - protected main: no lock branch at all, so `canLock` is false — a released
 *   item revises through the CheckoutDialog, and anything else has to move to
 *   an ECO or workspace branch first
 * - tag/commit: read-only, no lock
 */
export function useEditLock({
  itemId,
  context,
  editContext,
  currentUserId,
}: UseEditLockOptions) {
  const { data: session } = useQuery({
    ...authSessionQuery(),
    enabled: !currentUserId,
  })
  const effectiveUserId = currentUserId ?? session?.user?.id

  // The version context decides which branch is being edited; the server
  // decides whether that branch can hold a lock. On main both halves come
  // from `editContext`, which is null (no lock branch) exactly when main is
  // protected for this item's type — the case that used to resolve to the
  // main branch id and fail on the POST.
  const lockBranchId =
    context.type === 'branch'
      ? context.branchId
      : context.type === 'main'
        ? (editContext?.lockBranchId ?? undefined)
        : undefined

  const {
    data: checkoutStatus,
    isError,
    refetch,
  } = useQuery({
    ...itemCheckoutQuery(itemId ?? '', lockBranchId ?? ''),
    retry: false,
  })
  // A missing branch item answers 404; there is no lock to show.
  const status = isError ? null : (checkoutStatus ?? null)
  const refreshStatus =
    useCallback(async (): Promise<EditLockStatus | null> => {
      if (!itemId || !lockBranchId) return null
      const result = await refetch()
      return result.isError ? null : (result.data ?? null)
    }, [itemId, lockBranchId, refetch])

  /** Acquire the edit lock (the Edit button). Throws if held by another user. */
  const acquire = useCallback(async () => {
    if (!itemId || !lockBranchId) {
      throw new Error('No editable branch available for checkout')
    }
    await apiFetch(`/api/v1/items/${itemId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ branchId: lockBranchId }),
    })
    await refreshStatus()
  }, [itemId, lockBranchId, refreshStatus])

  /** Release the lock keeping changes (leaving edit mode after save). */
  const checkin = useCallback(async () => {
    if (!itemId || !lockBranchId) return
    try {
      await apiFetch(`/api/v1/items/${itemId}/checkin`, {
        method: 'POST',
        body: JSON.stringify({ branchId: lockBranchId }),
      })
    } finally {
      await refreshStatus()
    }
  }, [itemId, lockBranchId, refreshStatus])

  /** Release the lock discarding the checkout (cancelling edit mode). */
  const cancel = useCallback(async () => {
    if (!itemId || !lockBranchId) return
    try {
      await apiFetch(`/api/v1/items/${itemId}/cancel-checkout`, {
        method: 'POST',
        body: JSON.stringify({ branchId: lockBranchId }),
      })
    } finally {
      await refreshStatus()
    }
  }, [itemId, lockBranchId, refreshStatus])

  const holder = status?.checkedOutBy
  const heldByMe = !!(
    status?.isCheckedOut &&
    effectiveUserId &&
    holder?.id === effectiveUserId
  )
  const lockedByOther = !!(status?.isCheckedOut && !heldByMe)
  const lockHolderLabel = lockedByOther
    ? holder?.name || holder?.email || 'another user'
    : undefined

  return {
    /** The branch the edit lock lives on for this context (if any) */
    lockBranchId,
    /** Whether a direct lock can be taken in this context */
    canLock: !!(itemId && lockBranchId),
    /** Whether main is protected for this item's type (server's answer) */
    isMainProtected: editContext?.isMainProtected ?? false,
    status,
    heldByMe,
    lockedByOther,
    lockHolderLabel,
    acquire,
    checkin,
    cancel,
    refreshStatus,
  }
}
