import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Edit,
  GitBranch,
  Loader2,
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
import { FileList, FileUploadZone } from '@/components/vault'
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

// Constants
const STATE_OPTIONS = [
  { value: 'Draft', label: 'Draft' },
  { value: 'InReview', label: 'In Review' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Released', label: 'Released' },
  { value: 'Obsolete', label: 'Obsolete' },
]

const stateVariant = (state: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Draft: 'secondary',
    InReview: 'default',
    Approved: 'success',
    Released: 'success',
    Obsolete: 'destructive',
  }
  return variants[state] || 'default'
}

// Default empty document for create mode
const createEmptyDocument = (): Document => ({
  id: undefined,
  masterId: undefined,
  itemNumber: '',
  revision: 'A',
  name: '',
  description: '',
  state: 'Draft',
  isCurrent: true,
  fileName: undefined,
  fileSize: undefined,
  mimeType: undefined,
  fileId: undefined,
  storagePath: undefined,
  designId: undefined,
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

interface DocumentDetailProps {
  document?: Document
  designs?: Array<Design>
  defaultDesignId?: string
  onSave: (document: Document, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: 'details' | 'relationships' | 'history'
  onTabChange?: (tab: string) => void
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
  const router = useRouter()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  const isCreateMode = !initialDocument?.id

  const [document, setDocument] = useState<Document>(
    () =>
      initialDocument || {
        ...createEmptyDocument(),
        designId: defaultDesignId,
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)

  const [displayedDocument, setDisplayedDocument] = useState<Document>(document)
  const [isLoadingVersion, setIsLoadingVersion] = useState(false)

  const [mainBranchId, setMainBranchId] = useState<string | undefined>(
    undefined,
  )
  const [isWorkspaceContext, setIsWorkspaceContext] = useState(false)

  const { context, contextLabel, isEditable, setContext } = useVersionContext(
    isCreateMode ? undefined : document.designId,
  )

  useEffect(() => {
    if (initialDocument) {
      setDocument(initialDocument)
      setDisplayedDocument(initialDocument)
    }
  }, [initialDocument])

  useEffect(() => {
    async function fetchMainBranchId() {
      if (!document.designId) {
        setMainBranchId(undefined)
        return
      }
      try {
        const response = await fetch(`/api/v1/designs/${document.designId}`)
        if (response.ok) {
          const design = await response.json()
          setMainBranchId(design.defaultBranchId)
        }
      } catch (err) {
        console.error('Error fetching design:', err)
      }
    }
    if (!isCreateMode) {
      fetchMainBranchId()
    }
  }, [document.designId, isCreateMode])

  useEffect(() => {
    async function fetchVersionAtContext() {
      if (isCreateMode || !document.designId || context.type === 'main') {
        setDisplayedDocument(document)
        return
      }

      setIsLoadingVersion(true)
      try {
        const params = new URLSearchParams()
        if (context.type === 'commit' && context.commitId) {
          params.set('commitId', context.commitId)
        } else if (context.type === 'tag' && context.tagId) {
          params.set('tagId', context.tagId)
        } else if (context.type === 'branch' && context.branchId) {
          params.set('branchId', context.branchId)
        }

        const queryString = params.toString()
        if (!queryString) {
          setDisplayedDocument(document)
          return
        }

        const response = await apiFetch<{
          data: { item: Document | null; existsAtContext: boolean }
        }>(`/api/v1/items/${document.id}/at-context?${queryString}`)

        if (response.data.item) {
          setDisplayedDocument(response.data.item)
        } else {
          setDisplayedDocument(document)
        }
      } catch (err) {
        console.error('Failed to fetch item at context:', err)
        setDisplayedDocument(document)
      } finally {
        setIsLoadingVersion(false)
      }
    }

    fetchVersionAtContext()
  }, [document, context, isCreateMode])

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
      } catch (error) {
        console.error('Failed to check branch type:', error)
        setIsWorkspaceContext(false)
      }
    }

    if (!isCreateMode) {
      checkIfWorkspace()
    }
  }, [context, isCreateMode])

  const currentDocument = isCreateMode ? document : displayedDocument

  const updateField = (field: keyof Document, value: any) => {
    setDocument((prev) => ({ ...prev, [field]: value }))
  }

  const needsCheckout =
    !isCreateMode &&
    currentDocument.state === 'Released' &&
    context.type === 'main'

  const handleEdit = () => {
    if (needsCheckout) {
      setIsCheckoutDialogOpen(true)
      return
    }
    setDocument(currentDocument)
    setIsEditing(true)
  }

  const handleCheckoutComplete = (branchId: string) => {
    setContext({ type: 'branch', branchId })
    setDocument(currentDocument)
    setIsEditing(true)
  }

  const handleSave = async () => {
    const branchId = context.type === 'branch' ? context.branchId : undefined
    await onSave(document, branchId)
    if (!isCreateMode) {
      setIsEditing(false)
    }
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
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
              {!isCreateMode && currentDocument.state && (
                <Badge
                  className="text-base"
                  variant={stateVariant(currentDocument.state)}
                >
                  {currentDocument.state}
                </Badge>
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
                  disabled={isSubmitting}
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

      {/* Workspace Context Banner */}
      {!isCreateMode &&
        isWorkspaceContext &&
        context.type === 'branch' &&
        context.branchId && (
          <WorkspaceContextBanner branchId={context.branchId} />
        )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
        <TabsList
          className={`grid w-full ${isCreateMode ? 'grid-cols-2' : 'grid-cols-3'}`}
        >
          <TabsTrigger value="details">Details</TabsTrigger>
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
                    <ViewEditBadge
                      label="State"
                      value={isEditing ? document.state : currentDocument.state}
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
                        <ViewEditSelect
                          label="Design"
                          value={
                            isEditing
                              ? document.designId
                              : currentDocument.designId
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
                        router.invalidate()
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
