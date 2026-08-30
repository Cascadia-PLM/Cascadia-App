// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import type { ChangeOrderDetailTab } from '@/components/change-orders/ChangeOrderDetail'
import {
  CHANGE_ORDER_DETAIL_TABS,
  ChangeOrderDetail,
} from '@/components/change-orders/ChangeOrderDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const changeOrderDetailSearchSchema = z.object({
  tab: z.enum(CHANGE_ORDER_DETAIL_TABS).optional().default('overview'),
})

export const Route = createFileRoute('/change-orders/$id')({
  component: ChangeOrderDetailPage,
  validateSearch: changeOrderDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      entityQuery<ChangeOrder>('change-orders', params.id, 'changeOrder'),
    ),
})

function ChangeOrderDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: changeOrder } = useQuery(
    entityQuery<ChangeOrder>('change-orders', id, 'changeOrder'),
  )
  const search = Route.useSearch()

  if (!changeOrder) return null

  const handleSave = async (
    updatedChangeOrder: ChangeOrder,
    _designIds?: Array<string>,
  ) => {
    if (!changeOrder.id) return

    await apiFetch(`/api/v1/change-orders/${changeOrder.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedChangeOrder),
    })

    showSuccess(
      'Change order updated',
      `${updatedChangeOrder.itemNumber} has been updated successfully`,
    )
    await invalidate('change-orders')
  }

  const handleDelete = async () => {
    if (!changeOrder.id) return

    await apiFetch(`/api/v1/change-orders/${changeOrder.id}`, {
      method: 'DELETE',
    })

    showSuccess(
      'Change order deleted',
      `${changeOrder.itemNumber} has been deleted`,
    )
    await invalidate('change-orders')
    navigate({ to: '/change-orders' })
  }

  const handleCancel = () => {
    navigate({ to: '/change-orders' })
  }

  const handleTabChange = (tab: ChangeOrderDetailTab) => {
    router.navigate({
      to: '/change-orders/$id',
      params: { id: changeOrder.id ?? '' },
      search: {
        tab,
      },
      replace: true,
    })
  }

  return (
    <ChangeOrderDetail
      changeOrder={changeOrder}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
