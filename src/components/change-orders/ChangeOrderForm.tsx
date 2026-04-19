import { useForm } from '@tanstack/react-form'
import { useState } from 'react'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import { changeOrderSchema } from '@/lib/items/types/change-order'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { zodValidator } from '@/lib/form-validation'
import {
  Button,
  Checkbox,
  FormField,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'

interface ChangeOrderFormProps {
  changeOrder?: Partial<ChangeOrder>
  onSubmit: (data: ChangeOrder) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function ChangeOrderForm({
  changeOrder,
  onSubmit,
  onCancel,
  isSubmitting,
}: ChangeOrderFormProps) {
  const [attributes, setAttributes] = useState<Record<string, string>>(
    (changeOrder?.attributes as Record<string, string>) ?? {},
  )
  const form = useForm({
    defaultValues: {
      itemType: 'ChangeOrder' as const,
      state: 'Draft',
      revision: 'A',
      changeType: 'ECO' as const,
      priority: 'medium' as const,
      itemNumber: '',
      name: '',
      reasonForChange: '',
      impactDescription: '',
      implementationDate: '',
      isBaseline: false,
      baselineName: '',
      ...changeOrder,
    },
    validators: {
      onSubmit: zodValidator(changeOrderSchema),
    },
    onSubmit: async ({ value }) => {
      // Convert empty strings to undefined for optional fields
      // Zod's .optional() allows undefined but not empty strings
      const submissionData = {
        ...value,
        revision: value.revision.trim() || 'A',
        itemNumber: value.itemNumber.trim() || undefined,
        name: value.name.trim() || undefined,
        reasonForChange: value.reasonForChange.trim() || undefined,
        impactDescription: value.impactDescription.trim() || undefined,
        implementationDate: value.implementationDate || undefined,
        baselineName: value.baselineName.trim() || undefined,
        attributes,
      } as ChangeOrder
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
      data-testid="change-order-form"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Item Number - Always auto-generated for Change Orders */}
        <FormField
          label="Change Order Number"
          helpText="Will be auto-generated (e.g., ECO-000001)"
        >
          <div className="flex items-center h-10 px-3 rounded-md border border-input bg-muted text-muted-foreground">
            Auto-generated on creation
          </div>
        </FormField>

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
              label="Name"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
              helpText="Brief description of the change"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Widget material change from steel to aluminum"
                error={!!field.state.meta.errors.length}
                data-testid="change-order-name"
              />
            </FormField>
          )}
        </form.Field>

        {/* Change Type */}
        <form.Field name="changeType">
          {(field) => (
            <FormField
              label="Change Type"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="ECO: Engineering Change Order, ECN: Engineering Change Notice, MCO: Manufacturing Change Order"
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(
                    value as 'ECO' | 'ECN' | 'MCO' | 'Deviation' | 'XCO',
                  )
                }
              >
                <SelectTrigger error={!!field.state.meta.errors.length}>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ECO">
                    ECO - Engineering Change Order
                  </SelectItem>
                  <SelectItem value="ECN">
                    ECN - Engineering Change Notice
                  </SelectItem>
                  <SelectItem value="MCO">
                    MCO - Manufacturing Change Order
                  </SelectItem>
                  <SelectItem value="Deviation">Deviation</SelectItem>
                  <SelectItem value="XCO">
                    XCO - Flexible Change Order
                  </SelectItem>
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
              helpText="Impact urgency level"
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(
                    value as 'low' | 'medium' | 'high' | 'critical',
                  )
                }
              >
                <SelectTrigger error={!!field.state.meta.errors.length}>
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Reason for Change */}
        <form.Field name="reasonForChange">
          {(field) => (
            <FormField
              label="Reason for Change"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
              helpText="Explain why this change is necessary"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Describe the problem, opportunity, or requirement driving this change..."
                rows={4}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Impact Description */}
        <form.Field name="impactDescription">
          {(field) => (
            <FormField
              label="Impact Description"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
              helpText="Describe expected impacts (will be refined by impact assessment)"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Describe expected impacts on design, manufacturing, cost, schedule..."
                rows={4}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Implementation Date */}
        <form.Field name="implementationDate">
          {(field) => (
            <FormField
              label="Target Implementation Date"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="When this change should be implemented"
            >
              <Input
                name={field.name}
                value={
                  field.state.value instanceof Date
                    ? field.state.value.toISOString().split('T')[0]
                    : field.state.value
                }
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                type="date"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Baseline Section */}
      <div className="border rounded-lg p-4 bg-slate-50 dark:bg-slate-900">
        <div className="space-y-4">
          <form.Field name="isBaseline">
            {(field) => (
              <div className="flex items-center gap-3">
                <Checkbox
                  id="isBaseline"
                  checked={field.state.value}
                  onCheckedChange={(checked) =>
                    field.handleChange(checked === true)
                  }
                />
                <Label
                  htmlFor="isBaseline"
                  className="font-medium cursor-pointer"
                >
                  Create baseline on release
                </Label>
              </div>
            )}
          </form.Field>

          <form.Field name="isBaseline">
            {(isBaselineField) =>
              isBaselineField.state.value && (
                <form.Field name="baselineName">
                  {(field) => (
                    <FormField
                      label="Baseline Name"
                      required
                      error={field.state.meta.errors[0] as string | undefined}
                      helpText="Name for the baseline/tag (e.g., PDR, CDR, Rev A Release)"
                    >
                      <Input
                        name={field.name}
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        placeholder="e.g., PDR, CDR, Production Release"
                        error={!!field.state.meta.errors.length}
                      />
                    </FormField>
                  )}
                </form.Field>
              )
            }
          </form.Field>

          <p className="text-sm text-muted-foreground">
            When enabled, releasing this ECO will create a named baseline (tag)
            on all affected designs, marking the exact state of the design at
            the time of release.
          </p>
        </div>
      </div>

      {/* Custom Attributes */}
      <AttributesEditor
        value={attributes}
        onChange={setAttributes}
        disabled={isSubmitting}
      />

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t">
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
        <Button
          type="submit"
          disabled={isSubmitting}
          data-testid="change-order-submit"
        >
          {isSubmitting
            ? 'Saving...'
            : changeOrder?.id
              ? 'Update Change Order'
              : 'Create Change Order'}
        </Button>
      </div>
    </form>
  )
}
