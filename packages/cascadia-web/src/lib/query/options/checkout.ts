// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { CheckoutStatus } from '@/lib/services/CheckoutService'
import { apiFetch } from '@/lib/api/client'

/**
 * Whether an item is checked out on one branch, and by whom.
 *
 * Keyed beneath the item, so any write that names `items`, `branch-items` or
 * `branches` refreshes it. The badge and the branch pickers previously held
 * this in component state loaded once by an effect, so checking an item out
 * from one panel left every other view of it reading "available" until the
 * page was reloaded.
 */
export function itemCheckoutQuery(
  itemId: string,
  branchId: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('items', itemId, 'checkout', branchId),
    queryFn: async (): Promise<CheckoutStatus> => {
      const result = await apiFetch<{ data: { status: CheckoutStatus } }>(
        `/api/v1/items/${itemId}/checkout?branchId=${branchId}`,
      )
      return result.data.status
    },
    // An item that is not on the branch answers 404; there is nothing to ask
    // for until both ids are known.
    enabled: enabled && Boolean(itemId) && Boolean(branchId),
  })
}
