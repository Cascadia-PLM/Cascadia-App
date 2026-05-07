import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { Tool } from '@/lib/items/types/tool'
import { ToolDetail } from '@/components/tools/ToolDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/tools/new')({
  component: NewToolPage,
})

function NewToolPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (tool: Tool) => {
    setIsSubmitting(true)
    try {
      const payload = { ...tool, itemType: 'Tool' }
      const result = await apiFetch<{ data: { item: Tool } }>('/api/v1/items', {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      showSuccess(
        'Tool created',
        `${tool.name || 'Tool'} has been created successfully`,
      )
      navigate({ to: '/tools/$id', params: { id: result.data.item.id! } })
    } catch (error) {
      handleError(error, { title: 'Failed to create tool' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/tools' })
  }

  return (
    <ToolDetail
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
