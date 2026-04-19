import { useForm, useStore } from '@tanstack/react-form'
import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import type { Part } from '@/lib/items/types/part'
import type { Design } from '@/lib/types/design'
import type { DesignStatus } from '@/components/versioning/DesignPhaseIndicator'
import { partSchema } from '@/lib/items/types/part'
import { DesignSelector } from '@/components/versioning/DesignSelector'
import { DesignPhaseIndicator } from '@/components/versioning/DesignPhaseIndicator'
import { BranchSelector } from '@/components/versioning/BranchSelector'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { apiFetch } from '@/lib/api/client'
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

interface PartFormProps {
  part?: Partial<Part>
  /** List of designs to select from */
  designs?: Array<Design>
  /** Default design ID for new parts */
  defaultDesignId?: string
  /** Called when form is submitted. Includes branchId if design is in post-release phase. */
  onSubmit: (data: Part, branchId?: string) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function PartForm({
  part,
  designs = [],
  defaultDesignId,
  onSubmit,
  onCancel,
  isSubmitting,
}: PartFormProps) {
  // Track selected design's protection status
  const [designStatus, setDesignStatus] = useState<DesignStatus | null>(null)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    (part?.attributes as Record<string, string>) ?? {},
  )
  const form = useForm({
    defaultValues: {
      itemType: 'Part' as const,
      state: 'Draft',
      revision: 'A',
      weightUnit: 'kg',
      costCurrency: 'USD',
      designId: part?.designId || defaultDesignId || '',
      itemNumber: '',
      name: '',
      description: '',
      partType: undefined as
        | 'Manufacture'
        | 'Purchase'
        | 'Software'
        | 'Phantom'
        | undefined,
      material: '',
      weight: '',
      cost: '',
      leadTimeDays: undefined as number | undefined,
      ...part,
    },
    validators: {
      onSubmit: zodValidator(partSchema),
    },
    onSubmit: async ({ value }) => {
      // Ensure revision defaults to "A" if empty
      const submissionData = {
        ...value,
        revision: value.revision.trim() || 'A',
        attributes,
      } as Part
      // Pass branchId if product is in post-release phase
      await onSubmit(submissionData, selectedBranchId)
    },
  })

  // Watch for design changes and fetch status
  const currentDesignId = useStore(form.store, (state) => state.values.designId)

  useEffect(() => {
    if (!currentDesignId) {
      setDesignStatus(null)
      setSelectedBranchId(undefined)
      return
    }

    async function fetchDesignStatus() {
      setLoadingStatus(true)
      try {
        const result = await apiFetch<{ data: DesignStatus }>(
          `/api/designs/${currentDesignId}/status`,
        )
        setDesignStatus(result.data)
        // Clear branch selection when design changes
        setSelectedBranchId(undefined)
      } catch {
        setDesignStatus(null)
      } finally {
        setLoadingStatus(false)
      }
    }

    fetchDesignStatus()
  }, [currentDesignId])

