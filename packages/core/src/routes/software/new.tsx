// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import type { Software } from '@/lib/items/types/software'
import { SoftwareDetail } from '@/components/software/SoftwareDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { designListQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

// Search schema to accept default designId
const newSoftwareSearchSchema = z.object({
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/software/new')({
  validateSearch: newSoftwareSearchSchema,
  component: NewSoftwarePage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(designListQuery()),
})

function NewSoftwarePage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: designs = [] } = useQuery(designListQuery())
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (software: Software, branchId?: string) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...software,
        itemType: 'Software',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: Software } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      showSuccess(
        'Software created',
        `${software.name || 'Software item'} has been created successfully`,
      )

      await invalidate('software')

      navigate({ to: '/software/$id', params: { id: result.data.item.id! } })
    } catch (error) {
      handleError(error, { title: 'Failed to create software' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/software' })
  }

  return (
    <SoftwareDetail
      designs={designs}
      defaultDesignId={searchParams.designId}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
