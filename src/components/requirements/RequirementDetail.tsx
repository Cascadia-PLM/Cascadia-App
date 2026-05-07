import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Edit,
  GitBranch,
  Loader2,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { RequirementVerificationPanel } from './RequirementVerificationPanel'
import type { Requirement } from '@/lib/items/types/requirement'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { RelationshipSection } from '@/components/items/RelationshipSection'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { CheckoutDialog } from '@/components/items/CheckoutDialog'
import { ImpactAnalysisDialog } from '@/components/impact'
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
  { value: 'Implemented', label: 'Implemented' },
  { value: 'Verified', label: 'Verified' },
  { value: 'Rejected', label: 'Rejected' },
]

const TYPE_OPTIONS = [
  { value: 'Functional', label: 'Functional' },
  { value: 'Non-Functional', label: 'Non-Functional' },
  { value: 'Performance', label: 'Performance' },
  { value: 'Security', label: 'Security' },
  { value: 'Usability', label: 'Usability' },
  { value: 'Business', label: 'Business' },
]

const PRIORITY_OPTIONS = [
  { value: 'MustHave', label: 'Must Have' },
  { value: 'ShouldHave', label: 'Should Have' },
  { value: 'CouldHave', label: 'Could Have' },
  { value: 'WontHave', label: "Won't Have" },
]

const STATUS_OPTIONS = [
  { value: 'Proposed', label: 'Proposed' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Implemented', label: 'Implemented' },
  { value: 'Verified', label: 'Verified' },
  { value: 'Rejected', label: 'Rejected' },
]

const VERIFICATION_METHOD_OPTIONS = [
  { value: 'Analysis', label: 'Analysis' },
  { value: 'Inspection', label: 'Inspection' },
  { value: 'Demonstration', label: 'Demonstration' },
  { value: 'Test', label: 'Test' },
]

const VERIFICATION_STATUS_OPTIONS = [
  { value: 'NotStarted', label: 'Not Started' },
  { value: 'InProgress', label: 'In Progress' },
  { value: 'Passed', label: 'Passed' },
  { value: 'Failed', label: 'Failed' },
  { value: 'Waived', label: 'Waived' },
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
    Implemented: 'success',
    Verified: 'success',
    Rejected: 'destructive',
  }
  return variants[state] || 'default'
}

const priorityVariant = (priority: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    MustHave: 'destructive',
    ShouldHave: 'warning',
    CouldHave: 'default',
    WontHave: 'secondary',
  }
  return variants[priority] || 'default'
}

const verificationStatusVariant = (status: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    NotStarted: 'secondary',
    InProgress: 'default',
    Passed: 'success',
    Failed: 'destructive',
    Waived: 'secondary',
  }
  return variants[status] || 'secondary'
}

const createEmptyRequirement = (): Requirement => ({
  id: undefined,
  masterId: undefined,
  itemNumber: '',
  revision: 'A',
  name: '',
  description: '',
  state: 'Draft',
  isCurrent: true,
  type: undefined,
  priority: undefined,
  status: undefined,
  source: undefined,
  category: undefined,
  acceptanceCriteria: undefined,
  designId: undefined,
  createdAt: undefined,
  modifiedAt: undefined,
  verificationMethod: undefined,
  verificationStatus: undefined,
  allocatedDesignId: undefined,
  parentRequirementId: undefined,
})

