import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Edit,
  GitBranch,
  History,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import type { TestCase, TestStep } from '@/lib/items/types/testcase'
import type { TestPlan } from '@/lib/items/types/testplan'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { RelationshipSection } from '@/components/items/RelationshipSection'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { CheckoutDialog } from '@/components/items/CheckoutDialog'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { WorkspaceContextBanner } from '@/components/workspaces/WorkspaceContextBanner'
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
  FormField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  ViewEditBadge,
  ViewEditSelect,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

interface TestExecution {
  id: string
  testCaseId: string
  executorId: string
  executorName?: string
  executedAt: string
  status: 'Passed' | 'Failed' | 'Blocked'
  duration?: number
  environment?: string
  actualResults?: string
  notes?: string
}

const STATE_OPTIONS = [
  { value: 'Draft', label: 'Draft' },
  { value: 'Proposed', label: 'Proposed' },
  { value: 'InReview', label: 'In Review' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Released', label: 'Released' },
]

const TEST_TYPE_OPTIONS = [
  { value: 'Unit', label: 'Unit' },
  { value: 'Integration', label: 'Integration' },
  { value: 'System', label: 'System' },
  { value: 'Acceptance', label: 'Acceptance' },
]

const EXECUTION_STATUS_OPTIONS = [
  { value: 'NotRun', label: 'Not Run' },
  { value: 'Passed', label: 'Passed' },
  { value: 'Failed', label: 'Failed' },
  { value: 'Blocked', label: 'Blocked' },
]

const stateVariant = (state: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Draft: 'secondary',
    Proposed: 'default',
    InReview: 'default',
    Approved: 'success',
    Released: 'success',
  }
  return variants[state] || 'default'
}

const executionStatusVariant = (status: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    NotRun: 'secondary',
    Passed: 'success',
    Failed: 'destructive',
    Blocked: 'warning',
  }
  return variants[status] || 'secondary'
}

const createEmptyTestCase = (): TestCase => ({
  id: undefined,
  masterId: undefined,
  itemNumber: '',
  revision: 'A',
  name: '',
  description: '',
  state: 'Draft',
  isCurrent: true,
  designId: undefined,
  testPlanId: undefined,
  testType: undefined,
  preconditions: undefined,
  steps: [],
  executionStatus: 'NotRun',
  lastExecutedAt: undefined,
  lastExecutedBy: undefined,
  environment: undefined,
  createdAt: undefined,
  modifiedAt: undefined,
})

