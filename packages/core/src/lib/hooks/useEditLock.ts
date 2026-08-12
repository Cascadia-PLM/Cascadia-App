// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useState } from 'react'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import { apiFetch } from '@/lib/api/client'

interface BranchSummary {
  id: string
  branchType: string
}

export interface EditLockStatus {
  isCheckedOut: boolean
  checkedOutBy?: { id: string; name: string | null; email: string }
  checkedOutAt?: string | Date
}

export interface UseEditLockOptions {
  /** Current item version id (the id the detail page loaded) */
  itemId: string | undefined
  designId: string | null | undefined
  context: VersionContext
  isMainProtected: boolean
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
 * - unprotected main: the lock lives on the design's main branch
 * - protected main: no direct lock — editing goes through the CheckoutDialog
 *   (revise onto an ECO/workspace branch) instead
 * - tag/commit: read-only, no lock
 */
export function useEditLock({
  itemId,
  designId,
  context,
  isMainProtected,
  currentUserId,
}: UseEditLockOptions) {
  const [mainBranchId, setMainBranchId] = useState<string | undefined>(
    undefined,
  )
  const [status, setStatus] = useState<EditLockStatus | null>(null)
  const [sessionUserId, setSessionUserId] = useState<string | undefined>(
    undefined,
  )

  // Resolve the current user for "checked out by you" when not provided
  useEffect(() => {
    if (currentUserId) return
    let cancelled = false
    apiFetch<{ data: { authenticated: boolean; user?: { id: string } } }>(
      '/api/v1/auth/session',
    )
      .then((res) => {
        if (!cancelled) setSessionUserId(res.data.user?.id)
      })
      .catch(() => {
        if (!cancelled) setSessionUserId(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [currentUserId])

  const effectiveUserId = currentUserId ?? sessionUserId

  const needsMainBranch =
    context.type === 'main' && !isMainProtected && !!designId

  useEffect(() => {
    if (!needsMainBranch || !designId) {
      setMainBranchId(undefined)
      return
    }
    let cancelled = false
    apiFetch<{ data: { branches: Array<BranchSummary> } }>(
      `/api/v1/designs/${designId}/branches`,
    )
      .then((res) => {
        if (!cancelled) {
          setMainBranchId(
            res.data.branches.find((b) => b.branchType === 'main')?.id,
          )
        }
      })
      .catch(() => {
        if (!cancelled) setMainBranchId(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [needsMainBranch, designId])

  const lockBranchId =
    context.type === 'branch'
      ? context.branchId
      : needsMainBranch
        ? mainBranchId
        : undefined

  const refreshStatus =
    useCallback(async (): Promise<EditLockStatus | null> => {
      if (!itemId || !lockBranchId) {
        setStatus(null)
        return null
      }
      try {
        const res = await apiFetch<{ data: { status: EditLockStatus } }>(
          `/api/v1/items/${itemId}/checkout?branchId=${lockBranchId}`,
        )
        setStatus(res.data.status)
        return res.data.status
      } catch {
        // Item may not be tracked on this branch yet — treat as unlocked
        setStatus(null)
        return null
      }
    }, [itemId, lockBranchId])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

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