interface RequirementDetailProps {
  requirement?: Requirement
  designs?: Array<Design>
  defaultDesignId?: string
  onSave: (requirement: Requirement, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: 'details' | 'relationships' | 'history'
  onTabChange?: (tab: string) => void
}

export function RequirementDetail({
  requirement: initialRequirement,
  designs = [],
  defaultDesignId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: RequirementDetailProps) {
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  const isCreateMode = !initialRequirement?.id

  const [requirement, setRequirement] = useState<Requirement>(
    () =>
      initialRequirement || {
        ...createEmptyRequirement(),
        designId: defaultDesignId,
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)
  const [isImpactDialogOpen, setIsImpactDialogOpen] = useState(false)

  const [displayedRequirement, setDisplayedRequirement] =
    useState<Requirement>(requirement)
  const [isLoadingVersion, setIsLoadingVersion] = useState(false)
  const [isWorkspaceContext, setIsWorkspaceContext] = useState(false)

  const { context, contextLabel, isEditable, setContext } = useVersionContext(
    isCreateMode ? undefined : requirement.designId,
  )

  useEffect(() => {
    if (initialRequirement) {
      setRequirement(initialRequirement)
      setDisplayedRequirement(initialRequirement)
    }
  }, [initialRequirement])

  useEffect(() => {
    async function fetchVersionAtContext() {
      if (isCreateMode || !requirement.designId || context.type === 'main') {
        setDisplayedRequirement(requirement)
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
          setDisplayedRequirement(requirement)
          return
        }

        const response = await apiFetch<{ data: { item: Requirement | null } }>(
          `/api/v1/items/${requirement.id}/at-context?${queryString}`,
        )
        setDisplayedRequirement(response.data.item || requirement)
      } catch {
        setDisplayedRequirement(requirement)
      } finally {
        setIsLoadingVersion(false)
      }
    }
    fetchVersionAtContext()
  }, [requirement, context, isCreateMode])

  useEffect(() => {
    async function checkIfWorkspace() {
      if (context.type !== 'branch' || !context.branchId) {
        setIsWorkspaceContext(false)
        return
      }
      try {
        const response = await apiFetch<{
          data: { branch: { branchType: string } }
        }>(`/api/v1/branches/${context.branchId}`)
        setIsWorkspaceContext(response.data.branch.branchType === 'workspace')
      } catch {
        setIsWorkspaceContext(false)
      }
    }
    if (!isCreateMode) checkIfWorkspace()
  }, [context, isCreateMode])

  const currentRequirement = isCreateMode ? requirement : displayedRequirement

  const updateField = (field: keyof Requirement, value: any) => {
    setRequirement((prev) => ({ ...prev, [field]: value }))
  }

  const needsCheckout =
    !isCreateMode &&
    ['Approved', 'Verified', 'Implemented'].includes(
      currentRequirement.state ?? '',
    ) &&
    context.type === 'main'

  const handleEdit = () => {
    if (needsCheckout) {
      setIsCheckoutDialogOpen(true)
      return
    }
    setRequirement(currentRequirement)
    setIsEditing(true)
  }

  const handleCheckoutComplete = (branchId: string) => {
    setContext({ type: 'branch', branchId })
    setRequirement(currentRequirement)
    setIsEditing(true)
  }

  const handleSave = async () => {
    const branchId = context.type === 'branch' ? context.branchId : undefined
    await onSave(requirement, branchId)
    if (!isCreateMode) setIsEditing(false)
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      setRequirement(currentRequirement)
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentRequirement.id) return
    confirm({
      title: 'Delete Requirement',
      description: `Are you sure you want to delete ${currentRequirement.itemNumber}? This action cannot be undone.`,
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

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/requirements">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode
                  ? 'Create New Requirement'
                  : currentRequirement.itemNumber}
              </h1>
              {!isCreateMode && isLoadingVersion && (
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              )}
              {!isCreateMode && currentRequirement.state && (
                <Badge
                  className="text-base"
                  variant={stateVariant(currentRequirement.state)}
                >
                  {currentRequirement.state}
                </Badge>
              )}
              {!isCreateMode &&
                currentRequirement.designId &&
                context.type !== 'main' && (
                  <Badge variant={getContextBadgeVariant()} className="text-sm">
                    <GitBranch className="h-3 w-3 mr-1" />
                    {contextLabel}
                  </Badge>
                )}
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {isCreateMode
                ? 'Enter the details for the new requirement'
                : `Revision ${currentRequirement.revision} • ${currentRequirement.name || 'Unnamed'}`}
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
                <Button
                  onClick={handleSave}
                  disabled={isSubmitting}
                  data-testid="requirement-submit"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {isSubmitting
                    ? 'Saving...'
                    : isCreateMode
                      ? 'Create Requirement'
                      : 'Save Changes'}
                </Button>
              </>
            ) : (
              <>
                {!isCreateMode && currentRequirement.id && (
                  <Button
                    variant="outline"
                    onClick={() => setIsImpactDialogOpen(true)}
                  >
                    <Search className="h-4 w-4 mr-2" />
                    Impact Analysis
                  </Button>
                )}
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
          className={`grid w-full ${isCreateMode ? 'grid-cols-2' : 'grid-cols-3'}`}
        >
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          {!isCreateMode && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>

        <TabsContent
          value="details"
          className="mt-6"
          data-testid="requirement-form"
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Content - Left 2 columns */}
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                  <CardDescription>
                    General information about this requirement
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="Item Number"
                      value={
                        isEditing
                          ? requirement.itemNumber
                          : currentRequirement.itemNumber
                      }
                      onChange={(v) => updateField('itemNumber', v)}
                      isEditing={isEditing && isCreateMode}
                      placeholder="REQ-001"
                      required
                      data-testid="requirement-item-number"
                    />
                    <ViewEditText
                      label="Revision"
                      value={currentRequirement.revision}
                      onChange={() => {}}
                      isEditing={false}
                    />
                    <ViewEditText
                      label="Name"
                      value={
                        isEditing ? requirement.name : currentRequirement.name
                      }
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="Requirement name"
                      required
                      data-testid="requirement-name"
                    />
                    <ViewEditBadge
                      label="State"
                      value={currentRequirement.state}
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
                          ? requirement.description
                          : currentRequirement.description
                      }
                      onChange={(v) => updateField('description', v)}
                      isEditing={isEditing}
                      className="md:col-span-2"
                    />
                    {(isCreateMode || !currentRequirement.designId) &&
                      designs.length > 0 && (
                        <ViewEditSelect
                          label="Design"
                          value={
                            isEditing
                              ? requirement.designId
                              : currentRequirement.designId
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
                  <CardTitle>Requirement Details</CardTitle>
                  <CardDescription>
                    Classification and priority information
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditSelect
                      label="Type"
                      value={
                        isEditing ? requirement.type : currentRequirement.type
                      }
                      onChange={(v) => updateField('type', v)}
                      isEditing={isEditing}
                      options={TYPE_OPTIONS}
                      placeholder="Select type..."
                    />
                    <ViewEditBadge
                      label="Priority"
                      value={
                        isEditing
                          ? requirement.priority
                          : currentRequirement.priority
                      }
                      onChange={(v) => updateField('priority', v)}
                      isEditing={isEditing}
                      options={PRIORITY_OPTIONS}
                      variant={priorityVariant}
                    />
                    <ViewEditSelect
                      label="Status"
                      value={
                        isEditing
                          ? requirement.status
                          : currentRequirement.status
                      }
                      onChange={(v) => updateField('status', v)}
                      isEditing={isEditing}
                      options={STATUS_OPTIONS}
                      placeholder="Select status..."
                    />
                    <ViewEditText
                      label="Source"
                      value={
                        isEditing
                          ? requirement.source
                          : currentRequirement.source
                      }
                      onChange={(v) => updateField('source', v)}
                      isEditing={isEditing}
                      placeholder="Requirement source"
                    />
                    <ViewEditText
                      label="Category"
                      value={
                        isEditing
                          ? requirement.category
                          : currentRequirement.category
                      }
                      onChange={(v) => updateField('category', v)}
                      isEditing={isEditing}
                      placeholder="Category"
                      className="md:col-span-2"
                    />
                    <ViewEditTextarea
                      label="Acceptance Criteria"
                      value={
                        isEditing
                          ? requirement.acceptanceCriteria
                          : currentRequirement.acceptanceCriteria
                      }
                      onChange={(v) => updateField('acceptanceCriteria', v)}
                      isEditing={isEditing}
                      rows={4}
                      className="md:col-span-2"
                    />
                  </dl>
                </CardContent>
              </Card>

              {/* Verification Card */}
              <Card>
                <CardHeader>
                  <CardTitle>Verification</CardTitle>
                  <CardDescription>
                    How this requirement will be verified
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditSelect
                      label="Verification Method"
                      value={
                        isEditing
                          ? requirement.verificationMethod
                          : currentRequirement.verificationMethod
                      }
                      onChange={(v) => updateField('verificationMethod', v)}
                      isEditing={isEditing}
                      options={VERIFICATION_METHOD_OPTIONS}
                      placeholder="Select method..."
                    />
                    <ViewEditBadge
                      label="Verification Status"
                      value={
                        isEditing
                          ? requirement.verificationStatus
                          : currentRequirement.verificationStatus
                      }
                      onChange={(v) => updateField('verificationStatus', v)}
                      isEditing={isEditing}
                      options={VERIFICATION_STATUS_OPTIONS}
                      variant={verificationStatusVariant}
                    />
                  </dl>
                </CardContent>
              </Card>

              {/* Verification Panel - Test Cases */}
              {!isCreateMode && currentRequirement.id && (
                <RequirementVerificationPanel
                  requirementId={currentRequirement.id}
                  designId={currentRequirement.designId}
                  isEditable={isEditable}
                />
              )}
            </div>

            {/* Sidebar - Right column */}
            <div className="space-y-6">
              <Collapsible defaultOpen={false}>
                <Card>
                  <CardHeader>
                    <CollapsibleTrigger className="hover:opacity-70">
                      <CardTitle>Metadata</CardTitle>
                    </CollapsibleTrigger>
                  </CardHeader>
                  <CollapsibleContent>
                    <CardContent className="space-y-3">
                      <ViewEditStatic
                        label="Created"
                        value={
                          currentRequirement.createdAt
                            ? new Date(
                                currentRequirement.createdAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      <ViewEditStatic
                        label="Last Modified"
                        value={
                          currentRequirement.modifiedAt
                            ? new Date(
                                currentRequirement.modifiedAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      {!isCreateMode && (
                        <>
                          <ViewEditStatic
                            label="Master ID"
                            value={currentRequirement.masterId}
                            mono
                          />
                          <ViewEditStatic
                            label="Requirement ID"
                            value={currentRequirement.id}
                            mono
                          />
                        </>
                      )}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="relationships" className="mt-6 space-y-6">
          {currentRequirement.id ? (
            <>
              <DigitalThreadNavigator
                itemId={currentRequirement.id}
                itemNumber={currentRequirement.itemNumber}
                itemName={currentRequirement.name}
                designId={currentRequirement.designId}
              />
              <RelationshipSection
                itemId={currentRequirement.id}
                itemType="Requirement"
              />
            </>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-slate-500">
                  Save the requirement first to manage relationships
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {!isCreateMode && (
          <TabsContent value="history" className="mt-6">
            <ItemHistoryTab
              itemId={currentRequirement.id!}
              designId={currentRequirement.designId}
              versionContext={context}
              onViewHistoricalState={setContext}
            />
          </TabsContent>
        )}
      </Tabs>

      {!isCreateMode &&
        currentRequirement.id &&
        currentRequirement.designId && (
          <CheckoutDialog
            open={isCheckoutDialogOpen}
            onOpenChange={setIsCheckoutDialogOpen}
            itemId={currentRequirement.id}
            itemNumber={currentRequirement.itemNumber ?? ''}
            designId={currentRequirement.designId}
            onCheckoutComplete={handleCheckoutComplete}
          />
        )}

      {/* Impact Analysis Dialog */}
      {!isCreateMode && currentRequirement.id && (
        <ImpactAnalysisDialog
          open={isImpactDialogOpen}
          onOpenChange={setIsImpactDialogOpen}
          itemId={currentRequirement.id}
          itemNumber={currentRequirement.itemNumber ?? ''}
          itemName={currentRequirement.name}
        />
      )}
    </PageContainer>
  )
}
