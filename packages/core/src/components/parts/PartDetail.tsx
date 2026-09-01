// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
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
import type { Part } from '@/lib/items/types/part'
import type { Design } from '@/lib/types/design'
import type { UrlEnrichmentResult } from '@/components/items/useUrlDropEnrichment'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { PartRelationshipsPanel } from '@/components/items/PartRelationshipsPanel'
import { RequirementLinkingPanel } from '@/components/requirements/RequirementLinkingPanel'
import { PartValidationPanel } from '@/components/parts/PartValidationPanel'
import { ImpactAnalysisDialog } from '@/components/impact'
import { Slot } from '@/lib/ui/slot-registry'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { PhaseBadge } from '@/components/items/PhaseBadge'
import { ImageGallery, useItemImages } from '@/components/vault'
import { WorkInstructionsForPartPanel } from '@/components/work-instructions'
import { CheckoutDialog } from '@/components/items/CheckoutDialog'
import {
  PartCADHiddenPrompt,
  PartCADSection,
} from '@/components/parts/PartCADSection'
import { PartCreateSection } from '@/components/parts/PartCreateSection'
import { PartDetailSidebar } from '@/components/parts/PartDetailSidebar'
import { PartManufacturingCard } from '@/components/parts/PartManufacturingCard'
import { useCADViewerState } from '@/components/parts/useCADViewerState'
import { useCADCompareState } from '@/components/parts/useCADCompareState'
import { UrlDropOverlay } from '@/components/items/UrlDropOverlay'
import { useUrlDropEnrichment } from '@/components/items/useUrlDropEnrichment'
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { PartThumbnail } from '@/components/parts/PartThumbnail'
import { PartAmlSection } from '@/components/parts/PartAmlSection'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  branchDetailQuery,
  designDetailQuery,
  designStatusQuery,
  useInvalidateResources,
} from '@/lib/query'
import { itemResolvedAtContextQuery } from '@/lib/query/options/items'
import { StateBadge } from '@/components/items/StateBadge'
import { useReleasedFamily } from '@/lib/hooks/useReleasedFamily'

// Spelled out so Tailwind's scanner sees the class names — the tab count
// varies with mode and with whether the part has images to show.
const tabGridCols = (isCreateMode: boolean, hasGallery: boolean): string => {
  if (isCreateMode) return 'grid-cols-2'
  return hasGallery ? 'grid-cols-6' : 'grid-cols-5'
}

