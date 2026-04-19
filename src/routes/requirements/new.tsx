import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import type { Requirement } from '@/lib/items/types/requirement'
import type { Design } from '@/lib/types/design'
import { RequirementDetail } from '@/components/requirements/RequirementDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const newRequirementSearchSchema = z.object({
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/requirements/new')({
  validateSearch: newRequirementSearchSchema,
  component: NewRequirementPage,
  loader: async () => {
    try {
      const result = await apiFetch<{ data: { designs: Array<Design> } }>(
        '/api/designs',
      )
      return { designs: result.data.designs }
    } catch (error) {
      console.error('Error loading designs:', error)
      return { designs: [] as Array<Design> }
    }
  },
})

function NewRequirementPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const { designs } = Route.useLoaderData()
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (requirement: Requirement) => {
    setIsSubmitting(true)
    try {
      const payload = { ...requirement, itemType: 'Requirement' }
      const result = await apiFetch<{ data: { item: Requirement } }>(
        '/api/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      showSuccess(
        'Requirement created',
        `${requirement.itemNumber} has been created successfully`,
      )
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
