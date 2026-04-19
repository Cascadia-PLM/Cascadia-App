import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import type { Document } from '@/lib/items/types/document'
import type { Design } from '@/lib/types/design'
import { DocumentDetail } from '@/components/documents/DocumentDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const newDocumentSearchSchema = z.object({
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/documents/new')({
  validateSearch: newDocumentSearchSchema,
  component: NewDocumentPage,
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

function NewDocumentPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const { designs } = Route.useLoaderData()
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (document: Document, branchId?: string) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...document,
        itemType: 'Document',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: Document } }>(
        '/api/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      showSuccess(
        'Document created',
        `${document.itemNumber} has been created successfully`,
      )
      navigate({ to: '/documents/$id', params: { id: result.data.item.id! } })
    } catch (error) {
      handleError(error, { title: 'Failed to create document' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/documents' })
  }

  return (
    <DocumentDetail
      designs={designs}
      defaultDesignId={searchParams.designId}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
