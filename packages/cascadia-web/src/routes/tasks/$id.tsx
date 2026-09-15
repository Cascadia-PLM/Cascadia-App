// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Task } from '@/lib/items/types/task'
import type { TaskDetailTab } from '@/components/tasks/TaskDetail'
import { TASK_DETAIL_TABS, TaskDetail } from '@/components/tasks/TaskDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const taskDetailSearchSchema = z.object({
  tab: z.enum(TASK_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/tasks/$id')({
  component: TaskDetailPage,
  validateSearch: taskDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(entityQuery<Task>('tasks', params.id, 'task')),
})

function TaskDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: task } = useQuery(entityQuery<Task>('tasks', id, 'task'))
  const search = Route.useSearch()

  if (!task) return null

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
    await invalidate('tasks')
  }

  const handleDelete = async () => {
    if (!task.id) return

    await apiFetch(`/api/v1/tasks/${task.id}`, {
      method: 'DELETE',
    })

    showSuccess('Task deleted', `${task.itemNumber} has been deleted`)
    await invalidate('tasks')
    navigate({ to: '/tasks' })
  }

  const handleCancel = () => {
    navigate({ to: '/tasks' })
  }

  const handleTabChange = (tab: TaskDetailTab) => {
    router.navigate({
      to: '/tasks/$id',
      params: { id: task.id ?? '' },
      search: {
        tab,
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
      onTransitioned={() => void invalidate('tasks')}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
