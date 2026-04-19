import { useForm, useStore } from '@tanstack/react-form'
import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import type { TestPlan } from '@/lib/items/types/testplan'
import type { Design } from '@/lib/types/design'
import type { DesignStatus } from '@/components/versioning/DesignPhaseIndicator'
import { testPlanSchema } from '@/lib/items/types/testplan'
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

interface TestPlanFormProps {
  testPlan?: Partial<TestPlan>
  /** List of designs to select from */
  designs?: Array<Design>
  /** Default design ID for new test plans */
  defaultDesignId?: string
  /** Called when form is submitted. Includes branchId if design is in post-release phase. */
  onSubmit: (data: TestPlan, branchId?: string) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function TestPlanForm({
  testPlan,
  designs = [],
  defaultDesignId,
  onSubmit,
  onCancel,
  isSubmitting,
}: TestPlanFormProps) {
  // Track selected design's protection status
  const [designStatus, setDesignStatus] = useState<DesignStatus | null>(null)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    (testPlan?.attributes as Record<string, string>) ?? {},
  )

  const form = useForm({
    defaultValues: {
      itemType: 'TestPlan' as const,
      state: 'Draft',
      revision: 'A',
      designId: testPlan?.designId || defaultDesignId || '',
      itemNumber: '',
      name: '',
      description: '',
      scope: '',
      environment: '',
      entryCriteria: '',
      exitCriteria: '',
      status: undefined as
        | 'Draft'
        | 'Active'
        | 'Completed'
        | 'Archived'
        | undefined,
      ...testPlan,
    },
    validators: {
      onSubmit: zodValidator(testPlanSchema),
    },
    onSubmit: async ({ value }) => {
      const submissionData = {
        ...value,
        revision: value.revision.trim() || 'A',
        attributes,
      } as TestPlan
      // Pass branchId if design is in post-release phase
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
  const needsBranchSelection = isPostRelease && !testPlan?.id

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
      data-testid="test-plan-form"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Design - Required for versioning */}
        <form.Field name="designId">
          {(field) => (
            <FormField
              label="Design"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="The design this test plan belongs to"
              className="md:col-span-2"
            >
              <div className="flex items-center gap-4">
                <DesignSelector
                  designs={designs}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  required
                  disabled={!!testPlan?.id}
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

        {/* Branch Selection - Only shown in post-release phase for new items */}
        {needsBranchSelection && currentDesignId && (
          <FormField
            label="Target Branch"
            required
            error={
              !selectedBranchId
                ? 'Please select a branch to create this test plan on'
                : undefined
            }
            helpText="Select an ECO or workspace branch for the new test plan"
            className="md:col-span-2"
          >
            <BranchSelector
              designId={currentDesignId}
              value={selectedBranchId}
              onChange={setSelectedBranchId}
              showMainOption={false}
              placeholder="Select branch..."
            />
            <div className="flex items-start gap-2 mt-2 p-3 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-sm rounded-md">
              <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                This design is under change control. New test plans must be
                created on an ECO or workspace branch.
              </span>
            </div>
          </FormField>
        )}

        {/* Item Number */}
        <form.Field name="itemNumber">
          {(field) => (
            <FormField
              label="Item Number"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Leave blank to auto-generate (e.g., TP-000001)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Auto-generated if blank"
                error={!!field.state.meta.errors.length}
                data-testid="test-plan-item-number"
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
                placeholder="System Integration Test Plan"
                error={!!field.state.meta.errors.length}
                data-testid="test-plan-name"
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
                placeholder="Purpose and objectives of this test plan..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Scope */}
        <form.Field name="scope">
          {(field) => (
            <FormField
              label="Scope"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="What is included and excluded from testing"
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Define the scope of testing..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Environment */}
        <form.Field name="environment">
          {(field) => (
            <FormField
              label="Environment"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Test environment requirements"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Lab, Staging, Production, etc."
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Status */}
        <form.Field name="status">
          {(field) => (
            <FormField
              label="Status"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(value as typeof field.state.value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Draft">Draft</SelectItem>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Completed">Completed</SelectItem>
                  <SelectItem value="Archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Entry Criteria */}
        <form.Field name="entryCriteria">
          {(field) => (
            <FormField
              label="Entry Criteria"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Conditions that must be met before testing begins"
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Define entry criteria..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Exit Criteria */}
        <form.Field name="exitCriteria">
          {(field) => (
            <FormField
              label="Exit Criteria"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Conditions that must be met for testing to be complete"
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Define exit criteria..."
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
          disabled={isSubmitting || (needsBranchSelection && !selectedBranchId)}
          data-testid="test-plan-submit"
        >
          {isSubmitting
            ? 'Saving...'
            : testPlan?.id
              ? 'Update Test Plan'
              : 'Create Test Plan'}
        </Button>
      </div>
    </form>
  )
}
