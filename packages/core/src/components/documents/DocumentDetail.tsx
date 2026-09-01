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
  Trash2,
  X,
} from 'lucide-react'
import type { Document } from '@/lib/items/types/document'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { RelationshipSection } from '@/components/items/RelationshipSection'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { PhaseBadge } from '@/components/items/PhaseBadge'
import {
  FileList,
  FileUploadZone,
  ImageGallery,
  ItemFilePreviewPanel,
  useItemImages,
  useItemPreviewableFiles,
} from '@/components/vault'
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  branchDetailQuery,
  designDetailQuery,
  designStatusQuery,
  useInvalidateResources,
} from '@/lib/query'
import { itemAtContextQuery } from '@/lib/query/options/items'
import { StateBadge } from '@/components/items/StateBadge'
import { useReleasedFamily } from '@/lib/hooks/useReleasedFamily'
import { ItemCreateDesignSection } from '@/components/items/ItemCreateDesignSection'

// Constants
// Spelled out so Tailwind's scanner sees the class names — the tab count
// varies with mode and with whether the document has anything to preview or
// any images to show.
const tabGridCols = (
  isCreateMode: boolean,
  hasPreview: boolean,
  hasGallery: boolean,
): string => {
  if (isCreateMode) return 'grid-cols-2'
  const optional = Number(hasPreview) + Number(hasGallery)
  if (optional === 2) return 'grid-cols-5'
  return optional === 1 ? 'grid-cols-4' : 'grid-cols-3'
}

// Default empty document for create mode
const createEmptyDocument = (): Document => ({
  id: undefined,
  masterId: undefined,
  itemType: 'Document',
  itemNumber: '',
  name: '',
  description: '',
  state: '',
  isCurrent: true,
  fileName: undefined,
  fileSize: undefined,
  mimeType: undefined,
  fileId: undefined,
  storagePath: undefined,
  designId: '',
  createdAt: undefined,
  modifiedAt: undefined,
})

const formatFileSize = (bytes?: number) => {
  if (!bytes) return '-'
  const kb = bytes / 1024
  const mb = kb / 1024
  if (mb >= 1) return `${mb.toFixed(2)} MB`
  if (kb >= 1) return `${kb.toFixed(2)} KB`
  return `${bytes} B`
}

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart; the `onValueChange` cast below is the one seam where
 * Radix's `string` meets it, and the triggers are rendered from the same
 * source of truth.
 */
export const DOCUMENT_DETAIL_TABS = [
  'details',
  'preview',
  'gallery',
  'relationships',
  'history',
] as const
export type DocumentDetailTab = (typeof DOCUMENT_DETAIL_TABS)[number]

