// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The interface page, in create and detail mode. The scaffolding — the
 * version context, the edit lock, the revise-checkout, the three tabs — is
 * the system element page's; the interface's own content is its kind and
 * description. What it joins is its `CONNECTS` edges, which show under
 * Relationships.
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
  INTERFACE_KINDS,
  INTERFACE_KIND_LABELS,
} from '@cascadia/commons/items/types/interface'
import type {
  InterfaceItem,
  InterfaceKind,
} from '@cascadia/commons/items/types/interface'
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
import {
  branchDetailQuery,
  createRequiresBranch,
  designStatusQuery,
} from '@/query'
import { StateBadge } from '@/components/items/StateBadge'
import { useReleasedFamily } from '@/hooks/useReleasedFamily'
import { FreeTransitionControl } from '@/components/items/FreeTransitionControl'
import { ItemCreateDesignSection } from '@/components/items/ItemCreateDesignSection'

const KIND_OPTIONS = INTERFACE_KINDS.map((kind) => ({
  value: kind,
  label: INTERFACE_KIND_LABELS[kind],
}))

const createEmptyInterface = (): InterfaceItem => ({
  id: undefined,
  masterId: undefined,
  itemType: 'Interface',
  itemNumber: '',
  name: '',
  description: '',
  state: '',
  isCurrent: true,
  interfaceKind: 'data',
  designId: '',
  createdAt: undefined,
  modifiedAt: undefined,
})

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart.
 */
export const INTERFACE_DETAIL_TABS = [
  'details',
  'relationships',
  'history',
] as const
export type InterfaceDetailTab = (typeof INTERFACE_DETAIL_TABS)[number]

