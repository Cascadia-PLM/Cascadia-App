import { useForm } from '@tanstack/react-form'
import { useState } from 'react'
import type { Task } from '@/lib/items/types/task'
import { taskSchema } from '@/lib/items/types/task'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { zodValidator } from '@/lib/form-validation'
import {
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'

interface TaskFormProps {
  task?: Partial<Task>
  onSubmit: (data: Task) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function TaskForm({
  task,
  onSubmit,
  onCancel,
  isSubmitting,
}: TaskFormProps) {
  const [attributes, setAttributes] = useState<Record<string, string>>(
    (task?.attributes as Record<string, string>) ?? {},
  )
  const form = useForm({
    defaultValues: {
      itemType: 'Task' as const,
      state: 'Backlog',
      revision: 'A',
      priority: 'Medium' as const,
      itemNumber: '',
      name: '',
      description: '',
      projectId: '',
      assignee: '',
      dueDate: '',
      estimatedHours: '',
      actualHours: '',
      tags: [] as Array<string>,
      ...task,
    },
    validators: {
      onSubmit: zodValidator(taskSchema),
    },
    onSubmit: async ({ value }) => {
      const submissionData = {
        ...value,
        revision: value.revision.trim() || 'A',
        attributes,
      } as Task
      await onSubmit(submissionData)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Item Number */}
        <form.Field name="itemNumber">
          {(field) => (
            <FormField
              label="Task Number"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Leave blank to auto-generate (e.g., TSK-000001)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Auto-generated if blank"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Revision */}
        <form.Field name="revision">
          {(field) => (
            <FormField
              label="Revision"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Version identifier (A, B, C, etc.)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="A"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Name */}
        <form.Field name="name">
          {(field) => (
            <FormField
              label="Task Name"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Implement user authentication"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Description */}
        <form.Field name="description">
          {(field) => (
            <FormField
              label="Description"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Detailed task description..."
                rows={4}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* State */}
        <form.Field name="state">
          {(field) => (
            <FormField
              label="State"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value)}
              >
                <SelectTrigger error={!!field.state.meta.errors.length}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Backlog">Backlog</SelectItem>
                  <SelectItem value="ToDo">To Do</SelectItem>
                  <SelectItem value="InProgress">In Progress</SelectItem>
                  <SelectItem value="InReview">In Review</SelectItem>
                  <SelectItem value="Done">Done</SelectItem>
                  <SelectItem value="Cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Priority */}
        <form.Field name="priority">
          {(field) => (
            <FormField
              label="Priority"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(
                    value as 'Low' | 'Medium' | 'High' | 'Critical',
                  )
                }
              >
                <SelectTrigger error={!!field.state.meta.errors.length}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Low">Low</SelectItem>
                  <SelectItem value="Medium">Medium</SelectItem>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Project ID */}
        <form.Field name="projectId">
          {(field) => (
            <FormField
              label="Project ID"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="UUID of the project this task belongs to"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="project-uuid..."
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Assignee */}
        <form.Field name="assignee">
          {(field) => (
            <FormField
              label="Assignee"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="UUID of the assigned user"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="user-uuid..."
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Due Date */}
        <form.Field name="dueDate">
          {(field) => (
            <FormField
              label="Due Date"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={
                  field.state.value instanceof Date
                    ? field.state.value.toISOString().slice(0, 16)
                    : field.state.value
                }
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                type="datetime-local"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Estimated Hours */}
        <form.Field name="estimatedHours">
          {(field) => (
            <FormField
              label="Estimated Hours"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                type="number"
                step="0.5"
                placeholder="8.0"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Actual Hours */}
        <form.Field name="actualHours">
          {(field) => (
            <FormField
              label="Actual Hours"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                type="number"
                step="0.5"
                placeholder="7.5"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Tags */}
        <form.Field name="tags">
          {(field) => (
            <FormField
              label="Tags"
              helpText="Comma-separated tags"
              className="md:col-span-2"
            >
              <Input
                placeholder="frontend, urgent, bug-fix"
                onChange={(e) => {
                  const tags = e.target.value
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean)
                  field.handleChange(tags)
                }}
                defaultValue={field.state.value.join(', ') || ''}
              />
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Custom Attributes */}
      <AttributesEditor
        value={attributes}
        onChange={setAttributes}
        disabled={isSubmitting}
      />

      {/* Actions */}
      <div className="flex gap-3 justify-end pt-4 border-t">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? 'Saving...'
            : task?.id
              ? 'Update Task'
              : 'Create Task'}
        </Button>
      </div>
    </form>
  )
}