interface DocumentDetailProps {
  document?: Document
  designs?: Array<Design>
  defaultDesignId?: string
  onSave: (document: Document, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: DocumentDetailTab
  onTabChange?: (tab: DocumentDetailTab) => void
}

export function DocumentDetail({
  document: initialDocument,
  designs = [],
  defaultDesignId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: DocumentDetailProps) {
  const invalidate = useInvalidateResources()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  const isCreateMode = !initialDocument?.id

  const [document, setDocument] = useState<Document>(
    () =>
      initialDocument || {
        ...createEmptyDocument(),
        designId: defaultDesignId ?? '',
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()

  const { data: createDesignStatus = null } = useQuery(
    designStatusQuery(
      document.designId,
      isCreateMode && Boolean(document.designId),
    ),
  )
  const createBranchRequired =
    createDesignStatus?.protection.phase === 'post-release'

  const { context, contextLabel, isEditable, setContext } = useVersionContext(
    isCreateMode ? undefined : document.designId,
  )

  // The document as it stood at the selected version context. Viewing `main`
  // addresses nothing, so the query stays disabled and the caller's copy is
  // shown — the rule every detail page follows.
  const { data: versionAtContext, isFetching: isLoadingVersion } = useQuery(
    itemAtContextQuery<Document>(
      document.id ?? '',
      context,
      !isCreateMode && Boolean(document.designId),
    ),
  )
  const displayedDocument = isCreateMode
    ? document
    : (versionAtContext ?? document)

  // The design's main branch, for the checkout targets below.
  const { data: parentDesign } = useQuery(
    designDetailQuery(
      document.designId,
      !isCreateMode && Boolean(document.designId),
    ),
  )
  // `defaultBranchId` is nullable on the row; the props below take undefined.
  const mainBranchId = parentDesign?.defaultBranchId ?? undefined

  // Whether the viewing context is a workspace branch, read through the
  // shared cache rather than a per-mount probe.
  const { data: contextBranch } = useQuery(
    branchDetailQuery(
      context.type === 'branch' ? (context.branchId ?? '') : '',
      !isCreateMode,
    ),
  )
  const isWorkspaceContext = contextBranch?.branchType === 'workspace'

  useEffect(() => {
    if (initialDocument) {
      setDocument(initialDocument)
    }
  }, [initialDocument])

  const currentDocument = isCreateMode ? document : displayedDocument

  // Attached images drive the Gallery tab. Shares FileList's query — same
  // item, same version context — so this costs no extra request.
  const { images: galleryImages } = useItemImages(
    isCreateMode ? undefined : currentDocument.id,
    {
      branchId: context.type === 'branch' ? context.branchId : undefined,
      mainBranchId,
    },
  )
  const hasGallery = !isCreateMode && galleryImages.length > 0

  // Preview covers what the gallery cannot: PDFs and text. An images-only
  // document gets the Gallery tab alone rather than two tabs showing the same
  // photos — the panel still renders images when something else opens it.
  const { documents: previewableDocuments } = useItemPreviewableFiles(
    isCreateMode ? undefined : currentDocument.id,
    {
      branchId: context.type === 'branch' ? context.branchId : undefined,
      mainBranchId,
    },
  )
  const hasPreview = !isCreateMode && previewableDocuments.length > 0

  const updateField = (field: keyof Document, value: any) => {
    setDocument((prev) => ({ ...prev, [field]: value }))
  }

  // Released lineage on main is revised through a change order (the
  // CheckoutDialog); membership comes from the lifecycle's mappings
  const { isReleasedFamily: isReleasedLineage } = useReleasedFamily(
    'Document',
    currentDocument.state,
  )
  const needsCheckout =
    !isCreateMode && isReleasedLineage && context.type === 'main'

  // The server-side edit lock behind the Edit button. Released-on-main goes
  // through the CheckoutDialog (revise onto a branch) instead of a direct
  // main-branch lock, so treat that case as "protected main" for the hook.
  const editLock = useEditLock({
    itemId: isCreateMode ? undefined : currentDocument.id,
    designId: isCreateMode ? undefined : document.designId,
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
    setDocument(currentDocument)
    setIsEditing(true)
  }

  // A revise-checkout mints the branch working copy up front, so editing
  // belongs on that row's page: the route-level save PUTs the id in the URL,
  // and from the released row's page it would target the released version and
  // be refused (BRANCH_PROTECTED). Navigate there in edit mode — the route
  // component survives the param change, so `isEditing` carries over and the
  // working copy drops into the form via the initialDocument effect above.
  const handleCheckoutComplete = (branchId: string, currentItemId?: string) => {
    setDocument(currentDocument)
    setIsEditing(true)
    if (currentItemId && currentItemId !== currentDocument.id) {
      navigate({
        to: '/documents/$id',
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
    await onSave(document, branchId)
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
      setDocument(currentDocument)
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentDocument.id) return

    confirm({
      title: 'Delete Document',
      description: `Are you sure you want to delete ${currentDocument.itemNumber}? This action cannot be undone.`,
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
    <PageContainer>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/documents">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode
                  ? 'Create New Document'
                  : currentDocument.itemNumber || 'New Document'}
              </h1>
              {!isCreateMode && isLoadingVersion && (
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              )}
              {!isCreateMode && (
                <StateBadge
                  itemType="Document"
                  state={currentDocument.state}
                  className="text-base"
                />
              )}
              {!isCreateMode && currentDocument.state && (
                <PhaseBadge itemType="Document" state={currentDocument.state} />
              )}
              {!isCreateMode &&
                currentDocument.designId &&
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
                ? 'Enter the details for the new document'
                : `Revision ${currentDocument.revision} • ${currentDocument.name || 'Unnamed'}`}
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
                  data-testid="document-submit"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {isSubmitting
                    ? 'Saving...'
                    : isCreateMode
                      ? 'Create Document'
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
        onValueChange={(value) => onTabChange?.(value as DocumentDetailTab)}
        className="w-full"
      >
        <TabsList
          className={`grid w-full ${tabGridCols(isCreateMode, hasPreview, hasGallery)}`}
        >
          <TabsTrigger value="details">Details</TabsTrigger>
          {hasPreview && <TabsTrigger value="preview">Preview</TabsTrigger>}
          {hasGallery && <TabsTrigger value="gallery">Gallery</TabsTrigger>}
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          {!isCreateMode && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>

        {/* Details Tab */}
        <TabsContent
          value="details"
          className="mt-6"
          data-testid="document-form"
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Content - Left 2 columns */}
            <div className="lg:col-span-2 space-y-6">
              {/* Overview Card */}
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                  <CardDescription>
                    General information about this document
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="Item Number"
                      value={
                        isEditing
                          ? document.itemNumber
                          : currentDocument.itemNumber
                      }
                      onChange={(v) => updateField('itemNumber', v)}
                      isEditing={isEditing && isCreateMode}
                      placeholder="DOC-001"
                      required
                      data-testid="document-item-number"
                    />
                    <ViewEditText
                      label="Revision"
                      value={
                        isEditing ? document.revision : currentDocument.revision
                      }
                      onChange={(v) => updateField('revision', v)}
                      isEditing={false}
                    />
                    <ViewEditText
                      label="Name"
                      value={isEditing ? document.name : currentDocument.name}
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="Document name"
                      required
                      data-testid="document-name"
                    />
                    <ViewEditTextarea
                      label="Description"
                      value={
                        isEditing
                          ? document.description
                          : currentDocument.description
                      }
                      onChange={(v) => updateField('description', v)}
                      isEditing={isEditing}
                      placeholder="Enter a description..."
                      className="md:col-span-2"
                    />
                    {(isCreateMode || !currentDocument.designId) &&
                      designs.length > 0 && (
                        <ItemCreateDesignSection
                          designs={designs}
                          designId={document.designId}
                          displayedDesignId={currentDocument.designId}
                          onDesignChange={(value) => {
                            updateField('designId', value)
                            setSelectedBranchId(undefined)
                          }}
                          isEditing={isEditing}
                          isCreateMode={isCreateMode}
                          selectedBranchId={selectedBranchId}
                          onBranchChange={setSelectedBranchId}
                          itemLabel="document"
                        />
                      )}
                  </dl>
                </CardContent>
              </Card>

              {/* File Information Card */}
              <Card>
                <CardHeader>
                  <CardTitle>File Information</CardTitle>
                  <CardDescription>
                    Details about the attached file
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="File Name"
                      value={
                        isEditing ? document.fileName : currentDocument.fileName
                      }
                      onChange={(v) => updateField('fileName', v)}
                      isEditing={isEditing}
                      placeholder="document.pdf"
                    />
                    <ViewEditStatic
                      label="File Size"
                      value={formatFileSize(currentDocument.fileSize)}
                    />
                    <ViewEditText
                      label="MIME Type"
                      value={
                        isEditing ? document.mimeType : currentDocument.mimeType
                      }
                      onChange={(v) => updateField('mimeType', v)}
                      isEditing={isEditing}
                      placeholder="application/pdf"
                    />
                    <ViewEditStatic
                      label="File ID"
                      value={currentDocument.fileId}
                      mono
                    />
                    <ViewEditStatic
                      label="Storage Path"
                      value={currentDocument.storagePath}
                      mono
                      className="md:col-span-2"
                    />
                  </dl>
                </CardContent>
              </Card>
            </div>

            {/* Sidebar - Right column */}
            <div className="space-y-6">
              {/* Vault Files (only for existing documents) */}
              {!isCreateMode && currentDocument.id && (
                <Card>
                  <CardHeader>
                    <CardTitle>Files</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FileUploadZone
                      itemId={currentDocument.id}
                      branchId={
                        context.type === 'branch'
                          ? context.branchId
                          : mainBranchId
                      }
                      onUploadComplete={() => {
                        showSuccess(
                          'File uploaded',
                          'File has been uploaded successfully',
                        )
                        void invalidate('files')
                      }}
                      onUploadError={(error) =>
                        handleError(error, { title: 'Upload failed' })
                      }
                    />
                    <FileList
                      itemId={currentDocument.id}
                      branchId={
                        context.type === 'branch' ? context.branchId : undefined
                      }
                      mainBranchId={mainBranchId}
                    />
                  </CardContent>
                </Card>
              )}

              {/* Metadata */}
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
                          currentDocument.createdAt
                            ? new Date(
                                currentDocument.createdAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      <ViewEditStatic
                        label="Last Modified"
                        value={
                          currentDocument.modifiedAt
                            ? new Date(
                                currentDocument.modifiedAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      {!isCreateMode && (
                        <>
                          <ViewEditStatic
                            label="Master ID"
                            value={currentDocument.masterId}
                            mono
                          />
                          <ViewEditStatic
                            label="Document ID"
                            value={currentDocument.id}
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

        {/* Preview Tab (only when something attached can be rendered) */}
        {!isCreateMode && currentDocument.id && (
          <TabsContent value="preview" className="mt-6">
            <ItemFilePreviewPanel
              itemId={currentDocument.id}
              branchId={
                context.type === 'branch' ? context.branchId : undefined
              }
              mainBranchId={mainBranchId}
              canAnnotate={editLock.heldByMe}
            />
          </TabsContent>
        )}

        {/* Gallery Tab (only for existing documents with images attached) */}
        {!isCreateMode && currentDocument.id && (
          <TabsContent value="gallery" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Gallery</CardTitle>
                <CardDescription>
                  Images attached to this document — click one to view it full
                  size
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ImageGallery
                  itemId={currentDocument.id}
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
          {currentDocument.id ? (
            <>
              <DigitalThreadNavigator
                itemId={currentDocument.id}
                itemNumber={currentDocument.itemNumber}
                itemName={currentDocument.name}
                designId={currentDocument.designId}
              />
              <RelationshipSection
                itemId={currentDocument.id}
                itemType="Document"
                readOnly={!isEditing}
              />
            </>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-slate-500 dark:text-slate-400">
                  Save the document first to manage relationships
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* History Tab */}
        {!isCreateMode && (
          <TabsContent value="history" className="mt-6">
            <ItemHistoryTab
              itemId={currentDocument.id!}
              designId={currentDocument.designId}
              versionContext={context}
              onViewHistoricalState={setContext}
              itemType="Document"
            />
          </TabsContent>
        )}
      </Tabs>

      {/* Checkout Dialog */}
      {!isCreateMode && currentDocument.id && currentDocument.designId && (
        <CheckoutDialog
          open={isCheckoutDialogOpen}
          onOpenChange={setIsCheckoutDialogOpen}
          itemId={currentDocument.id}
          itemNumber={currentDocument.itemNumber ?? ''}
          designId={currentDocument.designId}
          onCheckoutComplete={handleCheckoutComplete}
        />
      )}
    </PageContainer>
  )
}
