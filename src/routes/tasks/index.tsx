import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { LayoutGrid, List as ListIcon, Plus } from 'lucide-react'
import type { Task } from '@/lib/items/types/task'
import { PageContainer } from '@/components/layout'
import { TaskTable } from '@/components/tasks/TaskTable'
import { KanbanBoard } from '@/components/tasks/KanbanBoard'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/tasks/')({
  component: TasksListPage,
  loader: async () => {
    try {
      const result = await apiFetch<{
        data: { items: Array<Task>; total: number }
      }>('/api/items?itemType=Task&limit=1000')
      return { tasks: result.data.items }
    } catch (error) {
      console.error('Error loading tasks:', error)
      return { tasks: [] as Array<Task> }
    }
  },
})

function TasksListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { tasks: initialTasks } = Route.useLoaderData()
  const [tasks, setTasks] = useState<Array<Task>>(initialTasks)
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban')

  // Sync local state with loader data when it changes
  useEffect(() => {
    setTasks(initialTasks)
  }, [initialTasks])

  // Navigate to new task page
  const handleEditTask = (task: Task) => {
    // Tasks don't have a detail page, so navigate to the list for now
    // You could create a /tasks/$id page for editing
    if (task.id) {
      navigate({ to: '/tasks/new' })
    }
  }

  const handleTaskUpdate = async (updatedTask: Task) => {
    if (!updatedTask.id) return

    try {
      const result = await apiFetch<{ data: { task: Task } }>(
        `/api/tasks/${updatedTask.id}`,
        {
          method: 'PUT',
          body: JSON.stringify(updatedTask),
        },
      )

      setTasks(
        tasks.map((t) => (t.id === updatedTask.id ? result.data.task : t)),
      )

      // Reload to get fresh data from server
      router.invalidate()
    } catch (error) {
      handleError(error, { title: 'Failed to update task' })
    }
  }

  const handleDeleteTask = (task: Task) => {
    if (!task.id) return

    confirm({
      title: 'Delete Task',
      description: `Are you sure you want to delete ${task.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/tasks/${task.id}`, {
            method: 'DELETE',
          })

          setTasks(tasks.filter((t) => t.id !== task.id))
          showSuccess('Task deleted', `${task.itemNumber} has been deleted`)

          // Reload to get fresh data from server
          router.invalidate()
        } catch (error) {
          handleError(error, { title: 'Failed to delete task' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Tasks
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manage your tasks with the kanban board
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={viewMode === 'kanban' ? 'default' : 'outline'}
            onClick={() => setViewMode('kanban')}
          >
            <LayoutGrid className="h-4 w-4 mr-2" />
            Kanban
          </Button>
          <Button
            variant={viewMode === 'list' ? 'default' : 'outline'}
            onClick={() => setViewMode('list')}
          >
            <ListIcon className="h-4 w-4 mr-2" />
            List
          </Button>
          <Link to="/tasks/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Create Task
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Tasks</CardDescription>
            <CardTitle className="text-3xl">{tasks.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Backlog</CardDescription>
            <CardTitle className="text-3xl">
              {tasks.filter((t) => t.state === 'Backlog').length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>To Do</CardDescription>
            <CardTitle className="text-3xl">
              {tasks.filter((t) => t.state === 'ToDo').length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Progress</CardDescription>
            <CardTitle className="text-3xl">
              {tasks.filter((t) => t.state === 'InProgress').length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">
              {tasks.filter((t) => t.state === 'InReview').length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Done</CardDescription>
            <CardTitle className="text-3xl">
              {tasks.filter((t) => t.state === 'Done').length}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Content - Kanban or List */}
      {viewMode === 'kanban' ? (
        <Card>
          <CardHeader>
            <CardTitle>Kanban Board</CardTitle>
            <CardDescription>
              Drag and drop tasks between columns to update their status
            </CardDescription>
          </CardHeader>
          <CardContent>
            <KanbanBoard
              tasks={tasks}
              onTaskUpdate={handleTaskUpdate}
              onTaskEdit={handleEditTask}
              onTaskDelete={handleDeleteTask}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All Tasks</CardTitle>
            <CardDescription>
              {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} in the
              system
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TaskTable
              items={tasks}
              onEdit={handleEditTask}
              onDelete={handleDeleteTask}
            />
          </CardContent>
        </Card>
      )}
    </PageContainer>
  )
}
