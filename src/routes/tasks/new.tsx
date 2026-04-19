import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { Task } from '@/lib/items/types/task'
import { TaskDetail } from '@/components/tasks/TaskDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/tasks/new')({
  component: NewTaskPage,
})

function NewTaskPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (task: Task) => {
    setIsSubmitting(true)
    try {
      const payload = { ...task, itemType: 'Task' }
      const result = await apiFetch<{ data: { item: Task } }>('/api/items', {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      showSuccess(
        'Task created',
        `${task.itemNumber} has been created successfully`,
      )
      navigate({ to: '/tasks/$id', params: { id: result.data.item.id! } })
    } catch (error) {
      handleError(error, { title: 'Failed to create task' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/tasks' })
  }

  return (
    <TaskDetail
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
