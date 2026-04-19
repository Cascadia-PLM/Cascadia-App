import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Edit,
  GitBranch,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import type { TestPlan } from '@/lib/items/types/testplan'
import type { TestCase } from '@/lib/items/types/testcase'
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
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

const STATE_OPTIONS = [
  { value: 'Draft', label: 'Draft' },
  { value: 'Proposed', label: 'Proposed' },
  { value: 'InReview', label: 'In Review' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Released', label: 'Released' },
]

const STATUS_OPTIONS = [
  { value: 'Draft', label: 'Draft' },
  { value: 'Active', label: 'Active' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Archived', label: 'Archived' },
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

const statusVariant = (status: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Draft: 'secondary',
    Active: 'default',
    Completed: 'success',
    Archived: 'secondary',
  }
  return variants[status] || 'default'
}

const createEmptyTestPlan = (): TestPlan => ({
  id: undefined,
  masterId: undefined,
  itemNumber: '',
  revision: 'A',
  name: '',
  description: '',
  state: 'Draft',
  isCurrent: true,
  designId: undefined,
  scope: undefined,
  environment: undefined,
  entryCriteria: undefined,
  exitCriteria: undefined,
  status: undefined,
  createdAt: undefined,
  modifiedAt: undefined,
})

interface TestPlanDetailProps {
  testPlan?: TestPlan
  designs?: Array<Design>
  defaultDesignId?: string
  onSave: (testPlan: TestPlan, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: 'details' | 'test-cases' | 'relationships' | 'history'
  onTabChange?: (tab: string) => void
}

export function TestPlanDetail({
  testPlan: initialTestPlan,
  designs = [],
  defaultDesignId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: TestPlanDetailProps) {
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  const isCreateMode = !initialTestPlan?.id

  const [testPlan, setTestPlan] = useState<TestPlan>(
    () =>
      initialTestPlan || {
        ...createEmptyTestPlan(),
        designId: defaultDesignId,
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)

  const [displayedTestPlan, setDisplayedTestPlan] = useState<TestPlan>(testPlan)
  const [isLoadingVersion, setIsLoadingVersion] = useState(false)
  const [isWorkspaceContext, setIsWorkspaceContext] = useState(false)

  // Test cases in this plan
  const [testCases, setTestCases] = useState<Array<TestCase>>([])
  const [loadingTestCases, setLoadingTestCases] = useState(false)

  const { context, contextLabel, isEditable, setContext } = useVersionContext(
    isCreateMode ? undefined : testPlan.designId,
  )

  useEffect(() => {
    if (initialTestPlan) {
      setTestPlan(initialTestPlan)
      setDisplayedTestPlan(initialTestPlan)
    }
  }, [initialTestPlan])

  useEffect(() => {
    async function fetchVersionAtContext() {
      if (isCreateMode || !testPlan.designId || context.type === 'main') {
        setDisplayedTestPlan(testPlan)
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
          setDisplayedTestPlan(testPlan)
          return
        }

        const response = await apiFetch<{ data: { item: TestPlan | null } }>(
          `/api/items/${testPlan.id}/at-context?${queryString}`,
        )
        setDisplayedTestPlan(response.data.item || testPlan)
      } catch {
        setDisplayedTestPlan(testPlan)
      } finally {
        setIsLoadingVersion(false)
      }
    }
    fetchVersionAtContext()
  }, [testPlan, context, isCreateMode])

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

  // Fetch test cases for this plan
  useEffect(() => {
    async function fetchTestCases() {
      if (isCreateMode || !testPlan.id) return
      setLoadingTestCases(true)
      try {
        const response = await apiFetch<{
          data: { testCases: Array<TestCase> }
        }>(`/api/test-plans/${testPlan.id}/test-cases`)
        setTestCases(response.data.testCases || [])
      } catch {
        setTestCases([])
      } finally {
        setLoadingTestCases(false)
      }
    }
    fetchTestCases()
  }, [testPlan.id, isCreateMode])

  const currentTestPlan = isCreateMode ? testPlan : displayedTestPlan

  const updateField = (field: keyof TestPlan, value: any) => {
    setTestPlan((prev) => ({ ...prev, [field]: value }))
  }

  const needsCheckout =
    !isCreateMode &&
    ['Approved', 'Released'].includes(currentTestPlan.state ?? '') &&
    context.type === 'main'

  const handleEdit = () => {
    if (needsCheckout) {
      setIsCheckoutDialogOpen(true)
      return
    }
    setTestPlan(currentTestPlan)
    setIsEditing(true)
  }

  const handleCheckoutComplete = (branchId: string) => {
    setContext({ type: 'branch', branchId })
    setTestPlan(currentTestPlan)
    setIsEditing(true)
  }

  const handleSave = async () => {
    const branchId = context.type === 'branch' ? context.branchId : undefined
    await onSave(testPlan, branchId)
    if (!isCreateMode) setIsEditing(false)
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      setTestPlan(currentTestPlan)
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentTestPlan.id) return
    confirm({
      title: 'Delete Test Plan',
      description: `Are you sure you want to delete ${currentTestPlan.itemNumber}? This action cannot be undone.`,
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

  const getExecutionSummary = () => {
    if (testCases.length === 0) return null
    const passed = testCases.filter(
      (tc) => tc.executionStatus === 'Passed',
    ).length
    const failed = testCases.filter(
      (tc) => tc.executionStatus === 'Failed',
    ).length
    const blocked = testCases.filter(
      (tc) => tc.executionStatus === 'Blocked',
    ).length
    const notRun = testCases.filter(
      (tc) => tc.executionStatus === 'NotRun' || !tc.executionStatus,
    ).length
    return { passed, failed, blocked, notRun, total: testCases.length }
  }

  const summary = getExecutionSummary()

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/test-plans">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode
                  ? 'Create New Test Plan'
                  : currentTestPlan.itemNumber}
              </h1>
              {!isCreateMode && isLoadingVersion && (
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              )}
              {!isCreateMode && currentTestPlan.state && (
                <Badge
                  className="text-base"
                  variant={stateVariant(currentTestPlan.state)}
                >
                  {currentTestPlan.state}
                </Badge>
              )}
              {!isCreateMode &&
                currentTestPlan.designId &&
                context.type !== 'main' && (
                  <Badge variant={getContextBadgeVariant()} className="text-sm">
                    <GitBranch className="h-3 w-3 mr-1" />
                    {contextLabel}
                  </Badge>
                )}
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {isCreateMode
                ? 'Enter the details for the new test plan'
                : `Revision ${currentTestPlan.revision} • ${currentTestPlan.name || 'Unnamed'}`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-2">
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
                      ? 'Create Test Plan'
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

      <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
        <TabsList
          className={`grid w-full ${isCreateMode ? 'grid-cols-2' : 'grid-cols-4'}`}
        >
          <TabsTrigger value="details">Details</TabsTrigger>
          {!isCreateMode && (
            <TabsTrigger value="test-cases">Test Cases</TabsTrigger>
          )}
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          {!isCreateMode && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>

        <TabsContent
          value="details"
          className="mt-6 space-y-6"
          data-testid="test-plan-form"
        >
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
              <CardDescription>
                General information about this test plan
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ViewEditText
                  label="Item Number"
                  value={
                    isEditing ? testPlan.itemNumber : currentTestPlan.itemNumber
                  }
                  onChange={(v) => updateField('itemNumber', v)}
                  isEditing={isEditing && isCreateMode}
                  placeholder="TP-001"
                  required
                  data-testid="test-plan-item-number"
                />
                <ViewEditText
                  label="Revision"
                  value={currentTestPlan.revision}
                  onChange={() => {}}
                  isEditing={false}
                />
                <ViewEditText
                  label="Name"
                  value={isEditing ? testPlan.name : currentTestPlan.name}
                  onChange={(v) => updateField('name', v)}
                  isEditing={isEditing}
                  placeholder="Test plan name"
                  required
                  data-testid="test-plan-name"
                />
                <ViewEditBadge
                  label="State"
                  value={currentTestPlan.state}
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
                      ? testPlan.description
                      : currentTestPlan.description
                  }
                  onChange={(v) => updateField('description', v)}
                  isEditing={isEditing}
                  className="md:col-span-2"
                />
                {(isCreateMode || !currentTestPlan.designId) &&
                  designs.length > 0 && (
                    <ViewEditSelect
                      label="Design"
                      value={
                        isEditing ? testPlan.designId : currentTestPlan.designId
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
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Test Plan Details</CardTitle>
              <CardDescription>
                Scope, environment, and criteria
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ViewEditTextarea
                  label="Scope"
                  value={isEditing ? testPlan.scope : currentTestPlan.scope}
                  onChange={(v) => updateField('scope', v)}
                  isEditing={isEditing}
                  rows={3}
                  className="md:col-span-2"
                />
                <ViewEditText
                  label="Environment"
                  value={
                    isEditing
                      ? testPlan.environment
                      : currentTestPlan.environment
                  }
                  onChange={(v) => updateField('environment', v)}
                  isEditing={isEditing}
                  placeholder="Lab, Staging, Production, etc."
                />
                <ViewEditBadge
                  label="Status"
                  value={isEditing ? testPlan.status : currentTestPlan.status}
                  onChange={(v) => updateField('status', v)}
                  isEditing={isEditing}
                  options={STATUS_OPTIONS}
                  variant={statusVariant}
                />
                <ViewEditTextarea
                  label="Entry Criteria"
                  value={
                    isEditing
                      ? testPlan.entryCriteria
                      : currentTestPlan.entryCriteria
                  }
                  onChange={(v) => updateField('entryCriteria', v)}
                  isEditing={isEditing}
                  rows={3}
                  className="md:col-span-2"
                />
                <ViewEditTextarea
                  label="Exit Criteria"
                  value={
                    isEditing
                      ? testPlan.exitCriteria
                      : currentTestPlan.exitCriteria
                  }
                  onChange={(v) => updateField('exitCriteria', v)}
                  isEditing={isEditing}
                  rows={3}
                  className="md:col-span-2"
                />
              </dl>
            </CardContent>
          </Card>

          {/* Execution Summary */}
          {!isCreateMode && summary && (
            <Card>
              <CardHeader>
                <CardTitle>Execution Summary</CardTitle>
                <CardDescription>Overall test execution status</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-slate-900 dark:text-white">
                      {summary.total}
                    </div>
                    <div className="text-sm text-slate-500">Total</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-600">
                      {summary.passed}
                    </div>
                    <div className="text-sm text-slate-500">Passed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-red-600">
                      {summary.failed}
                    </div>
                    <div className="text-sm text-slate-500">Failed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-yellow-600">
                      {summary.blocked}
                    </div>
                    <div className="text-sm text-slate-500">Blocked</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-slate-400">
                      {summary.notRun}
                    </div>
                    <div className="text-sm text-slate-500">Not Run</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

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
                        currentTestPlan.createdAt
                          ? new Date(
                              currentTestPlan.createdAt,
                            ).toLocaleDateString()
                          : '-'
                      }
                    />
                    <ViewEditStatic
                      label="Last Modified"
                      value={
                        currentTestPlan.modifiedAt
                          ? new Date(
                              currentTestPlan.modifiedAt,
                            ).toLocaleDateString()
                          : '-'
                      }
                    />
                    {!isCreateMode && (
                      <>
                        <ViewEditStatic
                          label="Master ID"
                          value={currentTestPlan.masterId}
                          mono
                        />
                        <ViewEditStatic
                          label="Test Plan ID"
                          value={currentTestPlan.id}
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
          <TabsContent value="test-cases" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Test Cases</CardTitle>
                    <CardDescription>
                      Test cases in this test plan
                    </CardDescription>
                  </div>
                  <Link
                    to="/test-cases/new"
                    search={{ testPlanId: currentTestPlan.id }}
                  >
                    <Button size="sm">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Test Case
                    </Button>
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {loadingTestCases ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                  </div>
                ) : testCases.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    No test cases in this plan yet
                  </div>
                ) : (
                  <div className="space-y-2">
                    {testCases.map((tc) => (
                      <Link
                        key={tc.id}
                        to="/test-cases/$id"
                        params={{ id: tc.id! }}
                        className="block"
                      >
                        <div className="flex items-center justify-between p-3 rounded-lg border hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-sm">
                              {tc.itemNumber}
                            </span>
                            <span className="text-slate-600 dark:text-slate-400">
                              {tc.name}
                            </span>
                          </div>
                          <Badge
                            variant={
                              tc.executionStatus === 'Passed'
                                ? 'success'
                                : tc.executionStatus === 'Failed'
                                  ? 'destructive'
                                  : tc.executionStatus === 'Blocked'
                                    ? 'warning'
                                    : 'secondary'
                            }
                          >
                            {tc.executionStatus || 'Not Run'}
                          </Badge>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="relationships" className="mt-6 space-y-6">
          {currentTestPlan.id ? (
            <>
              <DigitalThreadNavigator
                itemId={currentTestPlan.id}
                itemNumber={currentTestPlan.itemNumber}
                itemName={currentTestPlan.name}
                designId={currentTestPlan.designId}
              />
              <RelationshipSection
                itemId={currentTestPlan.id}
                itemType="TestPlan"
              />
            </>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-slate-500">
                  Save the test plan first to manage relationships
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {!isCreateMode && (
          <TabsContent value="history" className="mt-6">
            <ItemHistoryTab
              itemId={currentTestPlan.id!}
              designId={currentTestPlan.designId}
              versionContext={context}
              onViewHistoricalState={setContext}
            />
          </TabsContent>
        )}
      </Tabs>

      {!isCreateMode && currentTestPlan.id && currentTestPlan.designId && (
        <CheckoutDialog
          open={isCheckoutDialogOpen}
          onOpenChange={setIsCheckoutDialogOpen}
          itemId={currentTestPlan.id}
          itemNumber={currentTestPlan.itemNumber ?? ''}
          designId={currentTestPlan.designId}
          onCheckoutComplete={handleCheckoutComplete}
        />
      )}
    </PageContainer>
  )
}
