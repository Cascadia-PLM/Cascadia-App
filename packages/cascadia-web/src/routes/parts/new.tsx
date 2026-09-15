// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import type { Part } from '@/lib/items/types/part'
import type { PartSaveOptions } from '@/components/parts/PartDetail'
import { PartDetail } from '@/components/parts/PartDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { designListQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'
import { uploadItemFiles } from '@/lib/api/item-files'

// Search schema to accept default designId
const newPartSearchSchema = z.object({
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/parts/new')({
  validateSearch: newPartSearchSchema,
  component: NewPartPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(designListQuery()),
})

function NewPartPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess, showWarning } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: designs = [] } = useQuery(designListQuery())
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (
    part: Part,
    branchId?: string,
    options?: PartSaveOptions,
  ) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...part,
        itemType: 'Part',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: Part } }>('/api/v1/items', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const itemId = result.data.item.id!

      showSuccess(
        'Part created',
        `${part.itemNumber} has been created successfully`,
      )

      // Images dropped onto the form while it was being filled in. The part
      // exists now, so a failure here is a warning, not a failed save.
      const attachments = options?.attachments ?? []
      if (attachments.length > 0) {
        try {
          await uploadItemFiles(itemId, attachments, {
            branchId,
            thumbnailIndex: 0,
          })
          await invalidate('files')
        } catch (error) {
          showWarning(
            `Part created, but ${attachments.length === 1 ? 'the image' : 'the images'} could not be attached`,
            error instanceof Error ? error.message : undefined,
          )
        }
      }

      await invalidate('parts')

      // Navigate to the new part's detail page
      navigate({ to: '/parts/$id', params: { id: itemId } })
    } catch (error) {
      handleError(error, { title: 'Failed to create part' })
      throw error // Re-throw so PartDetail knows save failed
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/parts' })
  }

  return (
    <PartDetail
      designs={designs}
      defaultDesignId={searchParams.designId}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
