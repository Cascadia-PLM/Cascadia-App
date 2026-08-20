// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
        // The designs travel with the create. Attaching them afterwards, as
        // this page used to, meant a failed attach left a change order linked
        // to no design — which sits outside every program and is therefore
        // visible to everyone.
        designIds: designIds ?? [],
        // Convert empty strings to undefined for optional fields
        itemNumber: changeOrder.itemNumber?.trim() || undefined,
        name: changeOrder.name?.trim() || undefined,
        description: (changeOrder as any).description?.trim() || undefined,
        reasonForChange: changeOrder.reasonForChange?.trim() || undefined,
        impactDescription: changeOrder.impactDescription?.trim() || undefined,
        baselineName: changeOrder.baselineName?.trim() || undefined,
      }
      const result = await apiFetch<{ data: { changeOrder: ChangeOrder } }>(
        '/api/v1/change-orders',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      const createdId = result.data.changeOrder.id!

      const designCount = designIds?.length ?? 0
      showSuccess(
        'Change order created',
        `${result.data.changeOrder.itemNumber} has been created successfully with ${designCount} design(s)`,
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
