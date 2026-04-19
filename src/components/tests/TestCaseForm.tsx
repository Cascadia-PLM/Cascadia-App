import { useForm, useStore } from '@tanstack/react-form'
import { useEffect, useState } from 'react'
import { Info, Plus, Trash2 } from 'lucide-react'
import type { TestCase, TestStep } from '@/lib/items/types/testcase'
import type { TestPlan } from '@/lib/items/types/testplan'
import type { Design } from '@/lib/types/design'
import type { DesignStatus } from '@/components/versioning/DesignPhaseIndicator'
import { testCaseSchema } from '@/lib/items/types/testcase'
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

interface TestCaseFormProps {
  testCase?: Partial<TestCase>
  /** List of designs to select from */
  designs?: Array<Design>
  /** Default design ID for new test cases */
  defaultDesignId?: string
  /** Default test plan ID (when creating from a test plan) */
  defaultTestPlanId?: string
  /** Called when form is submitted. Includes branchId if design is in post-release phase. */
  onSubmit: (data: TestCase, branchId?: string) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function TestCaseForm({
  testCase,
  designs = [],
  defaultDesignId,
  defaultTestPlanId,
  onSubmit,
  onCancel,
  isSubmitting,
}: TestCaseFormProps) {
  // Track selected design's protection status
  const [designStatus, setDesignStatus] = useState<DesignStatus | null>(null)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()
  const [loadingStatus, setLoadingStatus] = useState(false)

  // Available test plans for the selected design
  const [testPlans, setTestPlans] = useState<Array<TestPlan>>([])
  const [loadingTestPlans, setLoadingTestPlans] = useState(false)

  // Steps state managed separately for UI
  const [steps, setSteps] = useState<Array<TestStep>>(
    testCase?.steps || [{ stepNumber: 1, action: '', expectedResult: '' }],
  )
  const [attributes, setAttributes] = useState<Record<string, string>>(
    (testCase?.attributes as Record<string, string>) ?? {},
  )

  const form = useForm({
    defaultValues: {
      itemType: 'TestCase' as const,
      state: 'Draft',
      revision: 'A',
      designId: testCase?.designId || defaultDesignId || '',
      testPlanId: testCase?.testPlanId || defaultTestPlanId || '',
      itemNumber: '',
      name: '',
      description: '',
      testType: undefined as
        | 'Unit'
        | 'Integration'
        | 'System'
        | 'Acceptance'
        | undefined,
      preconditions: '',
      steps: testCase?.steps || [],
      executionStatus: 'NotRun' as 'NotRun' | 'Passed' | 'Failed' | 'Blocked',
      environment: '',
      ...testCase,
    },
    validators: {
      onSubmit: zodValidator(testCaseSchema),
    },
    onSubmit: async ({ value }) => {
      const submissionData = {
        ...value,
        revision: value.revision.trim() || 'A',
        steps: steps.filter((s) => s.action.trim() || s.expectedResult.trim()),
        attributes,
      } as TestCase
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
      setTestPlans([])
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

    async function fetchTestPlans() {
      setLoadingTestPlans(true)
      try {
        const result = await apiFetch<{ data: { items: Array<TestPlan> } }>(
          `/api/items?itemType=TestPlan&designId=${currentDesignId}`,
        )
        setTestPlans(result.data.items || [])
      } catch {
        setTestPlans([])
      } finally {
        setLoadingTestPlans(false)
      }
    }

    fetchDesignStatus()
    fetchTestPlans()
  }, [currentDesignId])

  // Check if we're in post-release phase and need branch selection
  const isPostRelease = designStatus?.protection.phase === 'post-release'
  const needsBranchSelection = isPostRelease && !testCase?.id

  // Step management functions
  const addStep = () => {
    setSteps([
      ...steps,
      { stepNumber: steps.length + 1, action: '', expectedResult: '' },
    ])
  }

  const updateStep = (
    index: number,
    field: keyof TestStep,
    value: string | number,
  ) => {
    const newSteps = [...steps]
    newSteps[index] = { ...newSteps[index], [field]: value }
    setSteps(newSteps)
  }

  const removeStep = (index: number) => {
    const newSteps = steps.filter((_, i) => i !== index)
    // Re-number steps
    setSteps(newSteps.map((s, i) => ({ ...s, stepNumber: i + 1 })))
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
      data-testid="test-case-form"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Design - Required for versioning */}
        <form.Field name="designId">
          {(field) => (
            <FormField
              label="Design"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="The design this test case belongs to"
              className="md:col-span-2"
            >
              <div className="flex items-center gap-4">
                <DesignSelector
                  designs={designs}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  required
                  disabled={!!testCase?.id}
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
                ? 'Please select a branch to create this test case on'
                : undefined
            }
            helpText="Select an ECO or workspace branch for the new test case"
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
                This design is under change control. New test cases must be
                created on an ECO or workspace branch.
              </span>
            </div>
          </FormField>
        )}

        {/* Test Plan */}
        <form.Field name="testPlanId">
          {(field) => (
            <FormField
              label="Test Plan"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Optional parent test plan"
              className="md:col-span-2"
            >
              <Select
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value)}
                disabled={loadingTestPlans || !currentDesignId}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      loadingTestPlans
                        ? 'Loading...'
                        : 'Select a test plan (optional)'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {testPlans.map((tp) => (
                    <SelectItem key={tp.id} value={tp.id!}>
                      {tp.itemNumber} - {tp.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Item Number */}
        <form.Field name="itemNumber">
          {(field) => (
            <FormField
              label="Item Number"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Leave blank to auto-generate (e.g., TC-000001)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Auto-generated if blank"
                error={!!field.state.meta.errors.length}
                data-testid="test-case-item-number"
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
                placeholder="Verify user login with valid credentials"
                error={!!field.state.meta.errors.length}
                data-testid="test-case-name"
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
                placeholder="Purpose and objectives of this test case..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Test Type */}
        <form.Field name="testType">
          {(field) => (
            <FormField
              label="Test Type"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(value as typeof field.state.value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select test type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Unit">Unit</SelectItem>
                  <SelectItem value="Integration">Integration</SelectItem>
                  <SelectItem value="System">System</SelectItem>
                  <SelectItem value="Acceptance">Acceptance</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Environment */}
        <form.Field name="environment">
          {(field) => (
            <FormField
              label="Environment"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Test environment"
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

        {/* Preconditions */}
        <form.Field name="preconditions">
          {(field) => (
            <FormField
              label="Preconditions"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Conditions that must be met before running the test"
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="List preconditions..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Test Steps */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">Test Steps</h3>
          <Button type="button" variant="outline" size="sm" onClick={addStep}>
            <Plus className="h-4 w-4 mr-2" />
            Add Step
          </Button>
        </div>
        <div className="space-y-4">
          {steps.map((step, index) => (
            <div
              key={index}
              className="grid grid-cols-12 gap-4 p-4 border rounded-lg bg-slate-50 dark:bg-slate-800"
            >
              <div className="col-span-1 flex items-center justify-center">
                <span className="text-lg font-bold text-slate-400">
                  {step.stepNumber}
                </span>
              </div>
              <div className="col-span-5">
                <FormField label="Action">
                  <Textarea
                    value={step.action}
                    onChange={(e) =>
                      updateStep(index, 'action', e.target.value)
                    }
                    placeholder="Describe the action to perform..."
                    rows={2}
                  />
                </FormField>
              </div>
              <div className="col-span-5">
                <FormField label="Expected Result">
                  <Textarea
                    value={step.expectedResult}
                    onChange={(e) =>
                      updateStep(index, 'expectedResult', e.target.value)
                    }
                    placeholder="Describe the expected result..."
                    rows={2}
                  />
                </FormField>
              </div>
              <div className="col-span-1 flex items-center justify-center">
                {steps.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeStep(index)}
                    className="text-red-500 hover:text-red-700 hover:bg-red-100"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
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
          disabled={isSubmitting || (needsBranchSelection && !selectedBranchId)}
          data-testid="test-case-submit"
        >
          {isSubmitting
            ? 'Saving...'
            : testCase?.id
              ? 'Update Test Case'
              : 'Create Test Case'}
        </Button>
      </div>
    </form>
  )
}