interface TestCaseDetailProps {
  testCase?: TestCase
  designs?: Array<Design>
  defaultDesignId?: string
  defaultTestPlanId?: string
  onSave: (testCase: TestCase, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: 'details' | 'executions' | 'relationships' | 'history'
  onTabChange?: (tab: string) => void
}

export function TestCaseDetail({
  testCase: initialTestCase,
  designs = [],
  defaultDesignId,
  defaultTestPlanId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: TestCaseDetailProps) {
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  const isCreateMode = !initialTestCase?.id

  const [testCase, setTestCase] = useState<TestCase>(
    () =>
      initialTestCase || {
        ...createEmptyTestCase(),
        designId: defaultDesignId,
        testPlanId: defaultTestPlanId,
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)

  const [displayedTestCase, setDisplayedTestCase] = useState<TestCase>(testCase)
  const [isLoadingVersion, setIsLoadingVersion] = useState(false)
  const [isWorkspaceContext, setIsWorkspaceContext] = useState(false)

  // Test plan info
  const [testPlan, setTestPlan] = useState<TestPlan | null>(null)

  // Test execution history
  const [executions, setExecutions] = useState<Array<TestExecution>>([])
  const [loadingExecutions, setLoadingExecutions] = useState(false)

  // Execution dialog state
  const [showExecutionForm, setShowExecutionForm] = useState(false)
  const [executionStatus, setExecutionStatus] = useState<
    'Passed' | 'Failed' | 'Blocked'
  >('Passed')
  const [actualResults, setActualResults] = useState('')
  const [executionNotes, setExecutionNotes] = useState('')
  const [executingTest, setExecutingTest] = useState(false)

  // Steps for editing
  const [steps, setSteps] = useState<Array<TestStep>>(
    initialTestCase?.steps || [],
  )

  const { context, contextLabel, isEditable, setContext } = useVersionContext(
    isCreateMode ? undefined : testCase.designId,
  )

  useEffect(() => {
    if (initialTestCase) {
      setTestCase(initialTestCase)
      setDisplayedTestCase(initialTestCase)
      setSteps(initialTestCase.steps || [])
    }
  }, [initialTestCase])

  useEffect(() => {
    async function fetchVersionAtContext() {
      if (isCreateMode || !testCase.designId || context.type === 'main') {
        setDisplayedTestCase(testCase)
        return
      }

      setIsLoadingVersion(true)
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
          setDisplayedTestCase(testCase)
          return
        }

        const response = await apiFetch<{ data: { item: TestCase | null } }>(
          `/api/items/${testCase.id}/at-context?${queryString}`,
        )
        setDisplayedTestCase(response.data.item || testCase)
      } catch {
        setDisplayedTestCase(testCase)
      } finally {
        setIsLoadingVersion(false)
      }
    }
    fetchVersionAtContext()
  }, [testCase, context, isCreateMode])

  useEffect(() => {
    async function checkIfWorkspace() {
      if (context.type !== 'branch' || !context.branchId) {
        setIsWorkspaceContext(false)
        return
      }
      try {
        const response = await apiFetch<{
          data: { branch: { branchType: string } }
        }>(`/api/branches/${context.branchId}`)
        setIsWorkspaceContext(response.data.branch.branchType === 'workspace')
      } catch {
        setIsWorkspaceContext(false)
      }
    }
    if (!isCreateMode) checkIfWorkspace()
  }, [context, isCreateMode])

  // Fetch test plan info
  useEffect(() => {
    async function fetchTestPlan() {
      if (!testCase.testPlanId) {
        setTestPlan(null)
        return
      }
      try {
        const response = await apiFetch<{ data: { item: TestPlan } }>(
          `/api/items/${testCase.testPlanId}`,
        )
        setTestPlan(response.data.item)
      } catch {
        setTestPlan(null)
      }
    }
    fetchTestPlan()
  }, [testCase.testPlanId])

  // Fetch execution history
  useEffect(() => {
    async function fetchExecutions() {
      if (isCreateMode || !testCase.id) return
      setLoadingExecutions(true)
      try {
        const response = await apiFetch<{
          data: { executions: Array<TestExecution> }
        }>(`/api/test-cases/${testCase.id}/executions`)
        setExecutions(response.data.executions)
      } catch {
        setExecutions([])
      } finally {
        setLoadingExecutions(false)
      }
    }
    fetchExecutions()
  }, [testCase.id, isCreateMode])

  const currentTestCase = isCreateMode ? testCase : displayedTestCase

  const updateField = (field: keyof TestCase, value: any) => {
    setTestCase((prev) => ({ ...prev, [field]: value }))
  }

  const needsCheckout =
    !isCreateMode &&
    ['Approved', 'Released'].includes(currentTestCase.state ?? '') &&
    context.type === 'main'

  const handleEdit = () => {
    if (needsCheckout) {
      setIsCheckoutDialogOpen(true)
      return
    }
    setTestCase(currentTestCase)
    setSteps(currentTestCase.steps || [])
    setIsEditing(true)
  }

  const handleCheckoutComplete = (branchId: string) => {
    setContext({ type: 'branch', branchId })
    setTestCase(currentTestCase)
    setSteps(currentTestCase.steps || [])
    setIsEditing(true)
  }

  const handleSave = async () => {
    const branchId = context.type === 'branch' ? context.branchId : undefined
    const dataToSave = { ...testCase, steps }
    await onSave(dataToSave, branchId)
    if (!isCreateMode) setIsEditing(false)
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      setTestCase(currentTestCase)
      setSteps(currentTestCase.steps || [])
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentTestCase.id) return
    confirm({
      title: 'Delete Test Case',
      description: `Are you sure you want to delete ${currentTestCase.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: onDelete,
    })
  }

  // Get reason for disabled Edit button
  const getEditDisabledReason = (): string | undefined => {
    if (!isEditable) {
      if (context.type === 'tag' || context.type === 'commit') {
        return 'Cannot edit historical versions'
      }
      return 'Editing not available in this context'
    }
    return undefined
  }

  const handleExecuteTest = async () => {
    if (!currentTestCase.id) return
    setExecutingTest(true)
    try {
      await apiFetch(`/api/test-cases/${currentTestCase.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({
          status: executionStatus,
          actualResults,
          notes: executionNotes,
        }),
      })
      // Refresh execution history
      const response = await apiFetch<{
        data: { executions: Array<TestExecution> }
      }>(`/api/test-cases/${currentTestCase.id}/executions`)
      setExecutions(response.data.executions)
      // Refresh test case to get updated status
      const tcResponse = await apiFetch<{ data: { item: TestCase } }>(
        `/api/items/${currentTestCase.id}`,
      )
      setTestCase(tcResponse.data.item)
      setDisplayedTestCase(tcResponse.data.item)
      // Reset form
      setShowExecutionForm(false)
      setActualResults('')
      setExecutionNotes('')
    } catch (error) {
      console.error('Failed to record execution:', error)
    } finally {
      setExecutingTest(false)
    }
  }

