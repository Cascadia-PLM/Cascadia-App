import { useForm } from '@tanstack/react-form'
import type { WorkInstruction } from '@/lib/items/types/work-instruction'
import { workInstructionSchema } from '@/lib/items/types/work-instruction'
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

interface WorkInstructionFormProps {
  workInstruction?: Partial<WorkInstruction>
  onSubmit: (data: WorkInstruction) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function WorkInstructionForm({
  workInstruction,
  onSubmit,
  onCancel,
  isSubmitting,
}: WorkInstructionFormProps) {
  const form = useForm({
    defaultValues: {
      itemType: 'WorkInstruction' as const,
      state: 'Draft',
      revision: 'A',
      itemNumber: '',
      name: '',
      description: '',
      estimatedTime: undefined as number | undefined,
      difficulty: undefined as 'Easy' | 'Medium' | 'Hard' | undefined,
      safetyNotes: '',
      requiredTools: '',
      ...workInstruction,
    },
    onSubmit: async ({ value }) => {
      const submissionData = {
        ...value,
        itemNumber: value.itemNumber || undefined,
        revision: value.revision.trim() || 'A',
      } as WorkInstruction

      // Validate after transforming empty strings to undefined
      const result = workInstructionSchema.safeParse(submissionData)
      if (!result.success) {
        throw result.error
      }

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
              label="Work Instruction Number"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Leave blank to auto-generate (e.g., WI-000001)"
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
              label="Work Instruction Name"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Assembly Procedure for Motor Housing"
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
                value={field.state.value || ''}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Brief summary of the work instruction..."
                rows={3}
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
                  <SelectItem value="Draft">Draft</SelectItem>
                  <SelectItem value="InReview">In Review</SelectItem>
                  <SelectItem value="Approved">Approved</SelectItem>
                  <SelectItem value="Released">Released</SelectItem>
                  <SelectItem value="Obsolete">Obsolete</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Difficulty */}
        <form.Field name="difficulty">
          {(field) => (
            <FormField
              label="Difficulty"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value || ''}
                onValueChange={(value) =>
                  field.handleChange(value as 'Easy' | 'Medium' | 'Hard')
                }
              >
                <SelectTrigger error={!!field.state.meta.errors.length}>
                  <SelectValue placeholder="Select difficulty" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Easy">Easy</SelectItem>
                  <SelectItem value="Medium">Medium</SelectItem>
                  <SelectItem value="Hard">Hard</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Estimated Time */}
        <form.Field name="estimatedTime">
          {(field) => (
            <FormField
              label="Estimated Time (minutes)"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value?.toString() || ''}
                onChange={(e) => {
                  const val = e.target.value
                  field.handleChange(val ? parseInt(val, 10) : undefined)
                }}
                onBlur={field.handleBlur}
                type="number"
                min="0"
                placeholder="30"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Required Tools */}
        <form.Field name="requiredTools">
          {(field) => (
            <FormField
              label="Required Tools"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value || ''}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Screwdriver, Torque wrench, Safety glasses"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Safety Notes */}
        <form.Field name="safetyNotes">
          {(field) => (
            <FormField
              label="Safety Notes"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value || ''}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Important safety considerations for this procedure..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>
      </div>

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
            : workInstruction?.id
              ? 'Update Work Instruction'
              : 'Create Work Instruction'}
        </Button>
      </div>
    </form>
  )
}
