import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { Task } from '@/lib/items/types/task'
import { TaskDetail } from '@/components/tasks/TaskDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const taskDetailSearchSchema = z.object({
  tab: z.enum(['details', 'history']).optional().default('details'),
})

export const Route = createFileRoute('/tasks/$id')({
  component: TaskDetailPage,
  validateSearch: taskDetailSearchSchema,
  loader: async ({ params }) => {
    try {
      const result = await apiFetch<{ data: { task: Task } }>(
        `/api/v1/tasks/${params.id}`,
      )
      return { task: result.data.task }
    } catch (error) {
      console.error('Error loading task:', error)
      throw error
    }
  },
})

function TaskDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const { task } = Route.useLoaderData()
  const search = Route.useSearch()

  const handleSave = async (updatedTask: Task) => {
    if (!task.id) return

    await apiFetch(`/api/v1/tasks/${task.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedTask),
    })

    showSuccess(
      'Task updated',
      `${updatedTask.itemNumber} has been updated successfully`,
    )
    router.invalidate()
  }

  const handleDelete = async () => {
    if (!task.id) return

    await apiFetch(`/api/v1/tasks/${task.id}`, {
      method: 'DELETE',
    })

    showSuccess('Task deleted', `${task.itemNumber} has been deleted`)
    await router.invalidate()
    navigate({ to: '/tasks' })
  }

  const handleCancel = () => {
    navigate({ to: '/tasks' })
  }

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/tasks/$id',
      params: { id: task.id ?? '' },
      search: {
        tab: tab as 'details' | 'history',
      },
      replace: true,
    })
  }

  return (
    <TaskDetail
      task={task}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
