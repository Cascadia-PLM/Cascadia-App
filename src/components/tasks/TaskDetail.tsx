import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Calendar,
  Clock,
  Edit,
  Save,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react'
import type { Task } from '@/lib/items/types/task'
import { PageContainer } from '@/components/layout'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ViewEditBadge,
  ViewEditNumber,
  ViewEditSelect,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const STATE_OPTIONS = [
  { value: 'Backlog', label: 'Backlog' },
  { value: 'ToDo', label: 'To Do' },
  { value: 'InProgress', label: 'In Progress' },
  { value: 'InReview', label: 'In Review' },
  { value: 'Done', label: 'Done' },
  { value: 'Cancelled', label: 'Cancelled' },
]

const PRIORITY_OPTIONS = [
  { value: 'Low', label: 'Low' },
  { value: 'Medium', label: 'Medium' },
  { value: 'High', label: 'High' },
  { value: 'Critical', label: 'Critical' },
]

const stateVariant = (state: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Backlog: 'secondary',
    ToDo: 'default',
    InProgress: 'warning',
    InReview: 'default',
    Done: 'success',
    Cancelled: 'destructive',
  }
  return variants[state] || 'default'
}

const priorityVariant = (priority: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Low: 'secondary',
    Medium: 'default',
    High: 'warning',
    Critical: 'destructive',
  }
  return variants[priority] || 'default'
}

const createEmptyTask = (): Task => ({
  id: undefined,
  masterId: undefined,
  itemNumber: '',
  revision: 'A',
  name: '',
  description: '',
  state: 'Backlog',
  isCurrent: true,
  priority: 'Medium',
  assignee: undefined,
  dueDate: undefined,
  estimatedHours: undefined,
  actualHours: undefined,
  tags: [],
  programId: undefined,
  designId: undefined,
  createdAt: undefined,
  modifiedAt: undefined,
})

interface TaskDetailProps {
  task?: Task
  onSave: (task: Task) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: 'details' | 'history'
  onTabChange?: (tab: string) => void
}

