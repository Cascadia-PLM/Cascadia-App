// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The system element page, in create and detail mode. The scaffolding — the
 * version context, the edit lock, the revise-checkout, the three tabs — is
 * the requirement page's; the element's own content is its kind and
 * description, plus the three link panels: the elements it decomposes into,
 * the items that realize it, and the requirements allocated to it.
 */
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
import {
  SYSTEM_ELEMENT_KINDS,
  SYSTEM_ELEMENT_KIND_LABELS,
} from '@cascadia/commons/items/types/system-element'
import { SystemElementLinksPanel } from './SystemElementLinksPanel'
import { SystemElementPortsPanel } from './SystemElementPortsPanel'
import type { SystemElement } from '@cascadia/commons/items/types/system-element'
import type { Design } from '@cascadia/commons/types/design'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { RelationshipSection } from '@/components/items/RelationshipSection'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { CheckoutDialog } from '@/components/items/CheckoutDialog'
import { ImpactAnalysisDialog } from '@/components/impact'
import { useVersionContext } from '@/hooks/useVersionContext'
import { useEditLock, useItemEditContext } from '@/hooks/useEditLock'
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
  ViewEditSelect,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { useAlertDialog } from '@/hooks/useAlertDialog'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { itemAtContextQuery } from '@/query/options/items'
import { branchDetailQuery, designStatusQuery, qk } from '@/query'
import { apiFetch } from '@/api/client'
import { StateBadge } from '@/components/items/StateBadge'
import { ItemLink } from '@/components/items/ItemLink'
import { useReleasedFamily } from '@/hooks/useReleasedFamily'
import { FreeTransitionControl } from '@/components/items/FreeTransitionControl'
import { ItemCreateDesignSection } from '@/components/items/ItemCreateDesignSection'

const KIND_OPTIONS = SYSTEM_ELEMENT_KINDS.map((kind) => ({
  value: kind,
  label: SYSTEM_ELEMENT_KIND_LABELS[kind],
}))

/** The element this one sits under, as `GET /system-elements/:id/parent` lists it. */
interface ParentElement {
  id: string
  itemNumber: string
  name: string | null
}

const createEmptyElement = (): SystemElement => ({
  id: undefined,
  masterId: undefined,
  itemType: 'SystemElement',
  itemNumber: '',
  name: '',
  description: '',
  state: '',
  isCurrent: true,
  elementKind: 'subsystem',
  designId: '',
  createdAt: undefined,
  modifiedAt: undefined,
})

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart.
 */
export const SYSTEM_ELEMENT_DETAIL_TABS = [
  'details',
  'relationships',
  'history',
] as const
export type SystemElementDetailTab = (typeof SYSTEM_ELEMENT_DETAIL_TABS)[number]