  // Step management
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
    setSteps(newSteps.map((s, i) => ({ ...s, stepNumber: i + 1 })))
  }

  const getContextBadgeVariant = () => {
    switch (context.type) {
      case 'branch':
        return 'secondary'
      case 'tag':
      case 'commit':
        return 'outline'
      default:
        return 'default'
    }
  }

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/test-cases">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode
                  ? 'Create New Test Case'
                  : currentTestCase.itemNumber}
              </h1>
              {!isCreateMode && isLoadingVersion && (
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              )}
              {!isCreateMode && currentTestCase.state && (
                <Badge
                  className="text-base"
                  variant={stateVariant(currentTestCase.state)}
                >
                  {currentTestCase.state}
                </Badge>
              )}
              {!isCreateMode && currentTestCase.executionStatus && (
                <Badge
                  className="text-base"
                  variant={executionStatusVariant(
                    currentTestCase.executionStatus,
                  )}
                >
                  {currentTestCase.executionStatus === 'NotRun'
                    ? 'Not Run'
                    : currentTestCase.executionStatus}
                </Badge>
              )}
              {!isCreateMode &&
                currentTestCase.designId &&
                context.type !== 'main' && (
                  <Badge variant={getContextBadgeVariant()} className="text-sm">
                    <GitBranch className="h-3 w-3 mr-1" />
                    {contextLabel}
                  </Badge>
                )}
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {isCreateMode
                ? 'Enter the details for the new test case'
                : `Revision ${currentTestCase.revision} • ${currentTestCase.name || 'Unnamed'}`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-2">
            {!isCreateMode && !isEditing && (
              <Button
                variant="default"
                onClick={() => setShowExecutionForm(true)}
                disabled={!isEditable}
              >
                <Play className="h-4 w-4 mr-2" />
                Execute Test
              </Button>
            )}
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
                      ? 'Create Test Case'
                      : 'Save Changes'}
                </Button>
              </>
            ) : (
              <>
                {/* Edit button with tooltip when disabled */}
                {getEditDisabledReason() ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          variant="outline"
                          onClick={handleEdit}
                          disabled={!isEditable}
                        >
                          {needsCheckout ? (
                            <>
                              <GitBranch className="h-4 w-4 mr-2" />
                              Revise
                            </>
                          ) : (
                            <>
                              <Edit className="h-4 w-4 mr-2" />
                              Edit
                            </>
                          )}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{getEditDisabledReason()}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Button
                    variant="outline"
                    onClick={handleEdit}
                    disabled={!isEditable}
                  >
                    {needsCheckout ? (
                      <>
                        <GitBranch className="h-4 w-4 mr-2" />
                        Revise
                      </>
                    ) : (
                      <>
                        <Edit className="h-4 w-4 mr-2" />
                        Edit
                      </>
                    )}
                  </Button>
                )}
                {onDelete && (
                  <Button
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={!isEditable}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {!isCreateMode &&
        isWorkspaceContext &&
        context.type === 'branch' &&
        context.branchId && (
          <WorkspaceContextBanner branchId={context.branchId} />
        )}

      {/* Execution Form Modal */}
      {showExecutionForm && (
        <Card className="my-4 border-2 border-blue-500">
          <CardHeader>
            <CardTitle>Record Test Execution</CardTitle>
            <CardDescription>
              Record the results of running this test case
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField label="Status" required>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={executionStatus === 'Passed' ? 'default' : 'outline'}
                  onClick={() => setExecutionStatus('Passed')}
                  className={
                    executionStatus === 'Passed'
                      ? 'bg-green-600 hover:bg-green-700'
                      : ''
                  }
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Passed
                </Button>
                <Button
                  type="button"
                  variant={executionStatus === 'Failed' ? 'default' : 'outline'}
                  onClick={() => setExecutionStatus('Failed')}
                  className={
                    executionStatus === 'Failed'
                      ? 'bg-red-600 hover:bg-red-700'
                      : ''
                  }
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Failed
                </Button>
                <Button
                  type="button"
                  variant={
                    executionStatus === 'Blocked' ? 'default' : 'outline'
                  }
                  onClick={() => setExecutionStatus('Blocked')}
                  className={
                    executionStatus === 'Blocked'
                      ? 'bg-yellow-600 hover:bg-yellow-700'
                      : ''
                  }
                >
                  Blocked
                </Button>
              </div>
            </FormField>
            <FormField label="Actual Results">
              <Textarea
                value={actualResults}
                onChange={(e) => setActualResults(e.target.value)}
                placeholder="Describe what actually happened..."
                rows={3}
              />
            </FormField>
            <FormField label="Notes">
              <Textarea
                value={executionNotes}
                onChange={(e) => setExecutionNotes(e.target.value)}
                placeholder="Additional notes..."
                rows={2}
              />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowExecutionForm(false)}
                disabled={executingTest}
              >
                Cancel
              </Button>
              <Button onClick={handleExecuteTest} disabled={executingTest}>
                {executingTest ? 'Recording...' : 'Record Execution'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
        <TabsList
          className={`grid w-full ${isCreateMode ? 'grid-cols-2' : 'grid-cols-4'}`}
        >
          <TabsTrigger value="details">Details</TabsTrigger>
          {!isCreateMode && (
            <TabsTrigger value="executions">Executions</TabsTrigger>
          )}
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          {!isCreateMode && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>

        <TabsContent
          value="details"
          className="mt-6 space-y-6"
          data-testid="test-case-form"
        >
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
              <CardDescription>
                General information about this test case
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ViewEditText
                  label="Item Number"
                  value={
                    isEditing ? testCase.itemNumber : currentTestCase.itemNumber
                  }
                  onChange={(v) => updateField('itemNumber', v)}
                  isEditing={isEditing && isCreateMode}
                  placeholder="TC-001"
                  required
                  data-testid="test-case-item-number"
                />
                <ViewEditText
                  label="Revision"
                  value={currentTestCase.revision}
                  onChange={() => {}}
                  isEditing={false}
                />
                <ViewEditText
                  label="Name"
                  value={isEditing ? testCase.name : currentTestCase.name}
                  onChange={(v) => updateField('name', v)}
                  isEditing={isEditing}
                  placeholder="Test case name"
                  required
                  data-testid="test-case-name"
                />
                <ViewEditBadge
                  label="State"
                  value={currentTestCase.state}
                  onChange={(v) => updateField('state', v)}
                  isEditing={isEditing}
                  options={STATE_OPTIONS}
                  variant={stateVariant}
                  readOnly={!isCreateMode}
                />
                <ViewEditTextarea
                  label="Description"
                  value={
                    isEditing
                      ? testCase.description
                      : currentTestCase.description
                  }
                  onChange={(v) => updateField('description', v)}
                  isEditing={isEditing}
                  className="md:col-span-2"
                />
                {testPlan && (
                  <ViewEditStatic
                    label="Test Plan"
                    value={
                      <Link
                        to="/test-plans/$id"
                        params={{ id: testPlan.id! }}
                        className="text-blue-600 hover:underline"
                      >
                        {testPlan.itemNumber} - {testPlan.name}
                      </Link>
                    }
                    className="md:col-span-2"
                  />
                )}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Test Details</CardTitle>
              <CardDescription>
                Test type, environment, and conditions
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ViewEditSelect
                  label="Test Type"
                  value={
                    isEditing ? testCase.testType : currentTestCase.testType
                  }
                  onChange={(v) => updateField('testType', v)}
                  isEditing={isEditing}
                  options={TEST_TYPE_OPTIONS}
                  placeholder="Select test type..."
                />
                <ViewEditText
                  label="Environment"
                  value={
                    isEditing
                      ? testCase.environment
                      : currentTestCase.environment
                  }
                  onChange={(v) => updateField('environment', v)}
                  isEditing={isEditing}
                  placeholder="Lab, Staging, Production, etc."
                />
                <ViewEditBadge
                  label="Execution Status"
                  value={currentTestCase.executionStatus}
                  onChange={() => {}}
                  isEditing={false}
                  options={EXECUTION_STATUS_OPTIONS}
                  variant={executionStatusVariant}
                />
                {currentTestCase.lastExecutedAt && (
                  <ViewEditStatic
                    label="Last Executed"
                    value={new Date(
                      currentTestCase.lastExecutedAt,
                    ).toLocaleString()}
                  />
                )}
                <ViewEditTextarea
                  label="Preconditions"
                  value={
                    isEditing
                      ? testCase.preconditions
                      : currentTestCase.preconditions
                  }
                  onChange={(v) => updateField('preconditions', v)}
                  isEditing={isEditing}
                  rows={3}
                  className="md:col-span-2"
                />
              </dl>
            </CardContent>
          </Card>

          {/* Test Steps */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Test Steps</CardTitle>
                  <CardDescription>
                    Step-by-step instructions for executing this test
                  </CardDescription>
                </div>
                {isEditing && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addStep}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Step
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {(isEditing ? steps : currentTestCase.steps || []).length ===
              0 ? (
                <div className="text-center py-8 text-slate-500">
                  No test steps defined
                </div>
              ) : (
                <div className="space-y-4">
                  {(isEditing ? steps : currentTestCase.steps || []).map(
                    (step, index) => (
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
                          <div className="text-sm font-medium text-slate-500 mb-1">
                            Action
                          </div>
                          {isEditing ? (
                            <Textarea
                              value={step.action}
                              onChange={(e) =>
                                updateStep(index, 'action', e.target.value)
                              }
                              placeholder="Describe the action..."
                              rows={2}
                            />
                          ) : (
                            <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                              {step.action || '-'}
                            </p>
                          )}
                        </div>
                        <div className="col-span-5">
                          <div className="text-sm font-medium text-slate-500 mb-1">
                            Expected Result
                          </div>
                          {isEditing ? (
                            <Textarea
                              value={step.expectedResult}
                              onChange={(e) =>
                                updateStep(
                                  index,
                                  'expectedResult',
                                  e.target.value,
                                )
                              }
                              placeholder="Describe expected result..."
                              rows={2}
                            />
                          ) : (
                            <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                              {step.expectedResult || '-'}
                            </p>
                          )}
                        </div>
                        {isEditing && steps.length > 1 && (
                          <div className="col-span-1 flex items-center justify-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeStep(index)}
                              className="text-red-500 hover:text-red-700 hover:bg-red-100"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    ),
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Collapsible defaultOpen={false}>
            <Card>
              <CardHeader>
                <CollapsibleTrigger className="hover:opacity-70">
                  <CardTitle>Metadata</CardTitle>
                </CollapsibleTrigger>
                <CardDescription>System information</CardDescription>
              </CardHeader>
              <CollapsibleContent>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditStatic
                      label="Created"
                      value={
                        currentTestCase.createdAt
                          ? new Date(
                              currentTestCase.createdAt,
                            ).toLocaleDateString()
                          : '-'
                      }
                    />
                    <ViewEditStatic
                      label="Last Modified"
                      value={
                        currentTestCase.modifiedAt
                          ? new Date(
                              currentTestCase.modifiedAt,
                            ).toLocaleDateString()
                          : '-'
                      }
                    />
                    {!isCreateMode && (
                      <>
                        <ViewEditStatic
                          label="Master ID"
                          value={currentTestCase.masterId}
                          mono
                        />
                        <ViewEditStatic
                          label="Test Case ID"
                          value={currentTestCase.id}
                          mono
                        />
                      </>
                    )}
                  </dl>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </TabsContent>

        {!isCreateMode && (
          <TabsContent value="executions" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Execution History</CardTitle>
                    <CardDescription>
                      History of test executions
                    </CardDescription>
                  </div>
                  <Button size="sm" onClick={() => setShowExecutionForm(true)}>
                    <Play className="h-4 w-4 mr-2" />
                    Execute Test
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {loadingExecutions ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                  </div>
                ) : executions.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    No executions recorded yet
                  </div>
                ) : (
                  <div className="space-y-4">
                    {executions.map((exec) => (
                      <div
                        key={exec.id}
                        className="flex items-start gap-4 p-4 border rounded-lg"
                      >
                        <div className="flex-shrink-0">
                          {exec.status === 'Passed' ? (
                            <CheckCircle2 className="h-6 w-6 text-green-500" />
                          ) : exec.status === 'Failed' ? (
                            <XCircle className="h-6 w-6 text-red-500" />
                          ) : (
                            <History className="h-6 w-6 text-yellow-500" />
                          )}
                        </div>
                        <div className="flex-grow">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge
                              variant={executionStatusVariant(exec.status)}
                            >
                              {exec.status}
                            </Badge>
                            <span className="text-sm text-slate-500">
                              {new Date(exec.executedAt).toLocaleString()}
                            </span>
                            {exec.executorName && (
                              <span className="text-sm text-slate-500">
                                by {exec.executorName}
                              </span>
                            )}
                            {exec.duration && (
                              <span className="text-sm text-slate-500">
                                ({exec.duration}s)
                              </span>
                            )}
                          </div>
                          {exec.actualResults && (
                            <p className="text-sm text-slate-700 dark:text-slate-300 mt-1">
                              <strong>Results:</strong> {exec.actualResults}
                            </p>
                          )}
                          {exec.notes && (
                            <p className="text-sm text-slate-500 mt-1">
                              {exec.notes}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="relationships" className="mt-6 space-y-6">
          {currentTestCase.id ? (
            <>
              <DigitalThreadNavigator
                itemId={currentTestCase.id}
                itemNumber={currentTestCase.itemNumber}
                itemName={currentTestCase.name}
                designId={currentTestCase.designId}
              />
              <RelationshipSection
                itemId={currentTestCase.id}
                itemType="TestCase"
              />
            </>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-slate-500">
                  Save the test case first to manage relationships
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {!isCreateMode && (
          <TabsContent value="history" className="mt-6">
            <ItemHistoryTab
              itemId={currentTestCase.id!}
              designId={currentTestCase.designId}
              versionContext={context}
              onViewHistoricalState={setContext}
            />
          </TabsContent>
        )}
      </Tabs>

      {!isCreateMode && currentTestCase.id && currentTestCase.designId && (
        <CheckoutDialog
          open={isCheckoutDialogOpen}
          onOpenChange={setIsCheckoutDialogOpen}
          itemId={currentTestCase.id}
          itemNumber={currentTestCase.itemNumber ?? ''}
          designId={currentTestCase.designId}
          onCheckoutComplete={handleCheckoutComplete}
        />
      )}
    </PageContainer>
  )
}
