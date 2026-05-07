import { useForm } from '@tanstack/react-form'
import { useState } from 'react'
import type { Issue } from '@/lib/items/types/issue'
import { issueSchema } from '@/lib/items/types/issue'
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

interface IssueFormProps {
  issue?: Partial<Issue>
  onSubmit: (data: Issue) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function IssueForm({
  issue,
  onSubmit,
  onCancel,
  isSubmitting,
}: IssueFormProps) {
  const [attributes, setAttributes] = useState<Record<string, string>>(
    issue?.attributes ?? {},
  )
  const form = useForm({
    defaultValues: {
      itemType: 'Issue' as const,
      state: 'Open',
      revision: 'A',
      severity: 'Medium' as const,
      priority: 'Medium' as const,
      itemNumber: '',
      name: '',
      description: '',
      category: undefined as string | undefined,
      assignedTo: '',
      resolution: '',
      rootCause: '',
      programId: '',
      ...issue,
    },
    validators: {
      onSubmit: zodValidator(issueSchema),
    },
    onSubmit: async ({ value }) => {
      const submissionData = {
        ...value,
        revision: value.revision.trim() || 'A',
        attributes,
      } as Issue
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
              label="Issue Number"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Leave blank to auto-generate (e.g., ISS-000001)"
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
              label="Issue Title"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Brief title describing the issue"
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
                placeholder="Detailed description of the issue..."
                rows={4}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Severity */}
        <form.Field name="severity">
          {(field) => (
            <FormField
              label="Severity"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(
                    value as 'Critical' | 'High' | 'Medium' | 'Low',
                  )
                }
              >
                <SelectTrigger error={!!field.state.meta.errors.length}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Critical">Critical</SelectItem>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Medium">Medium</SelectItem>
                  <SelectItem value="Low">Low</SelectItem>
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
                    value as 'Critical' | 'High' | 'Medium' | 'Low',
                  )
                }
              >
                <SelectTrigger error={!!field.state.meta.errors.length}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Critical">Critical</SelectItem>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Medium">Medium</SelectItem>
                  <SelectItem value="Low">Low</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Category */}
        <form.Field name="category">
          {(field) => (
            <FormField
              label="Category"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value || ''}
                onValueChange={(value) =>
                  field.handleChange(value || undefined)
                }
              >
                <SelectTrigger error={!!field.state.meta.errors.length}>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Design">Design</SelectItem>
                  <SelectItem value="Manufacturing">Manufacturing</SelectItem>
                  <SelectItem value="Quality">Quality</SelectItem>
                  <SelectItem value="Customer">Customer</SelectItem>
                  <SelectItem value="Safety">Safety</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
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
                  <SelectItem value="Open">Open</SelectItem>
                  <SelectItem value="InProgress">In Progress</SelectItem>
                  <SelectItem value="Pending">Pending</SelectItem>
                  <SelectItem value="Resolved">Resolved</SelectItem>
                  <SelectItem value="Verified">Verified</SelectItem>
                  <SelectItem value="Closed">Closed</SelectItem>
                  <SelectItem value="Cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Assigned To */}
        <form.Field name="assignedTo">
          {(field) => (
            <FormField
              label="Assigned To"
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

        {/* Root Cause */}
        <form.Field name="rootCause">
          {(field) => (
            <FormField
              label="Root Cause"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Root cause analysis..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Resolution */}
        <form.Field name="resolution">
          {(field) => (
            <FormField
              label="Resolution"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="How the issue was resolved..."
                rows={3}
                error={!!field.state.meta.errors.length}
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
            : issue?.id
              ? 'Update Issue'
              : 'Create Issue'}
        </Button>
      </div>
    </form>
  )
}