interface SystemElementDetailProps {
  /** Called after a lifecycle transition succeeds (refresh the item) */
  onTransitioned?: () => void
  element?: SystemElement
  designs?: Array<Design>
  defaultDesignId?: string
  /** The branch a new element is created on, when the caller was viewing one. */
  defaultBranchId?: string
  onSave: (element: SystemElement, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: SystemElementDetailTab
  onTabChange?: (tab: SystemElementDetailTab) => void
}

export function SystemElementDetail({
  onTransitioned,
  element: initialElement,
  designs = [],
  defaultDesignId,
  defaultBranchId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: SystemElementDetailProps) {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError } = useErrorHandler()
  const isCreateMode = !initialElement?.id

  const [element, setElement] = useState<SystemElement>(
    () =>
      initialElement || {
        ...createEmptyElement(),
        designId: defaultDesignId ?? '',
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)
  const [isImpactDialogOpen, setIsImpactDialogOpen] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>(
    defaultBranchId,
  )

  const { data: createDesignStatus = null } = useQuery(
    designStatusQuery(
      element.designId,
      isCreateMode && Boolean(element.designId),
    ),
  )
  const createBranchRequired =
    createDesignStatus?.protection.phase === 'post-release'

  // Where the server says this item may be edited: the branch holding its
  // edit lock, and whether main is protected for this item's type.
  const editContext = useItemEditContext(isCreateMode ? undefined : element.id)
  const { context, contextLabel, isEditable, setContext } = useVersionContext({
    designId: isCreateMode ? undefined : element.designId,
    isMainProtected: editContext?.isMainProtected ?? false,
  })

  // The element as it stood at the selected version context. Viewing `main`
  // addresses nothing, so the query stays disabled and the caller's copy is
  // shown — the same rule the shared factory encodes for every detail page.
  const { data: versionAtContext, isFetching: isLoadingVersion } = useQuery(
    itemAtContextQuery<SystemElement>(
      element.id ?? '',
      context,
      !isCreateMode && Boolean(element.designId),
    ),
  )
  const displayedElement = isCreateMode
    ? element
    : (versionAtContext ?? element)

  useEffect(() => {
    if (initialElement) {
      setElement(initialElement)
    }
  }, [initialElement])

  // Whether the viewing context is a workspace branch, read through the
  // shared cache rather than a per-mount probe.
  const { data: contextBranch } = useQuery(
    branchDetailQuery(
      context.type === 'branch' ? (context.branchId ?? '') : '',
      !isCreateMode,
    ),
  )
  const isWorkspaceContext = contextBranch?.branchType === 'workspace'

  const currentElement = isCreateMode ? element : displayedElement

  // The element above this one in the tree, if any.
  const { data: parent = null } = useQuery({
    queryKey: qk.sub('system-elements', currentElement.id ?? '', 'parent'),
    queryFn: async (): Promise<ParentElement | null> => {
      const result = await apiFetch<{ data: { item: ParentElement | null } }>(
        `/api/v1/system-elements/${currentElement.id}/parent`,
      )
      return result.data.item
    },
    enabled: !isCreateMode && Boolean(currentElement.id),
  })

  const updateField = (field: keyof SystemElement, value: any) => {
    setElement((prev) => ({ ...prev, [field]: value }))
  }

  // Released lineage on main is revised through a change order (the
  // CheckoutDialog); membership comes from the lifecycle's mappings
  const { isReleasedFamily: isReleasedLineage } = useReleasedFamily(
    'SystemElement',
    currentElement.state,
  )
  const needsCheckout =
    !isCreateMode && isReleasedLineage && context.type === 'main'

  // The server-side edit lock behind the Edit button.
  const editLock = useEditLock({
    itemId: isCreateMode ? undefined : currentElement.id,
    context,
    editContext,
  })

  const handleEdit = async () => {
    if (needsCheckout) {
      setIsCheckoutDialogOpen(true)
      return
    }
    if (!isCreateMode && editLock.canLock && !editLock.heldByMe) {
      try {
        await editLock.acquire()
      } catch (error) {
        handleError(error, { title: 'Cannot edit item' })
        return
      }
    }
    setElement(currentElement)
    setIsEditing(true)
  }

  // A revise-checkout mints the branch working copy up front, so editing
  // belongs on that row's page — see the requirement page for the reasoning.
  const handleCheckoutComplete = (branchId: string, currentItemId?: string) => {
    setElement(currentElement)
    setIsEditing(true)
    if (currentItemId && currentItemId !== currentElement.id) {
      navigate({
        to: '/system-elements/$id',
        params: { id: currentItemId },
        search: { branch: branchId, tab: activeTab },
      } as any)
      return
    }
    setContext({ type: 'branch', branchId })
  }

  const handleSave = async () => {
    const branchId = isCreateMode
      ? selectedBranchId
      : context.type === 'branch'
        ? context.branchId
        : undefined
    await onSave(element, branchId)
    if (!isCreateMode) {
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
        void editLock.cancel().catch(() => {})
      }
      setElement(currentElement)
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentElement.id) return
    confirm({
      title: 'Delete System Element',
      description: `Are you sure you want to delete ${currentElement.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: onDelete,
    })
  }

  const getEditDisabledReason = (): string | undefined => {
    if (editLock.lockedByOther) {
      return `Checked out by ${editLock.lockHolderLabel}`
    }
    if (needsCheckout) {
      return undefined
    }
    if (!isEditable) {
      if (context.type === 'tag' || context.type === 'commit') {
        return 'Cannot edit historical versions'
      }
      if (context.type === 'main' && editLock.isMainProtected) {
        return 'This design has released items, so main is protected. Switch to an ECO or workspace branch to edit this item.'
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

  const editButton = (
    <Button
      variant="outline"
      onClick={handleEdit}
      disabled={(!isEditable && !needsCheckout) || editLock.lockedByOther}
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
  )

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/system-elements">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode
                  ? 'Create New System Element'
                  : currentElement.itemNumber}
              </h1>
              {!isCreateMode && isLoadingVersion && (
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              )}
              {!isCreateMode && (
                <>
                  <StateBadge
                    itemType="SystemElement"
                    state={currentElement.state}
                    className="text-base"
                  />
                  {currentElement.id && (
                    <FreeTransitionControl
                      itemId={currentElement.id}
                      state={currentElement.state}
                      onTransitioned={onTransitioned}
                    />
                  )}
                </>
              )}
              {!isCreateMode &&
                currentElement.designId &&
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
                ? 'Enter the details for the new system element'
                : `Revision ${currentElement.revision} • ${currentElement.name || 'Unnamed'}`}
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
                  data-testid="system-element-submit"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {isSubmitting
                    ? 'Saving...'
                    : isCreateMode
                      ? 'Create System Element'
                      : 'Save Changes'}
                </Button>
              </>
            ) : (
              <>
                {!isCreateMode && currentElement.id && (
                  <Button
                    variant="outline"
                    onClick={() => setIsImpactDialogOpen(true)}
                  >
                    <Search className="h-4 w-4 mr-2" />
                    Impact Analysis
                  </Button>
                )}
                {getEditDisabledReason() ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>{editButton}</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{getEditDisabledReason()}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  editButton
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
        onValueChange={(value) =>
          onTabChange?.(value as SystemElementDetailTab)
        }
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
          data-testid="system-element-form"
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                  <CardDescription>
                    A logical element of the system architecture
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="Item Number"
                      value={
                        isEditing
                          ? element.itemNumber
                          : currentElement.itemNumber
                      }
                      onChange={(v) => updateField('itemNumber', v)}
                      isEditing={isEditing && isCreateMode}
                      placeholder="Leave blank to auto-generate (SE-000001)"
                      data-testid="system-element-item-number"
                    />
                    <ViewEditText
                      label="Revision"
                      value={currentElement.revision}
                      onChange={() => {}}
                      isEditing={false}
                    />
                    <ViewEditText
                      label="Name"
                      value={isEditing ? element.name : currentElement.name}
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="Power subsystem"
                      required
                      data-testid="system-element-name"
                    />
                    <ViewEditSelect
                      label="Kind"
                      value={
                        isEditing
                          ? element.elementKind
                          : currentElement.elementKind
                      }
                      onChange={(v) => updateField('elementKind', v)}
                      isEditing={isEditing}
                      options={KIND_OPTIONS}
                      placeholder="Select kind..."
                    />
                    <ViewEditTextarea
                      label="Description"
                      value={
                        isEditing
                          ? element.description
                          : currentElement.description
                      }
                      onChange={(v) => updateField('description', v)}
                      isEditing={isEditing}
                      className="md:col-span-2"
                      rows={4}
                    />
                    {!isCreateMode && (
                      <ViewEditStatic
                        label="Part of"
                        value={
                          parent ? (
                            <span className="flex items-center gap-2">
                              <ItemLink
                                itemType="SystemElement"
                                itemId={parent.id}
                                className="font-mono text-blue-600 hover:underline dark:text-blue-400"
                              >
                                {parent.itemNumber}
                              </ItemLink>
                              <span className="text-slate-600 dark:text-slate-400">
                                {parent.name}
                              </span>
                            </span>
                          ) : (
                            'Top level — no element decomposes into this one'
                          )
                        }
                      />
                    )}
                    {(isCreateMode || !currentElement.designId) &&
                      designs.length > 0 && (
                        <ItemCreateDesignSection
                          designs={designs}
                          designId={element.designId}
                          displayedDesignId={currentElement.designId}
                          onDesignChange={(value) => {
                            updateField('designId', value)
                            setSelectedBranchId(undefined)
                          }}
                          isEditing={isEditing}
                          isCreateMode={isCreateMode}
                          selectedBranchId={selectedBranchId}
                          onBranchChange={setSelectedBranchId}
                          itemLabel="system element"
                        />
                      )}
                  </dl>
                </CardContent>
              </Card>

              {/* The architecture around this element: what it decomposes
                  into, what realizes it, and what is allocated to it */}
              {!isCreateMode && currentElement.id && (
                <>
                  <SystemElementPortsPanel
                    elementId={currentElement.id}
                    elementLabel={[
                      currentElement.itemNumber,
                      currentElement.name,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    ports={currentElement.ports ?? []}
                    isEditable={isEditable}
                  />
                  <SystemElementLinksPanel
                    kind="children"
                    elementId={currentElement.id}
                    designId={currentElement.designId}
                    isEditable={isEditable}
                  />
                  <SystemElementLinksPanel
                    kind="realizedBy"
                    elementId={currentElement.id}
                    designId={currentElement.designId}
                    isEditable={isEditable}
                  />
                  <SystemElementLinksPanel
                    kind="allocatedRequirements"
                    elementId={currentElement.id}
                    designId={currentElement.designId}
                    isEditable={isEditable}
                  />
                </>
              )}
            </div>

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
                          currentElement.createdAt
                            ? new Date(
                                currentElement.createdAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      <ViewEditStatic
                        label="Last Modified"
                        value={
                          currentElement.modifiedAt
                            ? new Date(
                                currentElement.modifiedAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      {!isCreateMode && (
                        <>
                          <ViewEditStatic
                            label="Master ID"
                            value={currentElement.masterId}
                            mono
                          />
                          <ViewEditStatic
                            label="Element ID"
                            value={currentElement.id}
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
          {currentElement.id ? (
            <>
              <DigitalThreadNavigator
                itemId={currentElement.id}
                itemNumber={currentElement.itemNumber}
                itemName={currentElement.name}
                designId={currentElement.designId}
              />
              <RelationshipSection
                itemId={currentElement.id}
                itemType="SystemElement"
                readOnly={!isEditing}
              />
            </>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-slate-500">
                  Save the system element first to manage relationships
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {!isCreateMode && (
          <TabsContent value="history" className="mt-6">
            <ItemHistoryTab
              itemId={currentElement.id!}
              designId={currentElement.designId}
              versionContext={context}
              onViewHistoricalState={setContext}
            />
          </TabsContent>
        )}
      </Tabs>

      {!isCreateMode && currentElement.id && currentElement.designId && (
        <CheckoutDialog
          open={isCheckoutDialogOpen}
          onOpenChange={setIsCheckoutDialogOpen}
          itemId={currentElement.id}
          itemNumber={currentElement.itemNumber ?? ''}
          designId={currentElement.designId}
          onCheckoutComplete={handleCheckoutComplete}
        />
      )}

      {!isCreateMode && currentElement.id && (
        <ImpactAnalysisDialog
          open={isImpactDialogOpen}
          onOpenChange={setIsImpactDialogOpen}
          itemId={currentElement.id}
          itemNumber={currentElement.itemNumber ?? ''}
          itemName={currentElement.name}
        />
      )}
    </PageContainer>
  )
}