interface InterfaceDetailProps {
  /** Called after a lifecycle transition succeeds (refresh the item) */
  onTransitioned?: () => void
  iface?: InterfaceItem
  designs?: Array<Design>
  defaultDesignId?: string
  /** The branch a new interface is created on, when the caller was viewing one. */
  defaultBranchId?: string
  onSave: (iface: InterfaceItem, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: InterfaceDetailTab
  onTabChange?: (tab: InterfaceDetailTab) => void
}

export function InterfaceDetail({
  onTransitioned,
  iface: initialInterface,
  designs = [],
  defaultDesignId,
  defaultBranchId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: InterfaceDetailProps) {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError } = useErrorHandler()
  const isCreateMode = !initialInterface?.id

  const [iface, setIface] = useState<InterfaceItem>(
    () =>
      initialInterface || {
        ...createEmptyInterface(),
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
    designStatusQuery(iface.designId, isCreateMode && Boolean(iface.designId)),
  )
  const createBranchRequired = createRequiresBranch(createDesignStatus)

  // Where the server says this item may be edited: the branch holding its
  // edit lock, and whether main is protected for this item's type.
  const editContext = useItemEditContext(isCreateMode ? undefined : iface.id)
  const { context, contextLabel, isEditable, setContext } = useVersionContext({
    designId: isCreateMode ? undefined : iface.designId,
    isMainProtected: editContext?.isMainProtected ?? false,
  })

  // The interface as it stood at the selected version context. Viewing `main`
  // addresses nothing, so the query stays disabled and the caller's copy is
  // shown — the same rule the shared factory encodes for every detail page.
  const { data: versionAtContext, isFetching: isLoadingVersion } = useQuery(
    itemAtContextQuery<InterfaceItem>(
      iface.id ?? '',
      context,
      !isCreateMode && Boolean(iface.designId),
    ),
  )
  const displayedInterface = isCreateMode ? iface : (versionAtContext ?? iface)

  useEffect(() => {
    if (initialInterface) {
      setIface(initialInterface)
    }
  }, [initialInterface])

  // Whether the viewing context is a workspace branch, read through the
  // shared cache rather than a per-mount probe.
  const { data: contextBranch } = useQuery(
    branchDetailQuery(
      context.type === 'branch' ? (context.branchId ?? '') : '',
      !isCreateMode,
    ),
  )
  const isWorkspaceContext = contextBranch?.branchType === 'workspace'

  const currentInterface = isCreateMode ? iface : displayedInterface

  const updateField = <TField extends keyof InterfaceItem>(
    field: TField,
    value: InterfaceItem[TField],
  ) => {
    setIface((prev) => ({ ...prev, [field]: value }))
  }

  // Released lineage on main is revised through a change order (the
  // CheckoutDialog); membership comes from the lifecycle's mappings
  const { isReleasedFamily: isReleasedLineage } = useReleasedFamily(
    'Interface',
    currentInterface.state,
  )
  const needsCheckout =
    !isCreateMode && isReleasedLineage && context.type === 'main'

  // The server-side edit lock behind the Edit button.
  const editLock = useEditLock({
    itemId: isCreateMode ? undefined : currentInterface.id,
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
    setIface(currentInterface)
    setIsEditing(true)
  }

  // A revise-checkout mints the branch working copy up front, so editing
  // belongs on that row's page — see the requirement page for the reasoning.
  const handleCheckoutComplete = (branchId: string, currentItemId?: string) => {
    setIface(currentInterface)
    setIsEditing(true)
    if (currentItemId && currentItemId !== currentInterface.id) {
      navigate({
        to: '/interfaces/$id',
        params: { id: currentItemId },
        search: { branch: branchId, tab: activeTab },
      })
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
    await onSave(iface, branchId)
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
      setIface(currentInterface)
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentInterface.id) return
    confirm({
      title: 'Delete Interface',
      description: `Are you sure you want to delete ${currentInterface.itemNumber}? This action cannot be undone.`,
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
          <Link to="/interfaces">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode
                  ? 'Create New Interface'
                  : currentInterface.itemNumber}
              </h1>
              {!isCreateMode && isLoadingVersion && (
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              )}
              {!isCreateMode && (
                <>
                  <StateBadge
                    itemType="Interface"
                    state={currentInterface.state}
                    className="text-base"
                  />
                  {currentInterface.id && (
                    <FreeTransitionControl
                      itemId={currentInterface.id}
                      state={currentInterface.state}
                      onTransitioned={onTransitioned}
                    />
                  )}
                </>
              )}
              {!isCreateMode &&
                currentInterface.designId &&
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
                ? 'Enter the details for the new interface'
                : `Revision ${currentInterface.revision} • ${currentInterface.name || 'Unnamed'}`}
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
                  data-testid="interface-submit"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {isSubmitting
                    ? 'Saving...'
                    : isCreateMode
                      ? 'Create Interface'
                      : 'Save Changes'}
                </Button>
              </>
            ) : (
              <>
                {!isCreateMode && currentInterface.id && (
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
        onValueChange={(value) => onTabChange?.(value as InterfaceDetailTab)}
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
          data-testid="interface-form"
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                  <CardDescription>
                    What joins system elements: a bus, a network, a coolant loop
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="Item Number"
                      value={
                        isEditing
                          ? iface.itemNumber
                          : currentInterface.itemNumber
                      }
                      onChange={(v) => updateField('itemNumber', v)}
                      isEditing={isEditing && isCreateMode}
                      placeholder="Leave blank to auto-generate (IF-000001)"
                      data-testid="interface-item-number"
                    />
                    <ViewEditText
                      label="Revision"
                      value={currentInterface.revision}
                      onChange={() => {}}
                      isEditing={false}
                    />
                    <ViewEditText
                      label="Name"
                      value={isEditing ? iface.name : currentInterface.name}
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="28 V power bus"
                      required
                      data-testid="interface-name"
                    />
                    <ViewEditSelect
                      label="Kind"
                      value={
                        isEditing
                          ? iface.interfaceKind
                          : currentInterface.interfaceKind
                      }
                      onChange={(v) =>
                        updateField('interfaceKind', v as InterfaceKind)
                      }
                      isEditing={isEditing}
                      options={KIND_OPTIONS}
                      placeholder="Select kind..."
                    />
                    <ViewEditTextarea
                      label="Description"
                      value={
                        isEditing
                          ? iface.description
                          : currentInterface.description
                      }
                      onChange={(v) => updateField('description', v)}
                      isEditing={isEditing}
                      className="md:col-span-2"
                      rows={4}
                    />
                    {(isCreateMode || !currentInterface.designId) &&
                      designs.length > 0 && (
                        <ItemCreateDesignSection
                          designs={designs}
                          designId={iface.designId}
                          displayedDesignId={currentInterface.designId}
                          onDesignChange={(value) => {
                            updateField('designId', value)
                            setSelectedBranchId(undefined)
                          }}
                          isEditing={isEditing}
                          isCreateMode={isCreateMode}
                          selectedBranchId={selectedBranchId}
                          onBranchChange={setSelectedBranchId}
                          itemLabel="interface"
                        />
                      )}
                  </dl>
                </CardContent>
              </Card>
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
                          currentInterface.createdAt
                            ? new Date(
                                currentInterface.createdAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      <ViewEditStatic
                        label="Last Modified"
                        value={
                          currentInterface.modifiedAt
                            ? new Date(
                                currentInterface.modifiedAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      {!isCreateMode && (
                        <>
                          <ViewEditStatic
                            label="Master ID"
                            value={currentInterface.masterId}
                            mono
                          />
                          <ViewEditStatic
                            label="Interface ID"
                            value={currentInterface.id}
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
          {currentInterface.id ? (
            <>
              <DigitalThreadNavigator
                itemId={currentInterface.id}
                itemNumber={currentInterface.itemNumber}
                itemName={currentInterface.name}
                designId={currentInterface.designId}
              />
              <RelationshipSection
                itemId={currentInterface.id}
                itemType="Interface"
                readOnly={!isEditing}
              />
            </>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-slate-500">
                  Save the interface first to manage relationships
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {!isCreateMode && (
          <TabsContent value="history" className="mt-6">
            <ItemHistoryTab
              itemId={currentInterface.id!}
              designId={currentInterface.designId}
              versionContext={context}
              onViewHistoricalState={setContext}
            />
          </TabsContent>
        )}
      </Tabs>

      {!isCreateMode && currentInterface.id && currentInterface.designId && (
        <CheckoutDialog
          open={isCheckoutDialogOpen}
          onOpenChange={setIsCheckoutDialogOpen}
          itemId={currentInterface.id}
          itemNumber={currentInterface.itemNumber ?? ''}
          designId={currentInterface.designId}
          onCheckoutComplete={handleCheckoutComplete}
        />
      )}

      {!isCreateMode && currentInterface.id && (
        <ImpactAnalysisDialog
          open={isImpactDialogOpen}
          onOpenChange={setIsImpactDialogOpen}
          itemId={currentInterface.id}
          itemNumber={currentInterface.itemNumber ?? ''}
          itemName={currentInterface.name}
        />
      )}
    </PageContainer>
  )
}
