// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { WorkOrderStatus } from '@/lib/items/types/work-order'
import { FreeTransitionControl } from '@/components/items/FreeTransitionControl'
import { apiFetch } from '@/lib/api/client'
import { useInvalidateResources } from '@/lib/query'

interface WorkOrderStatusActionsProps {
  workOrderId: string
  status: WorkOrderStatus
}

/**
 * Work-order state actions: whatever transitions the WO lifecycle offers from
 * the current state, straight from configuration. Each runs through the
 * work-order status endpoint rather than the generic item transition, so the
 * response carries the refreshed work order.
 *
 * Not a correctness choice any more: the traveler gate and the completedAt
 * stamp moved onto the shared transition path, so the generic
 * endpoint would give the same answer. Picking the right URL is no longer
 * what holds the invariant.
 */
export function WorkOrderStatusActions({
  workOrderId,
  status,
}: WorkOrderStatusActionsProps) {
  const invalidate = useInvalidateResources()

  return (
    <FreeTransitionControl
      itemId={workOrderId}
      state={status}
      transition={async (option) => {
        await apiFetch(`/api/v1/work-orders/${workOrderId}/status`, {
          method: 'PUT',
          body: JSON.stringify({ status: option.toStateId }),
        })
      }}
      onTransitioned={() => void invalidate('work-orders')}
    />
  )
}
