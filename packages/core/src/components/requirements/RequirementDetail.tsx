// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Edit,
  GitBranch,
  Loader2,
  Lock,
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
import { itemAtContextQuery } from '@/lib/query/options/items'
import { branchDetailQuery, designStatusQuery } from '@/lib/query'
import { StateBadge } from '@/components/items/StateBadge'
import { useReleasedFamily } from '@/lib/hooks/useReleasedFamily'
import { FreeTransitionControl } from '@/components/items/FreeTransitionControl'
import { ItemCreateDesignSection } from '@/components/items/ItemCreateDesignSection'

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

const VERIFICATION_METHOD_OPTIONS = [
  { value: 'Analysis', label: 'Analysis' },
  { value: 'Inspection', label: 'Inspection' },
  { value: 'Demonstration', label: 'Demonstration' },
  { value: 'Test', label: 'Test' },
  { value: 'Documentation', label: 'Documentation' },
]

const VERIFICATION_STATUS_OPTIONS = [
  { value: 'NotStarted', label: 'Not Started' },
  { value: 'InProgress', label: 'In Progress' },
  { value: 'Passed', label: 'Passed' },
  { value: 'Failed', label: 'Failed' },
  { value: 'Waived', label: 'Waived' },
]

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
  itemType: 'Requirement',
  itemNumber: '',
  name: '',
  description: '',
  state: '',
  isCurrent: true,
  type: undefined,
  priority: undefined,
  source: undefined,
  category: undefined,
  acceptanceCriteria: undefined,
  designId: '',
  createdAt: undefined,
  modifiedAt: undefined,
  verificationMethod: undefined,
  verificationStatus: undefined,
  allocatedDesignId: undefined,
  parentRequirementId: undefined,
})

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart; the `onValueChange` cast below is the one seam where
 * Radix's `string` meets it, and the triggers are rendered from the same
 * source of truth.
 */
export const REQUIREMENT_DETAIL_TABS = [
  'details',
  'relationships',
  'history',
] as const
export type RequirementDetailTab = (typeof REQUIREMENT_DETAIL_TABS)[number]

interface RequirementDetailProps {
  /** Called after a lifecycle transition succeeds (refresh the item) */
  onTransitioned?: () => void
  requirement?: Requirement
  designs?: Array<Design>
  defaultDesignId?: string
  onSave: (requirement: Requirement, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: RequirementDetailTab
  onTabChange?: (tab: RequirementDetailTab) => void
}

export function RequirementDetail({
  onTransitioned,
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
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError } = useErrorHandler()

  const isCreateMode = !initialRequirement?.id

  const [requirement, setRequirement] = useState<Requirement>(
    () =>
      initialRequirement || {
        ...createEmptyRequirement(),
        designId: defaultDesignId ?? '',
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)
  const [isImpactDialogOpen, setIsImpactDialogOpen] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()

  const { data: createDesignStatus = null } = useQuery(
    designStatusQuery(
      requirement.designId,
      isCreateMode && Boolean(requirement.designId),
    ),
  )
  const createBranchRequired =
    createDesignStatus?.protection.phase === 'post-release'

  const { context, contextLabel, isEditable, setContext } = useVersionContext(
    isCreateMode ? undefined : requirement.designId,
  )

  // The requirement as it stood at the selected version context. Viewing `main`
  // addresses nothing, so the query stays disabled and the caller's copy is
  // shown — the same rule the shared factory encodes for every detail page.
  const { data: versionAtContext, isFetching: isLoadingVersion } = useQuery(
    itemAtContextQuery<Requirement>(
      requirement.id ?? '',
      context,
      !isCreateMode && Boolean(requirement.designId),
    ),
  )
  const displayedRequirement = isCreateMode
    ? requirement
    : (versionAtContext ?? requirement)

  useEffect(() => {
    if (initialRequirement) {
      setRequirement(initialRequirement)
    }
  }, [initialRequirement])

  // Whether the viewing context is a workspace branch, read through the
  // shared cache rather than a per-mount probe.
  const { data: contextBranch } = useQuery(
    branchDetailQuery(
      context.type === 'branch' ? (context.branchId ?? '') : '',
      !isCreateMode,
    ),
  )
  const isWorkspaceContext = contextBranch?.branchType === 'workspace'

  const currentRequirement = isCreateMode ? requirement : displayedRequirement

  const updateField = (field: keyof Requirement, value: any) => {
    setRequirement((prev) => ({ ...prev, [field]: value }))
  }

  // Released lineage on main is revised through a change order (the
  // CheckoutDialog); membership comes from the lifecycle's mappings
  const { isReleasedFamily: isReleasedLineage } = useReleasedFamily(
    'Requirement',
    currentRequirement.state,
  )
  const needsCheckout =
    !isCreateMode && isReleasedLineage && context.type === 'main'

  // The server-side edit lock behind the Edit button. Released-on-main goes
  // through the CheckoutDialog (revise onto a branch) instead of a direct
  // main-branch lock, so treat that case as "protected main" for the hook.
  const editLock = useEditLock({
    itemId: isCreateMode ? undefined : currentRequirement.id,
    designId: isCreateMode ? undefined : requirement.designId,
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
    setRequirement(currentRequirement)
    setIsEditing(true)
  }

  // A revise-checkout mints the branch working copy up front, so editing
  // belongs on that row's page: the route-level save PUTs the id in the URL,
  // and from the released row's page it would target the released version and
  // be refused (BRANCH_PROTECTED). Navigate there in edit mode — the route
  // component survives the param change, so `isEditing` carries over and the
  // working copy drops into the form via the initialRequirement effect above.
  const handleCheckoutComplete = (branchId: string, currentItemId?: string) => {
    setRequirement(currentRequirement)
    setIsEditing(true)
    if (currentItemId && currentItemId !== currentRequirement.id) {
      navigate({
        to: '/requirements/$id',
        params: { id: currentItemId },
        search: { branch: branchId, tab: activeTab },
      } as any)
      return
    }
    // The branch still tracks the row this page is showing — edit in place.
    setContext({ type: 'branch', branchId })
  }

  const handleSave = async () => {
    const branchId = isCreateMode
      ? selectedBranchId
      : context.type === 'branch'
        ? context.branchId
        : undefined
    await onSave(requirement, branchId)
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
    if (editLock.lockedByOther) {
      return `Checked out by ${editLock.lockHolderLabel}`
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
              {!isCreateMode && (
                <>
                  <StateBadge
                    itemType="Requirement"
                    state={currentRequirement.state}
                    className="text-base"
                  />
                  {currentRequirement.id && (
                    <FreeTransitionControl
                      itemId={currentRequirement.id}
                      state={currentRequirement.state}
                      onTransitioned={onTransitioned}
                    />
                  )}
                </>
              )}
              {!isCreateMode &&
                currentRequirement.designId &&
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
                  disabled={
                    isSubmitting ||
                    (isCreateMode && createBranchRequired && !selectedBranchId)
                  }
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

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange?.(value as RequirementDetailTab)}
        className="w-full"
      >
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
                        <ItemCreateDesignSection
                          designs={designs}
                          designId={requirement.designId}
                          displayedDesignId={currentRequirement.designId}
                          onDesignChange={(value) => {
                            updateField('designId', value)
                            setSelectedBranchId(undefined)
                          }}
                          isEditing={isEditing}
                          isCreateMode={isCreateMode}
                          selectedBranchId={selectedBranchId}
                          onBranchChange={setSelectedBranchId}
                          itemLabel="requirement"
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
                readOnly={!isEditing}
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
