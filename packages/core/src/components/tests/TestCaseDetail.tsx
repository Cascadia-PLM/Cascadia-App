// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Edit,
  GitBranch,
  History,
  Loader2,
  Lock,
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
import { useEditLock } from '@/lib/hooks/useEditLock'
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
import {
  branchDetailQuery,
  entityQuery,
  itemCollectionQuery,
  testCaseExecutionsQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'
import { itemAtContextQuery } from '@/lib/query/options/items'
import { StateBadge } from '@/components/items/StateBadge'
import { FreeTransitionControl } from '@/components/items/FreeTransitionControl'
import { useReleasedFamily } from '@/lib/hooks/useReleasedFamily'

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
  itemType: 'TestCase',
  itemNumber: '',
  name: '',
  state: '',
  isCurrent: true,
  designId: '',
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

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart; the `onValueChange` cast below is the one seam where
 * Radix's `string` meets it, and the triggers are rendered from the same
 * source of truth.
 */
export const TEST_CASE_DETAIL_TABS = [
  'details',
  'executions',
  'relationships',
  'history',
] as const
export type TestCaseDetailTab = (typeof TEST_CASE_DETAIL_TABS)[number]

interface TestCaseDetailProps {
  /** Called after a lifecycle transition succeeds (refresh the item) */
  onTransitioned?: () => void
  testCase?: TestCase
  designs?: Array<Design>
  defaultDesignId?: string
  defaultTestPlanId?: string
  onSave: (testCase: TestCase, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: TestCaseDetailTab
  onTabChange?: (tab: TestCaseDetailTab) => void
}

export function TestCaseDetail({
  onTransitioned,
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
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError } = useErrorHandler()

  const isCreateMode = !initialTestCase?.id

  const [testCase, setTestCase] = useState<TestCase>(
    () =>
      initialTestCase || {
        ...createEmptyTestCase(),
        designId: defaultDesignId ?? '',
        testPlanId: defaultTestPlanId,
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)

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

  // The testCase as it stood at the selected version context. Viewing `main`
  // addresses nothing, so the query stays disabled and the caller's copy is
  // shown — the same rule the shared factory encodes for every detail page.
  const { data: versionAtContext, isFetching: isLoadingVersion } = useQuery(
    itemAtContextQuery<TestCase>(
      testCase.id ?? '',
      context,
      !isCreateMode && Boolean(testCase.designId),
    ),
  )
  const displayedTestCase = isCreateMode
    ? testCase
    : (versionAtContext ?? testCase)

  const invalidate = useInvalidateResources()

  // Execution history. Recording a run invalidates `test-cases`, which
  // refreshes this without a hand-rolled refetch.
  const { data: executions = [], isLoading: loadingExecutions } = useQuery(
    testCaseExecutionsQuery(testCase.id ?? '', !isCreateMode && !!testCase.id),
  )

  // The parent plan, for the header link. Read through the items cache so it
  // is shared with whatever else has already loaded it.
  const { data: testPlan = null } = useQuery(
    entityQuery<TestPlan>(
      'items',
      testCase.testPlanId ?? '',
      'item',
      !!testCase.testPlanId,
    ),
  )

  // Plans available as a parent while creating, scoped to the chosen design.
  const { data: availableTestPlans = [] } = useQuery({
    ...itemCollectionQuery<TestPlan>({
      itemType: 'TestPlan',
      designId: testCase.designId,
    }),
    enabled: isCreateMode && !!testCase.designId,
  })

  useEffect(() => {
    if (initialTestCase) {
      setTestCase(initialTestCase)
      setSteps(initialTestCase.steps || [])
    }
  }, [initialTestCase])

  // Whether the viewing context is a workspace branch, read through the
  // shared cache rather than a per-mount probe.
  const { data: contextBranch } = useQuery(
    branchDetailQuery(
      context.type === 'branch' ? (context.branchId ?? '') : '',
      !isCreateMode,
    ),
  )
  const isWorkspaceContext = contextBranch?.branchType === 'workspace'

  const currentTestCase = isCreateMode ? testCase : displayedTestCase

  const updateField = (field: keyof TestCase, value: any) => {
    setTestCase((prev) => ({ ...prev, [field]: value }))
  }

  // Only released lineage is revised through a change order; a Free
  // lifecycle defines no release mappings, so this stays false for it
  const { isReleasedFamily: isReleasedLineage } = useReleasedFamily(
    'TestCase',
    currentTestCase.state,
  )
  const needsCheckout =
    !isCreateMode && isReleasedLineage && context.type === 'main'

  // The server-side edit lock behind the Edit button. Released-on-main goes
  // through the CheckoutDialog (revise onto a branch) instead of a direct
  // main-branch lock, so treat that case as "protected main" for the hook.
  const editLock = useEditLock({
    itemId: isCreateMode ? undefined : currentTestCase.id,
    designId: isCreateMode ? undefined : testCase.designId,
    context,
    isMainProtected: needsCheckout,
  })

  const handleEdit = async () => {
    if (needsCheckout) {
      setIsCheckoutDialogOpen(true)
      return
    }
    // Acquire the edit lock (checkout) before entering edit mode — the
    // server rejects saves without it, and other users see the lock.
    if (!isCreateMode && editLock.canLock && !editLock.heldByMe) {
      try {
        await editLock.acquire()
      } catch (error) {
        handleError(error, { title: 'Cannot edit item' })
        return
      }
    }
    setTestCase(currentTestCase)
    setSteps(currentTestCase.steps || [])
    setIsEditing(true)
  }

  // A revise-checkout mints the branch working copy up front, so editing
  // belongs on that row's page: the route-level save PUTs the id in the URL,
  // and from the released row's page it would target the released version and
  // be refused (BRANCH_PROTECTED). Navigate there in edit mode — the route
  // component survives the param change, so `isEditing` carries over and the
  // working copy (with its steps) drops in via the initialTestCase effect.
  const handleCheckoutComplete = (branchId: string, currentItemId?: string) => {
    setTestCase(currentTestCase)
    setSteps(currentTestCase.steps || [])
    setIsEditing(true)
    if (currentItemId && currentItemId !== currentTestCase.id) {
      navigate({
        to: '/test-cases/$id',
        params: { id: currentItemId },
        search: { branch: branchId, tab: activeTab },
      } as any)
      return
    }
    // The branch still tracks the row this page is showing — edit in place.
    setContext({ type: 'branch', branchId })
  }

  const handleSave = async () => {
    const branchId = context.type === 'branch' ? context.branchId : undefined
    const dataToSave = { ...testCase, steps }
    await onSave(dataToSave, branchId)
    if (!isCreateMode) {
      // Leaving edit mode releases the lock (changes are kept)
      if (editLock.heldByMe) {
        try {
          await editLock.checkin()
        } catch {
          // Lock release is best-effort; the user can re-enter edit mode
        }
      }
      setIsEditing(false)
    }
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      if (editLock.heldByMe) {
        // Discard the checkout (removes the untouched branch row entirely)
        void editLock.cancel().catch(() => {})
      }
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
    if (editLock.lockedByOther) {
      return `Checked out by ${editLock.lockHolderLabel}`
    }
    return undefined
  }

  const handleExecuteTest = async () => {
    if (!currentTestCase.id) return
    setExecutingTest(true)
    try {
      await apiFetch(`/api/v1/test-cases/${currentTestCase.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({
          status: executionStatus,
          actualResults,
          notes: executionNotes,
        }),
      })

      // Recording a run rewrites the test case's execution status as well as
      // its history, so refresh both through the cache rather than refetching
      // each by hand.
      await invalidate('test-cases')

      const tcResponse = await apiFetch<{ data: { item: TestCase } }>(
        `/api/v1/items/${currentTestCase.id}`,
      )
      setTestCase(tcResponse.data.item)
      // Reset form
      setShowExecutionForm(false)
      setActualResults('')
      setExecutionNotes('')
    } catch (error) {
      handleError(error, { title: 'Could not record execution' })
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
    const existing = newSteps[index]
    if (!existing) return
    newSteps[index] = { ...existing, [field]: value }
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
              {!isCreateMode && (
                <>
                  <StateBadge
                    itemType="TestCase"
                    state={currentTestCase.state}
                    className="text-base"
                  />
                  {currentTestCase.id && (
                    <FreeTransitionControl
                      itemId={currentTestCase.id}
                      state={currentTestCase.state}
                      onTransitioned={onTransitioned}
                    />
                  )}
                </>
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
              {!isCreateMode && editLock.status?.isCheckedOut && (
                <Badge
                  variant="outline"
                  className="text-sm text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700"
                >
                  <Lock className="h-3 w-3 mr-1" />
                  {editLock.heldByMe
                    ? 'Checked out by you'
                    : `Checked out by ${editLock.lockHolderLabel}`}
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
                          disabled={!isEditable || editLock.lockedByOther}
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
                    disabled={!isEditable || editLock.lockedByOther}
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

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange?.(value as TestCaseDetailTab)}
        className="w-full"
      >
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
                {(isCreateMode || !currentTestCase.designId) &&
                  designs.length > 0 && (
                    <ViewEditSelect
                      label="Design"
                      value={
                        isEditing ? testCase.designId : currentTestCase.designId
                      }
                      onChange={(v) => updateField('designId', v)}
                      isEditing={isEditing && isCreateMode}
                      options={designs.map((d) => ({
                        value: d.id,
                        label: `${d.code} - ${d.name}`,
                      }))}
                      placeholder="Select a design..."
                      data-testid="design-selector"
                    />
                  )}
                {/* Once saved the parent plan is a link; while creating it is
                    a picker over the plans in the chosen design. */}
                {testPlan ? (
                  <ViewEditStatic
                    label="Test Plan"
                    value={
                      <Link
                        to="/test-plans/$id"
                        params={{ id: testPlan.id! }}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        {testPlan.itemNumber} - {testPlan.name}
                      </Link>
                    }
                    className="md:col-span-2"
                  />
                ) : (
                  isCreateMode && (
                    <ViewEditSelect
                      label="Test Plan"
                      value={testCase.testPlanId}
                      onChange={(v) => updateField('testPlanId', v)}
                      isEditing={isEditing}
                      options={availableTestPlans.map((p) => ({
                        value: p.id ?? '',
                        label: `${p.itemNumber} - ${p.name}`,
                      }))}
                      placeholder={
                        testCase.designId
                          ? 'Select a test plan (optional)...'
                          : 'Choose a design first'
                      }
                      data-testid="test-plan-selector"
                    />
                  )
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
                              className="text-red-500 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30"
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
                readOnly={!isEditing}
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
