import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import { ChangeOrderDetail } from '@/components/change-orders/ChangeOrderDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const changeOrderDetailSearchSchema = z.object({
  tab: z
    .enum([
      'overview',
      'affected-items',
      'conflicts',
      'impact',
      'files',
      'approvals',
      'workflow',
      'history',
    ])
    .optional()
    .default('overview'),
})

export const Route = createFileRoute('/change-orders/$id')({
  component: ChangeOrderDetailPage,
  validateSearch: changeOrderDetailSearchSchema,
  loader: async ({ params }) => {
    try {
      const result = await apiFetch<{ data: { changeOrder: ChangeOrder } }>(
        `/api/change-orders/${params.id}`,
      )
      return { changeOrder: result.data.changeOrder }
    } catch (error) {
      console.error('Error loading change order:', error)
      throw error
    }
  },
})

function ChangeOrderDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const { changeOrder } = Route.useLoaderData()
  const search = Route.useSearch()

  const handleSave = async (
    updatedChangeOrder: ChangeOrder,
    _designIds?: Array<string>,
  ) => {
    if (!changeOrder.id) return

    await apiFetch(`/api/change-orders/${changeOrder.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedChangeOrder),
    })

    showSuccess(
      'Change order updated',
      `${updatedChangeOrder.itemNumber} has been updated successfully`,
    )
    router.invalidate()
  }

  const handleDelete = async () => {
    if (!changeOrder.id) return

    await apiFetch(`/api/change-orders/${changeOrder.id}`, {
      method: 'DELETE',
    })

    showSuccess(
      'Change order deleted',
      `${changeOrder.itemNumber} has been deleted`,
    )
    await router.invalidate()
    navigate({ to: '/change-orders' })
  }

  const handleCancel = () => {
    navigate({ to: '/change-orders' })
  }

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/change-orders/$id',
      params: { id: changeOrder.id ?? '' },
      search: {
        tab: tab as
          | 'overview'
          | 'affected-items'
          | 'conflicts'
          | 'impact'
          | 'files'
          | 'approvals'
          | 'workflow'
          | 'history',
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