  // Check if we're in post-release phase and need branch selection
  const isPostRelease = designStatus?.protection.phase === 'post-release'
  // In post-release, branch is required. In pre-release, branch is optional (for private work).
  const showBranchSelector = currentDesignId && !part?.id
  const branchRequired = isPostRelease

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
      data-testid="part-form"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Design - Required for versioning */}
        <form.Field name="designId">
          {(field) => (
            <FormField
              label="Design"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="The design this part belongs to"
              className="md:col-span-2"
            >
              <div className="flex items-center gap-4">
                <DesignSelector
                  designs={designs}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  required
                  disabled={!!part?.id}
                />
                {field.state.value && !loadingStatus && designStatus && (
                  <DesignPhaseIndicator
                    designId={field.state.value}
                    status={designStatus}
                  />
                )}
              </div>
            </FormField>
          )}
        </form.Field>

        {/* Branch Selection - Available for new items in both phases */}
        {showBranchSelector && (
          <FormField
            label="Target Branch"
            required={branchRequired}
            error={
              branchRequired && !selectedBranchId
                ? 'Please select a branch to create this part on'
                : undefined
            }
            helpText={
              branchRequired
                ? 'Select an ECO or workspace branch for the new part'
                : 'Optional: Create on a workspace branch for private development'
            }
            className="md:col-span-2"
          >
            <BranchSelector
              designId={currentDesignId}
              value={selectedBranchId}
              onChange={setSelectedBranchId}
              showMainOption={!branchRequired}
              placeholder={
                branchRequired ? 'Select branch...' : 'Main branch (default)'
              }
            />
            {branchRequired && (
              <div className="flex items-start gap-2 mt-2 p-3 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-sm rounded-md">
                <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                  This design is under change control. New parts must be created
                  on an ECO or workspace branch.
                </span>
              </div>
            )}
            {!branchRequired && !selectedBranchId && (
              <div className="flex items-start gap-2 mt-2 p-3 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-sm rounded-md">
                <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                  No branch selected - part will be created on the main branch.
                  Select a workspace branch for private development work.
                </span>
              </div>
            )}
          </FormField>
        )}

        {/* Item Number */}
        <form.Field name="itemNumber">
          {(field) => (
            <FormField
              label="Item Number"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Leave blank to auto-generate (e.g., PN-000001)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Auto-generated if blank"
                error={!!field.state.meta.errors.length}
                data-testid="part-item-number"
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
              label="Name"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Widget Assembly"
                error={!!field.state.meta.errors.length}
                data-testid="part-name"
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
                placeholder="Detailed description of the part..."
                rows={4}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Type */}
        <form.Field name="partType">
          {(field) => (
            <FormField
              label="Type"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(
                    value as
                      | 'Manufacture'
                      | 'Purchase'
                      | 'Software'
                      | 'Phantom',
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select option" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Manufacture">Manufacture</SelectItem>
                  <SelectItem value="Purchase">Purchase</SelectItem>
                  <SelectItem value="Software">Software</SelectItem>
                  <SelectItem value="Phantom">Phantom</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Material */}
        <form.Field name="material">
          {(field) => (
            <FormField
              label="Material"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Steel, Aluminum, etc."
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Weight */}
        <form.Field name="weight">
          {(field) => (
            <FormField
              label="Weight"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <div className="flex gap-2">
                <Input
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  type="number"
                  step="0.001"
                  placeholder="0.000"
                  error={!!field.state.meta.errors.length}
                  className="flex-1"
                />
                <form.Field name="weightUnit">
                  {(unitField) => (
                    <Select
                      value={unitField.state.value}
                      onValueChange={(value) => unitField.handleChange(value)}
                    >
                      <SelectTrigger className="!w-20 !px-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="kg">kg</SelectItem>
                        <SelectItem value="g">g</SelectItem>
                        <SelectItem value="lb">lb</SelectItem>
                        <SelectItem value="oz">oz</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </form.Field>
              </div>
            </FormField>
          )}
        </form.Field>

        {/* Cost */}
        <form.Field name="cost">
          {(field) => (
            <FormField
              label="Cost"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <div className="flex gap-2">
                <form.Field name="costCurrency">
                  {(currencyField) => (
                    <Select
                      value={currencyField.state.value}
                      onValueChange={(value) =>
                        currencyField.handleChange(value)
                      }
                    >
                      <SelectTrigger className="!w-20 !px-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="EUR">EUR</SelectItem>
                        <SelectItem value="GBP">GBP</SelectItem>
                        <SelectItem value="JPY">JPY</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </form.Field>
                <Input
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  error={!!field.state.meta.errors.length}
                  className="flex-1"
                />
              </div>
            </FormField>
          )}
        </form.Field>

        {/* Lead Time */}
        <form.Field name="leadTimeDays">
          {(field) => (
            <FormField
              label="Lead Time (days)"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value ?? ''}
                onChange={(e) => {
                  const value = e.target.value
                  field.handleChange(value ? parseInt(value, 10) : undefined)
                }}
                onBlur={field.handleBlur}
                type="number"
                placeholder="30"
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

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
            data-testid="part-cancel"
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          disabled={isSubmitting || (branchRequired && !selectedBranchId)}
          data-testid="part-submit"
        >
          {isSubmitting
            ? 'Saving...'
            : part?.id
              ? 'Update Part'
              : 'Create Part'}
        </Button>
      </div>
    </form>
  )
}