export function TaskDetail({
  task: initialTask,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: TaskDetailProps) {
  const router = useRouter()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  const isCreateMode = !initialTask?.id

  const [task, setTask] = useState<Task>(() => initialTask || createEmptyTask())
  const [isEditing, setIsEditing] = useState(isCreateMode)

  const [displayedTask, setDisplayedTask] = useState<Task>(task)

  const { context, setContext } = useVersionContext(
    isCreateMode ? undefined : task.designId,
  )

  useEffect(() => {
    if (initialTask) {
      setTask(initialTask)
      setDisplayedTask(initialTask)
    }
  }, [initialTask])

  useEffect(() => {
    async function fetchVersionAtContext() {
      if (isCreateMode || !task.designId || context.type === 'main') {
        setDisplayedTask(task)
        return
      }

      try {
        const params = new URLSearchParams()
        if (context.type === 'commit' && context.commitId)
          params.set('commitId', context.commitId)
        else if (context.type === 'tag' && context.tagId)
          params.set('tagId', context.tagId)
        else if (context.type === 'branch' && context.branchId)
          params.set('branchId', context.branchId)

        const queryString = params.toString()
        if (!queryString) {
          setDisplayedTask(task)
          return
        }

        const response = await apiFetch<{ data: { item: Task | null } }>(
          `/api/v1/items/${task.id}/at-context?${queryString}`,
        )
        setDisplayedTask(response.data.item || task)
      } catch {
        setDisplayedTask(task)
      }
    }
    fetchVersionAtContext()
  }, [task, context, isCreateMode])

  const currentTask = isCreateMode ? task : displayedTask

  const updateField = (field: keyof Task, value: any) => {
    setTask((prev) => ({ ...prev, [field]: value }))
  }

  const handleEdit = () => {
    setTask(currentTask)
    setIsEditing(true)
  }

  const handleSave = async () => {
    await onSave(task)
    if (!isCreateMode) setIsEditing(false)
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      setTask(currentTask)
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentTask.id) return
    confirm({
      title: 'Delete Task',
      description: `Are you sure you want to delete ${currentTask.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: onDelete,
    })
  }

  const formatDate = (date?: string | Date) => {
    if (!date) return '-'
    try {
      return new Date(date).toLocaleDateString()
    } catch {
      return '-'
    }
  }

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/tasks">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              {isCreateMode ? 'Create New Task' : currentTask.itemNumber}
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {isCreateMode
                ? 'Enter the details for the new task'
                : currentTask.name || 'Unnamed'}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          {isEditing ? (
            <>
              <Button
                variant="outline"
                onClick={handleCancelEdit}
                disabled={isSubmitting}
              >
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSubmitting}>
                <Save className="h-4 w-4 mr-2" />
                {isSubmitting
                  ? 'Saving...'
                  : isCreateMode
                    ? 'Create Task'
                    : 'Save Changes'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleEdit}>
                <Edit className="h-4 w-4 mr-2" />
                Edit
              </Button>
              {onDelete && (
                <Button variant="destructive" onClick={handleDelete}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {!isCreateMode && (
        <div className="flex gap-2">
          <Badge
            variant={stateVariant(currentTask.state ?? 'Backlog')}
            className="text-sm"
          >
            {currentTask.state ?? 'Backlog'}
          </Badge>
          {currentTask.priority && (
            <Badge
              variant={priorityVariant(currentTask.priority)}
              className="text-sm"
            >
              {currentTask.priority} Priority
            </Badge>
          )}
        </div>
      )}

      <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="Item Number"
                      value={
                        isEditing ? task.itemNumber : currentTask.itemNumber
                      }
                      onChange={(v) => updateField('itemNumber', v)}
                      isEditing={isEditing && isCreateMode}
                      placeholder="TASK-001"
                      required
                    />
                    <ViewEditText
                      label="Name"
                      value={isEditing ? task.name : currentTask.name}
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="Task name"
                      required
                    />
                    <ViewEditBadge
                      label="State"
                      value={isEditing ? task.state : currentTask.state}
                      onChange={(v) => updateField('state', v)}
                      isEditing={isEditing}
                      options={STATE_OPTIONS}
                      variant={stateVariant}
                    />
                    <ViewEditBadge
                      label="Priority"
                      value={isEditing ? task.priority : currentTask.priority}
                      onChange={(v) => updateField('priority', v)}
                      isEditing={isEditing}
                      options={PRIORITY_OPTIONS}
                      variant={priorityVariant}
                    />
                    <ViewEditTextarea
                      label="Description"
                      value={
                        isEditing ? task.description : currentTask.description
                      }
                      onChange={(v) => updateField('description', v)}
                      isEditing={isEditing}
                      placeholder="Task description"
                      className="md:col-span-2"
                    />
                  </dl>
                </CardContent>
              </Card>

              {(currentTask.tags && currentTask.tags.length > 0) ||
              isEditing ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Tags</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isEditing ? (
                      <ViewEditText
                        label="Tags (comma-separated)"
                        value={task.tags.join(', ')}
                        onChange={(v) =>
                          updateField(
                            'tags',
                            v
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean),
                          )
                        }
                        isEditing={isEditing}
                        placeholder="tag1, tag2, tag3"
                      />
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {currentTask.tags?.map((tag, idx) => (
                          <Badge key={idx} variant="secondary">
                            <Tag className="h-3 w-3 mr-1" />
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : null}
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Assignment</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ViewEditText
                    label="Assignee"
                    value={isEditing ? task.assignee : currentTask.assignee}
                    onChange={(v) => updateField('assignee', v)}
                    isEditing={isEditing}
                    placeholder="user@example.com"
                  />
                  <ViewEditText
                    label="Due Date"
                    value={
                      isEditing
                        ? task.dueDate
                          ? new Date(task.dueDate).toISOString().split('T')[0]
                          : ''
                        : formatDate(currentTask.dueDate)
                    }
                    onChange={(v) => updateField('dueDate', v)}
                    isEditing={isEditing}
                    placeholder="YYYY-MM-DD"
                  />
                  <ViewEditNumber
                    label="Estimated Hours"
                    value={
                      isEditing
                        ? task.estimatedHours
                        : currentTask.estimatedHours
                    }
                    onChange={(v) =>
                      updateField(
                        'estimatedHours',
                        v ? parseFloat(v) : undefined,
                      )
                    }
                    isEditing={isEditing}
                    unit="hours"
                    step="0.5"
                  />
                  <ViewEditNumber
                    label="Actual Hours"
                    value={
                      isEditing ? task.actualHours : currentTask.actualHours
                    }
                    onChange={(v) =>
                      updateField('actualHours', v ? parseFloat(v) : undefined)
                    }
                    isEditing={isEditing}
                    unit="hours"
                    step="0.5"
                  />
                </CardContent>
              </Card>

              <Collapsible defaultOpen={false}>
                <Card>
                  <CardHeader>
                    <CollapsibleTrigger className="hover:opacity-70">
                      <CardTitle>Metadata</CardTitle>
                    </CollapsibleTrigger>
                  </CardHeader>
                  <CollapsibleContent>
                    <CardContent className="space-y-3">
                      <ViewEditStatic
                        label="Revision"
                        value={currentTask.revision}
                      />
                      <ViewEditStatic
                        label="Created"
                        value={formatDate(currentTask.createdAt)}
                      />
                      <ViewEditStatic
                        label="Last Modified"
                        value={formatDate(currentTask.modifiedAt)}
                      />
                      {!isCreateMode && (
                        <ViewEditStatic
                          label="Task ID"
                          value={currentTask.id}
                          mono
                        />
                      )}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          {currentTask.id ? (
            <ItemHistoryTab
              itemId={currentTask.id}
              designId={currentTask.designId ?? null}
              versionContext={context}
              onViewHistoricalState={setContext}
            />
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-slate-500">
                  Save the task first to view history
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </PageContainer>
  )
}
