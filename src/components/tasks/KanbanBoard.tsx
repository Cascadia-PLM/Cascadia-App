import { useState } from 'react'
import { Calendar, Clock, Edit, Trash2, User } from 'lucide-react'
import type { Task } from '@/lib/items/types/task'
import { Badge, Button, Card, CardContent, CardHeader } from '@/components/ui'

interface KanbanBoardProps {
  tasks: Array<Task>
  onTaskUpdate?: (task: Task) => void
  onTaskEdit?: (task: Task) => void
  onTaskDelete?: (task: Task) => void
}

const COLUMNS = [
  { id: 'Backlog', name: 'Backlog', color: 'bg-slate-100 dark:bg-slate-800' },
  { id: 'ToDo', name: 'To Do', color: 'bg-blue-100 dark:bg-blue-900/30' },
  {
    id: 'InProgress',
    name: 'In Progress',
    color: 'bg-yellow-100 dark:bg-yellow-900/30',
  },
  {
    id: 'InReview',
    name: 'In Review',
    color: 'bg-purple-100 dark:bg-purple-900/30',
  },
  { id: 'Done', name: 'Done', color: 'bg-green-100 dark:bg-green-900/30' },
]

const priorityColors: Record<string, string> = {
  Low: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
  Medium: 'bg-blue-200 text-blue-700 dark:bg-blue-700 dark:text-blue-300',
  High: 'bg-orange-200 text-orange-700 dark:bg-orange-700 dark:text-orange-300',
  Critical: 'bg-red-200 text-red-700 dark:bg-red-700 dark:text-red-300',
}

export function KanbanBoard({
  tasks,
  onTaskUpdate,
  onTaskEdit,
  onTaskDelete,
}: KanbanBoardProps) {
  const [draggedTask, setDraggedTask] = useState<Task | null>(null)

  const handleDragStart = (task: Task) => {
    setDraggedTask(task)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (columnId: string) => {
    if (draggedTask && draggedTask.state !== columnId) {
      const updatedTask = { ...draggedTask, state: columnId }
      onTaskUpdate?.(updatedTask)
    }
    setDraggedTask(null)
  }

  const getTasksByColumn = (columnId: string) => {
    return tasks.filter((task) => task.state === columnId)
  }

  const formatDate = (date?: string | Date) => {
    if (!date) return null
    try {
      return new Date(date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
    } catch {
      return null
    }
  }

  const isOverdue = (dueDate?: string | Date) => {
    if (!dueDate) return false
    return new Date(dueDate) < new Date()
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {COLUMNS.map((column) => {
        const columnTasks = getTasksByColumn(column.id)
        return (
          <div
            key={column.id}
            className="flex-shrink-0 w-80"
            onDragOver={handleDragOver}
            onDrop={() => handleDrop(column.id)}
          >
            {/* Column Header */}
            <div className={`${column.color} rounded-t-lg p-3 border-b`}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-900 dark:text-white">
                  {column.name}
                </h3>
                <Badge variant="secondary" className="text-xs">
                  {columnTasks.length}
                </Badge>
              </div>
            </div>

            {/* Column Content */}
            <div className="bg-slate-50 dark:bg-slate-900 rounded-b-lg p-3 min-h-[600px] space-y-3">
              {columnTasks.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">
                  No tasks
                </p>
              ) : (
                columnTasks.map((task) => (
                  <Card
                    key={task.id}
                    draggable
                    onDragStart={() => handleDragStart(task)}
                    className="cursor-move hover:shadow-lg transition-shadow bg-white dark:bg-slate-800"
                  >
                    <CardHeader className="p-3 pb-2">
                      {/* Task Header */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm text-slate-900 dark:text-white truncate">
                            {task.name || task.itemNumber}
                          </h4>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            {task.itemNumber}
                          </p>
                        </div>
                        {task.priority && (
                          <Badge
                            className={`text-xs ${priorityColors[task.priority] || ''}`}
                          >
                            {task.priority}
                          </Badge>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="p-3 pt-0 space-y-2">
                      {/* Description */}
                      {task.description && (
                        <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2">
                          {task.description}
                        </p>
                      )}

                      {/* Task Metadata */}
                      <div className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                        {/* Due Date */}
                        {task.dueDate && (
                          <div className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            <span
                              className={
                                isOverdue(task.dueDate)
                                  ? 'text-red-600 dark:text-red-400 font-medium'
                                  : ''
                              }
                            >
                              {formatDate(task.dueDate)}
                            </span>
                          </div>
                        )}

                        {/* Estimated Hours */}
                        {task.estimatedHours && (
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            <span>{task.estimatedHours}h estimated</span>
                          </div>
                        )}

                        {/* Assignee */}
                        {task.assignee && (
                          <div className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            <span className="truncate">
                              {task.assignee.slice(0, 8)}...
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Tags */}
                      {task.tags && task.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {task.tags.map((tag, idx) => (
                            <Badge
                              key={idx}
                              variant="secondary"
                              className="text-xs"
                            >
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex gap-1 pt-2 border-t">
                        {onTaskEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onTaskEdit(task)}
                            className="flex-1 h-7 text-xs"
                          >
                            <Edit className="h-3 w-3 mr-1" />
                            Edit
                          </Button>
                        )}
                        {onTaskDelete && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onTaskDelete(task)}
                            className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
