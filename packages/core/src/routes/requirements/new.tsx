// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import type { Requirement } from '@/lib/items/types/requirement'
import { RequirementDetail } from '@/components/requirements/RequirementDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { designListQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const newRequirementSearchSchema = z.object({
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/requirements/new')({
  validateSearch: newRequirementSearchSchema,
  component: NewRequirementPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(designListQuery()),
})

function NewRequirementPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: designs = [] } = useQuery(designListQuery())
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (requirement: Requirement, branchId?: string) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...requirement,
        itemType: 'Requirement',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: Requirement } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      showSuccess(
        'Requirement created',
        `${requirement.itemNumber} has been created successfully`,
      )

      await invalidate('requirements')

      navigate({
        to: '/requirements/$id',
        params: { id: result.data.item.id! },
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create requirement' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/requirements' })
  }

  return (
    <RequirementDetail
      designs={designs}
      defaultDesignId={searchParams.designId}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
