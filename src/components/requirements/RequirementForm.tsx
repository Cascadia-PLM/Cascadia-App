import { useForm, useStore } from '@tanstack/react-form'
import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import type { Requirement } from '@/lib/items/types/requirement'
import type { Design } from '@/lib/types/design'
import type { DesignStatus } from '@/components/versioning/DesignPhaseIndicator'
import { requirementSchema } from '@/lib/items/types/requirement'
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

interface RequirementFormProps {
  requirement?: Partial<Requirement>
  /** List of designs to select from */
  designs?: Array<Design>
  /** Default design ID for new requirements */
  defaultDesignId?: string
  /** Called when form is submitted. Includes branchId if design is in post-release phase. */
  onSubmit: (data: Requirement, branchId?: string) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function RequirementForm({
  requirement,
  designs = [],
  defaultDesignId,
  onSubmit,
  onCancel,
  isSubmitting,
}: RequirementFormProps) {
  // Track selected design's protection status
  const [designStatus, setDesignStatus] = useState<DesignStatus | null>(null)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    (requirement?.attributes as Record<string, string>) ?? {},
  )
  const form = useForm({
    defaultValues: {
      itemType: 'Requirement' as const,
      state: 'Draft',
      revision: 'A',
      designId: requirement?.designId || defaultDesignId || '',
      itemNumber: '',
      name: '',
      description: '',
      type: undefined as
        | 'Functional'
        | 'Non-Functional'
        | 'Performance'
        | 'Security'
        | 'Usability'
        | 'Business'
        | undefined,
      priority: undefined as
        | 'MustHave'
        | 'ShouldHave'
        | 'CouldHave'
        | 'WontHave'
        | undefined,
      status: undefined as
        | 'Proposed'
        | 'Approved'
        | 'Implemented'
        | 'Verified'
        | 'Rejected'
        | undefined,
      source: '',
      category: '',
      acceptanceCriteria: '',
      verificationMethod: undefined as
        | 'Analysis'
        | 'Inspection'
        | 'Demonstration'
        | 'Test'
        | undefined,
      verificationStatus: undefined as
        | 'NotStarted'
        | 'InProgress'
        | 'Passed'
        | 'Failed'
        | 'Waived'
        | undefined,
      ...requirement,
    },
    validators: {
      onSubmit: zodValidator(requirementSchema),
    },
    onSubmit: async ({ value }) => {
      const submissionData = {
        ...value,
        revision: value.revision.trim() || 'A',
        attributes,
      } as Requirement
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
  const needsBranchSelection = isPostRelease && !requirement?.id

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
      data-testid="requirement-form"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Design - Required for versioning */}
        <form.Field name="designId">
          {(field) => (
            <FormField
              label="Design"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="The design this requirement belongs to"
              className="md:col-span-2"
            >
              <div className="flex items-center gap-4">
                <DesignSelector
                  designs={designs}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  required
                  disabled={!!requirement?.id}
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
                ? 'Please select a branch to create this requirement on'
                : undefined
            }
            helpText="Select an ECO or workspace branch for the new requirement"
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
                This design is under change control. New requirements must be
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
              helpText="Leave blank to auto-generate (e.g., REQ-000001)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Auto-generated if blank"
                error={!!field.state.meta.errors.length}
                data-testid="requirement-item-number"
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
                placeholder="User Authentication"
                error={!!field.state.meta.errors.length}
                data-testid="requirement-name"
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
                placeholder="Detailed description of the requirement..."
                rows={4}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Type */}
        <form.Field name="type">
          {(field) => (
            <FormField
              label="Type"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(value as typeof field.state.value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Functional">Functional</SelectItem>
                  <SelectItem value="Non-Functional">Non-Functional</SelectItem>
                  <SelectItem value="Performance">Performance</SelectItem>
                  <SelectItem value="Security">Security</SelectItem>
                  <SelectItem value="Usability">Usability</SelectItem>
                  <SelectItem value="Business">Business</SelectItem>
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
                  field.handleChange(value as typeof field.state.value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MustHave">Must Have</SelectItem>
                  <SelectItem value="ShouldHave">Should Have</SelectItem>
                  <SelectItem value="CouldHave">Could Have</SelectItem>
                  <SelectItem value="WontHave">Won't Have</SelectItem>
                </SelectContent>
              </Select>
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
                  <SelectItem value="Proposed">Proposed</SelectItem>
                  <SelectItem value="Approved">Approved</SelectItem>
                  <SelectItem value="Implemented">Implemented</SelectItem>
                  <SelectItem value="Verified">Verified</SelectItem>
                  <SelectItem value="Rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Source */}
        <form.Field name="source">
          {(field) => (
            <FormField
              label="Source"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Who requested this requirement"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Customer, Stakeholder, etc."
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Category */}
        <form.Field name="category">
          {(field) => (
            <FormField
              label="Category"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="e.g., Authentication, Reporting, Performance"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Acceptance Criteria */}
        <form.Field name="acceptanceCriteria">
          {(field) => (
            <FormField
              label="Acceptance Criteria"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Define the acceptance criteria for this requirement..."
                rows={4}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Verification Method */}
        <form.Field name="verificationMethod">
          {(field) => (
            <FormField
              label="Verification Method"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="How this requirement will be verified"
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(value as typeof field.state.value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Analysis">Analysis</SelectItem>
                  <SelectItem value="Inspection">Inspection</SelectItem>
                  <SelectItem value="Demonstration">Demonstration</SelectItem>
                  <SelectItem value="Test">Test</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Verification Status */}
        <form.Field name="verificationStatus">
          {(field) => (
            <FormField
              label="Verification Status"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Current verification status"
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
                  <SelectItem value="NotStarted">Not Started</SelectItem>
                  <SelectItem value="InProgress">In Progress</SelectItem>
                  <SelectItem value="Passed">Passed</SelectItem>
                  <SelectItem value="Failed">Failed</SelectItem>
                  <SelectItem value="Waived">Waived</SelectItem>
                </SelectContent>
              </Select>
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
          data-testid="requirement-submit"
        >
          {isSubmitting
            ? 'Saving...'
            : requirement?.id
              ? 'Update Requirement'
              : 'Create Requirement'}
        </Button>
      </div>
    </form>
  )
}
