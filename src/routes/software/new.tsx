import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import type { Software } from '@/lib/items/types/software'
import type { Design } from '@/lib/types/design'
import { SoftwareDetail } from '@/components/software/SoftwareDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

// Search schema to accept default designId
const newSoftwareSearchSchema = z.object({
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/software/new')({
  validateSearch: newSoftwareSearchSchema,
  component: NewSoftwarePage,
  loader: async () => {
    try {
      const result = await apiFetch<{ data: { designs: Array<Design> } }>(
        '/api/v1/designs',
      )
      return { designs: result.data.designs }
    } catch (error) {
      console.error('Error loading designs:', error)
      return { designs: [] as Array<Design> }
    }
  },
})

function NewSoftwarePage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const { designs } = Route.useLoaderData()
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (software: Software) => {
    setIsSubmitting(true)
    try {
      const payload = { ...software, itemType: 'Software' }
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
