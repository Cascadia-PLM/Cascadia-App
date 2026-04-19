import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import type { Part } from '@/lib/items/types/part'
import type { Design } from '@/lib/types/design'
import { PartDetail } from '@/components/parts/PartDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

// Search schema to accept default designId
const newPartSearchSchema = z.object({
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/parts/new')({
  validateSearch: newPartSearchSchema,
  component: NewPartPage,
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

function NewPartPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const { designs } = Route.useLoaderData()
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (part: Part, branchId?: string) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...part,
        itemType: 'Part',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: Part } }>('/api/items', {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      showSuccess(
        'Part created',
        `${part.itemNumber} has been created successfully`,
      )

      // Navigate to the new part's detail page
      navigate({ to: '/parts/$id', params: { id: result.data.item.id! } })
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
