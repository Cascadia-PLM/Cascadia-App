import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import { ChangeOrderDetail } from '@/components/change-orders/ChangeOrderDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/change-orders/new')({
  component: NewChangeOrderPage,
})

function NewChangeOrderPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (
    changeOrder: ChangeOrder,
    designIds?: Array<string>,
  ) => {
    setIsSubmitting(true)
    try {
      // Clean up the payload - convert empty strings to undefined
      // This matches what the original ChangeOrderForm did
      const payload = {
        ...changeOrder,
        itemType: 'ChangeOrder',
        // Convert empty strings to undefined for optional fields
        itemNumber: changeOrder.itemNumber?.trim() || undefined,
        name: changeOrder.name?.trim() || undefined,
        description: (changeOrder as any).description?.trim() || undefined,
        reasonForChange: changeOrder.reasonForChange?.trim() || undefined,
        impactDescription: changeOrder.impactDescription?.trim() || undefined,
        baselineName: changeOrder.baselineName?.trim() || undefined,
      }
      const result = await apiFetch<{ data: { item: ChangeOrder } }>(
        '/api/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      const createdId = result.data.item.id!

      // Add selected designs to the ECO
      if (designIds && designIds.length > 0) {
        const designResults = await Promise.allSettled(
          designIds.map((designId) =>
            fetch(`/api/change-orders/${createdId}/designs`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ designId }),
            }),
          ),
        )

        const failedCount = designResults.filter(
          (r) => r.status === 'rejected',
        ).length
        if (failedCount > 0) {
          console.warn(`Failed to add ${failedCount} design(s) to the ECO`)
        }
      }

      const designCount = designIds?.length || 0
      const designMessage =
        designCount > 0 ? ` with ${designCount} design(s)` : ''
      showSuccess(
        'Change order created',
        `${result.data.item.itemNumber}${designMessage} has been created successfully`,
      )
      navigate({
        to: '/change-orders/$id',
        params: { id: createdId },
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create change order' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/change-orders' })
  }

  return (
    <ChangeOrderDetail
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