// Default empty part for create mode
const createEmptyPart = (): Part => ({
  id: undefined,
  masterId: undefined,
  itemType: 'Part',
  itemNumber: '',
  name: '',
  description: '',
  state: '',
  isCurrent: true,
  partType: undefined,
  material: undefined,
  weight: undefined,
  weightUnit: 'kg',
  cost: undefined,
  costCurrency: 'USD',
  leadTimeDays: undefined,
  designId: '',
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
export const PART_DETAIL_TABS = [
  'details',
  'gallery',
  'relationships',
  'sources',
  'work-instructions',
  'history',
] as const
export type PartDetailTab = (typeof PART_DETAIL_TABS)[number]

interface PartDetailProps {
  /** Existing part data, or undefined for create mode */
  part?: Part
  /** Available designs for the design selector */
  designs?: Array<Design>
  /** Default design ID (for create mode from a design context) */
  defaultDesignId?: string
  /** Callback when part is saved (create or update) */
  onSave: (part: Part, branchId?: string) => Promise<void>
  /** Callback when part is deleted */
  onDelete?: () => Promise<void>
  /** Callback when user cancels (navigates back) */
  onCancel: () => void
  /** Whether a save operation is in progress */
  isSubmitting?: boolean
  /** Active tab (for URL-based tab state) */
  activeTab?: PartDetailTab
  /** Callback when tab changes */
  onTabChange?: (tab: PartDetailTab) => void
}

export function PartDetail({
  part: initialPart,
  designs = [],
  defaultDesignId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: PartDetailProps) {
  const invalidate = useInvalidateResources()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess, showInfo } = useErrorHandler()

  // Determine if this is create mode
  const isCreateMode = !initialPart?.id

  // Part state
  const [part, setPart] = useState<Part>(
    () =>
      initialPart || { ...createEmptyPart(), designId: defaultDesignId ?? '' },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)
  const [isImpactDialogOpen, setIsImpactDialogOpen] = useState(false)
  const [attributes, setAttributes] = useState<Record<string, unknown>>(
    initialPart?.attributes ?? {},
  )

  // Drag-and-drop a web link onto the create form to auto-fill it.
  const applyEnrichment = useCallback(
    (result: UrlEnrichmentResult) => {
      // Always keep the source link as provenance (existing keys win).
      setAttributes((prev) => {
        const merged: Record<string, unknown> = {
          ...result.attributes,
          ...prev,
        }
        // A `link` already on the item wins, but only if it is usable text -
        // attributes can hold any JSON, and a structured value is not a link.
        if (typeof merged.link !== 'string' || !merged.link.trim()) {
          merged.link = result.link
        }
        return merged
      })

      // Fill only empty or still-default fields; never clobber user input.
      setPart((prev) => {
        const defaults = createEmptyPart() as unknown as Record<string, unknown>
        const prevRecord = prev as unknown as Record<string, unknown>
        const next: Record<string, unknown> = { ...prevRecord }
        for (const [key, value] of Object.entries(result.fields)) {
          const current = prevRecord[key]
          if (
            current === undefined ||
            current === null ||
            current === '' ||
            current === defaults[key]
          ) {
            next[key] = value
          }
        }
        return next as unknown as Part
      })

      const fieldCount = Object.keys(result.fields).length
      const attrCount = Object.keys(result.attributes).length
      if (!result.aiEnabled) {
        showInfo(
          'Link saved',
          'AI isn’t connected — the link was saved as a custom attribute. Connect AI in settings to auto-fill more.',
        )
      } else if (fieldCount === 0 && attrCount === 0) {
        showInfo(
          'Link saved',
          'Couldn’t pull details from that page, but the link was saved.',
        )
      } else {
        showSuccess(
          'Details added',
          `Filled ${fieldCount} field${fieldCount === 1 ? '' : 's'} and ${attrCount} attribute${attrCount === 1 ? '' : 's'} from the link.`,
        )
      }
    },
    [showSuccess, showInfo],
  )

  const { isDragging, isEnriching, dropHandlers } = useUrlDropEnrichment({
    itemType: 'Part',
    enabled: isCreateMode,
    onEnriched: applyEnrichment,
  })

  // Design and branch selection state (for create mode)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()

  // Version context (only applicable for existing parts with a design)
  const { context, contextLabel, isEditable, setContext } = useVersionContext(
    isCreateMode ? undefined : part.designId,
  )

  // The part as it stood at the selected version context. Unlike the other
  // detail pages, `main` is a real request here (released=true): the route
  // may have loaded a branch working copy whose main counterpart is a
  // different row. `resolvedItemId` drives the navigation effect below.
  const versionAtContext = useQuery(
    itemResolvedAtContextQuery<Part>(
      part.id ?? '',
      context,
      !isCreateMode && Boolean(part.designId),
    ),
  )
  const displayedPart = isCreateMode
    ? part
    : (versionAtContext.data?.item ?? part)
  const isLoadingVersion = versionAtContext.isFetching

  // Update part state when initialPart changes. displayedPart is derived
  // from the version query (falling back to `part`), so it follows.
  useEffect(() => {
    if (initialPart) {
      setPart(initialPart)
      setAttributes(initialPart.attributes ?? {})
    }
  }, [initialPart])

  // The design's main branch, for the checkout targets below.
  const { data: parentDesign } = useQuery(
    designDetailQuery(part.designId, !isCreateMode && Boolean(part.designId)),
  )
  // `defaultBranchId` is nullable on the row; the props below take undefined.
  const mainBranchId = parentDesign?.defaultBranchId ?? undefined

  // Whether a new part must name a branch — the same question
  // PartCreateSection asks to render its selector. Shared query key, so this
  // costs no extra request; it is read here because the submit button is
  // gated on it.
  const { data: designStatus = null } = useQuery(
    designStatusQuery(part.designId, isCreateMode && Boolean(part.designId)),
  )
  const branchRequired = designStatus?.protection.phase === 'post-release'

  // A different design means a different set of branches.
  useEffect(() => {
    setSelectedBranchId(undefined)
  }, [part.designId])

  // For branch/main contexts a different resolved id means the route is
  // showing the wrong row — navigate so the route loader fetches the correct
  // version directly (BOM, relationships load against the right item). Tag
  // and commit contexts are read-only snapshots, displayed in place.
  useEffect(() => {
    const resolvedItemId = versionAtContext.data?.resolvedItemId
    if (
      (context.type === 'branch' || context.type === 'main') &&
      resolvedItemId &&
      resolvedItemId !== part.id
    ) {
      const search: Record<string, string | undefined> = {}
      if (context.type === 'branch' && context.branchId) {
        search.branch = context.branchId
      }
      navigate({
        to: '/parts/$id',
        params: { id: resolvedItemId },
        search,
      } as any)
    }
  }, [versionAtContext.data, context, part.id, navigate])

  // Check if current context is a workspace branch
  // Whether the viewing context is a workspace branch, read through the
  // shared cache rather than a per-mount probe.
  const { data: contextBranch } = useQuery(
    branchDetailQuery(
      context.type === 'branch' ? (context.branchId ?? '') : '',
      !isCreateMode,
    ),
  )
  const isWorkspaceContext = contextBranch?.branchType === 'workspace'

  // The part to display (version-aware for existing parts)
  const currentPart = isCreateMode ? part : displayedPart

  const contextBranchId =
    context.type === 'branch' ? (context.branchId ?? null) : null

  // The 3D viewer's own state — files, selection, presentation, refs — and
  // the two-version comparison behind it. Both live in hooks because the
  // page reads a little of each (the thumbnail's cache-buster, the uploader's
  // refresh) while the section component does the rendering.
  const cadViewer = useCADViewerState({
    itemId: displayedPart.id,
    branchId: contextBranchId ?? undefined,
    mainBranchId,
    enabled: !isCreateMode,
  })
  const cadCompare = useCADCompareState({
    itemId: displayedPart.id,
    branchId: contextBranchId,
    enabled: !isCreateMode,
    selectedFileId: cadViewer.selectedFile?.id ?? null,
  })

  // Attached images drive the Gallery tab. Shares FileList's query — same
  // item, same version context — so this costs no extra request.
  const { images: galleryImages } = useItemImages(
    isCreateMode ? undefined : currentPart.id,
    {
      branchId: context.type === 'branch' ? context.branchId : undefined,
      mainBranchId,
    },
  )
  const hasGallery = !isCreateMode && galleryImages.length > 0

  // Field update helper
  const updateField = (field: keyof Part, value: any) => {
    setPart((prev) => ({ ...prev, [field]: value }))
  }

  // Action handlers
  // Released lineage on main is revised through a change order (the
  // CheckoutDialog); membership comes from the lifecycle's mappings
  const { isReleasedFamily: isReleasedLineage } = useReleasedFamily(
    'Part',
    currentPart.state,
  )
  const needsCheckout =
    !isCreateMode && isReleasedLineage && context.type === 'main'

  // The server-side edit lock behind the Edit button. Released-on-main goes
  // through the CheckoutDialog (revise onto a branch) instead of a direct
  // main-branch lock, so treat that case as "protected main" for the hook.
  const editLock = useEditLock({
    itemId: isCreateMode ? undefined : currentPart.id,
    designId: isCreateMode ? undefined : part.designId,
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
    setPart(currentPart)
    setIsEditing(true)
  }

  // A revise-checkout mints the branch working copy up front, so editing
  // belongs on that row's page: the route-level save PUTs the id in the URL,
  // and from the released row's page it would target the released version and
  // be refused (BRANCH_PROTECTED). Navigate there in edit mode — the route
  // component survives the param change, so `isEditing` carries over and the
  // working copy drops into the form via the initialPart effect above.
  const handleCheckoutComplete = (branchId: string, currentItemId?: string) => {
    setPart(currentPart)
    setIsEditing(true)
    if (currentItemId && currentItemId !== currentPart.id) {
      navigate({
        to: '/parts/$id',
        params: { id: currentItemId },
        search: { branch: branchId, tab: activeTab },
      } as any)
      return
    }
    // The branch still tracks the row this page is showing — edit in place.
    setContext({ type: 'branch', branchId })
  }

  const handleSave = async () => {
    // In create mode, use selectedBranchId; otherwise use context branch
    const branchId = isCreateMode
      ? selectedBranchId
      : context.type === 'branch'
        ? context.branchId
        : undefined
    await onSave({ ...part, attributes }, branchId)
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
      setPart(currentPart)
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentPart.id) return

    confirm({
      title: 'Delete Part',
      description: `Are you sure you want to delete ${currentPart.itemNumber}? This action cannot be undone.`,
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
      case 'main':
        return 'default'
      case 'branch':
        return 'secondary'
      case 'tag':
        return 'outline'
      case 'commit':
        return 'outline'
      default:
        return 'default'
    }
  }

  return (
    <div className="relative" {...dropHandlers}>
      <PageContainer data-testid="part-form">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link to="/parts">
              <Button variant="outline" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            {!isCreateMode && part.id && (
              <PartThumbnail
                itemId={part.id}
                size="lg"
                version={cadViewer.thumbnailVersion}
              />
            )}
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                  {isCreateMode
                    ? 'Create New Part'
                    : currentPart.itemNumber || 'New Part'}
                </h1>
                {!isCreateMode && isLoadingVersion && (
                  <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                )}
                {!isCreateMode && (
                  <StateBadge
                    itemType="Part"
                    state={currentPart.state}
                    className="text-base"
                  />
                )}
                {!isCreateMode && currentPart.state && (
                  <PhaseBadge itemType="Part" state={currentPart.state} />
                )}
                {!isCreateMode &&
                  currentPart.designId &&
                  context.type !== 'main' && (
                    <Badge
                      variant={getContextBadgeVariant()}
                      className="text-sm"
                    >
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
                  ? 'Enter the details for the new part'
                  : `Revision ${currentPart.revision} • ${currentPart.name || 'Unnamed'}`}
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
                      (isCreateMode && branchRequired && !selectedBranchId)
                    }
                    data-testid="part-submit"
                  >
                    <Save className="h-4 w-4 mr-2" />
                    {isSubmitting
                      ? 'Saving...'
                      : isCreateMode
                        ? 'Create Part'
                        : 'Save Changes'}
                  </Button>
                </>
              ) : (
                <>
                  {!isCreateMode && currentPart.id && (
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
                    <TooltipProvider>
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
                    </TooltipProvider>
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
                  {!isCreateMode && (
                    <Slot
                      name="part-detail-actions"
                      props={{ part: currentPart }}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Workspace Context Banner */}
        {!isCreateMode &&
          isWorkspaceContext &&
          context.type === 'branch' &&
          context.branchId && (
            <WorkspaceContextBanner branchId={context.branchId} />
          )}

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={(value) => onTabChange?.(value as PartDetailTab)}
          className="w-full"
        >
          <TabsList
            className={`grid w-full ${tabGridCols(isCreateMode, hasGallery)}`}
          >
            <TabsTrigger value="details">Details</TabsTrigger>
            {hasGallery && <TabsTrigger value="gallery">Gallery</TabsTrigger>}
            <TabsTrigger value="relationships">Relationships</TabsTrigger>
            {!isCreateMode && (
              <TabsTrigger value="sources">Sources</TabsTrigger>
            )}
            {!isCreateMode && (
              <TabsTrigger value="work-instructions">
                Work Instructions
              </TabsTrigger>
            )}
            {!isCreateMode && (
              <TabsTrigger value="history">History</TabsTrigger>
            )}
          </TabsList>

          {/* Details Tab */}
          <TabsContent value="details" className="mt-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Main Content - Left 2 columns */}
              <div className="lg:col-span-2 space-y-6">
                {/* Overview Card */}
                <Card>
                  <CardHeader>
                    <CardTitle>Overview</CardTitle>
                    <CardDescription>
                      General information about this part
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <ViewEditText
                        label="Item Number"
                        value={
                          isEditing ? part.itemNumber : currentPart.itemNumber
                        }
                        onChange={(v) => updateField('itemNumber', v)}
                        isEditing={isEditing && isCreateMode} // Only editable when creating
                        placeholder="PART-001"
                        required
                        data-testid="part-item-number"
                      />
                      <ViewEditText
                        label="Revision"
                        value={isEditing ? part.revision : currentPart.revision}
                        onChange={(v) => updateField('revision', v)}
                        isEditing={false} // Revision is system-managed
                      />
                      <ViewEditText
                        label="Name"
                        value={isEditing ? part.name : currentPart.name}
                        onChange={(v) => updateField('name', v)}
                        isEditing={isEditing}
                        placeholder="Part name"
                        required
                        data-testid="part-name"
                      />
                      <ViewEditTextarea
                        label="Description"
                        value={
                          isEditing ? part.description : currentPart.description
                        }
                        onChange={(v) => updateField('description', v)}
                        isEditing={isEditing}
                        placeholder="Enter a description..."
                        className="md:col-span-2"
                      />
                      {/* Where a new part is going: design, then branch */}
                      {(isCreateMode || !currentPart.designId) &&
                        designs.length > 0 && (
                          <PartCreateSection
                            designs={designs}
                            designId={part.designId}
                            displayedDesignId={currentPart.designId}
                            onDesignChange={(v) => updateField('designId', v)}
                            isEditing={isEditing}
                            isCreateMode={isCreateMode}
                            selectedBranchId={selectedBranchId}
                            onBranchChange={setSelectedBranchId}
                          />
                        )}
                    </dl>
                  </CardContent>
                </Card>

                <PartManufacturingCard
                  edited={part}
                  displayed={currentPart}
                  isEditing={isEditing}
                  onFieldChange={updateField}
                />

                {/* 3D model, or the prompt that replaces it when hidden */}
                {!isCreateMode && (
                  <>
                    <PartCADSection
                      viewer={cadViewer}
                      compare={cadCompare}
                      onError={handleError}
                    />
                    <PartCADHiddenPrompt viewer={cadViewer} />
                  </>
                )}
              </div>

              {/* Sidebar - Right column */}
              <PartDetailSidebar
                part={currentPart}
                isCreateMode={isCreateMode}
                isEditing={isEditing}
                isSubmitting={isSubmitting}
                attributes={attributes}
                onAttributesChange={setAttributes}
                context={context}
                mainBranchId={mainBranchId}
                cadViewer={cadViewer}
                onUploaded={() => {
                  showSuccess(
                    'File uploaded',
                    'File has been uploaded successfully',
                  )
                  cadViewer.refreshFiles()
                  cadViewer.bumpThumbnail()
                  void invalidate('files')
                }}
                onUploadError={(error) =>
                  handleError(error, { title: 'Upload failed' })
                }
              />
            </div>
          </TabsContent>

          {/* Gallery Tab (only for existing parts with images attached) */}
          {!isCreateMode && currentPart.id && (
            <TabsContent value="gallery" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle>Gallery</CardTitle>
                  <CardDescription>
                    Images attached to this part — click one to view it full
                    size
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ImageGallery
                    itemId={currentPart.id}
                    branchId={
                      context.type === 'branch' ? context.branchId : undefined
                    }
                    mainBranchId={mainBranchId}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* Relationships Tab */}
          <TabsContent value="relationships" className="mt-6 space-y-6">
            {currentPart.id ? (
              <>
                <DigitalThreadNavigator
                  itemId={currentPart.id}
                  itemNumber={currentPart.itemNumber}
                  itemName={currentPart.name}
                  designId={currentPart.designId}
                />
                {/* Structure edits follow the click-Edit policy: read-only
                    until the user enters edit mode (which holds the server-
                    side checkout lock) */}
                <PartRelationshipsPanel
                  itemId={currentPart.id}
                  itemType="Part"
                  branchId={
                    context.type === 'branch' ? context.branchId : undefined
                  }
                  readOnly={!isEditing}
                />
                <RequirementLinkingPanel
                  itemId={currentPart.id}
                  designId={currentPart.designId}
                  readOnly={!isEditing}
                />
                <PartValidationPanel
                  partId={currentPart.id}
                  designId={currentPart.designId}
                  isEditable={isEditing}
                />
              </>
            ) : (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-slate-500 dark:text-slate-400">
                    Save the part first to manage relationships
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Sources Tab — Approved Manufacturer List (only for existing parts) */}
          {!isCreateMode && (currentPart.masterId ?? currentPart.id) && (
            <TabsContent value="sources" className="mt-6">
              <PartAmlSection
                partMasterId={(currentPart.masterId ?? currentPart.id)!}
              />
            </TabsContent>
          )}

          {/* Work Instructions Tab (only for existing parts) */}
          {!isCreateMode && currentPart.id && (
            <TabsContent value="work-instructions" className="mt-6">
              <WorkInstructionsForPartPanel
                partId={currentPart.id}
                onError={(error) =>
                  handleError(error, {
                    title: 'Failed to load work instructions',
                  })
                }
              />
            </TabsContent>
          )}

          {/* History Tab (only for existing parts) */}
          {!isCreateMode && (
            <TabsContent value="history" className="mt-6">
              <ItemHistoryTab
                itemId={currentPart.id!}
                designId={currentPart.designId}
                versionContext={context}
                onViewHistoricalState={setContext}
                itemType="Part"
              />
            </TabsContent>
          )}
        </Tabs>

        {/* Checkout Dialog for released items */}
        {!isCreateMode && currentPart.id && currentPart.designId && (
          <CheckoutDialog
            open={isCheckoutDialogOpen}
            onOpenChange={setIsCheckoutDialogOpen}
            itemId={currentPart.id}
            itemNumber={currentPart.itemNumber ?? ''}
            designId={currentPart.designId}
            onCheckoutComplete={handleCheckoutComplete}
          />
        )}

        {/* Impact Analysis Dialog */}
        {!isCreateMode && currentPart.id && (
          <ImpactAnalysisDialog
            open={isImpactDialogOpen}
            onOpenChange={setIsImpactDialogOpen}
            itemId={currentPart.id}
            itemNumber={currentPart.itemNumber ?? ''}
            itemName={currentPart.name}
          />
        )}
      </PageContainer>
      <UrlDropOverlay isDragging={isDragging} isEnriching={isEnriching} />
    </div>
  )
}
