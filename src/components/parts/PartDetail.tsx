import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Box,
  Edit,
  Eye,
  EyeOff,
  GitBranch,
  Info,
  Loader2,
  MoreVertical,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { Part } from '@/lib/items/types/part'
import type { Design } from '@/lib/types/design'
import type { CADViewerHandle } from '@/components/parts/CADViewer'
import type { DesignStatus } from '@/components/versioning/DesignPhaseIndicator'
import type {
  BackgroundPreset,
  MaterialPreset,
  StandardView,
} from '@/components/parts/CADViewerTypes'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { PartRelationshipsPanel } from '@/components/items/PartRelationshipsPanel'
import { RequirementLinkingPanel } from '@/components/requirements/RequirementLinkingPanel'
import { PartValidationPanel } from '@/components/parts/PartValidationPanel'
import { ImpactAnalysisDialog } from '@/components/impact'
import { GenerateCadDialog } from '@/components/parts/GenerateCadDialog'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { PhaseBadge } from '@/components/items/PhaseBadge'
import { FileList, FileUploadZone } from '@/components/vault'
import { WorkInstructionsForPartPanel } from '@/components/work-instructions'
import { VersionContextSelector } from '@/components/versioning/VersionContextSelector'
import { DesignPhaseIndicator } from '@/components/versioning/DesignPhaseIndicator'
import { BranchSelector } from '@/components/versioning/BranchSelector'
import { CheckoutDialog } from '@/components/items/CheckoutDialog'
import { CADViewer } from '@/components/parts/CADViewer'
import { CADViewerToolbar } from '@/components/parts/CADViewerToolbar'
import { useCADViewerKeyboard } from '@/components/parts/useCADViewerKeyboard'
import { AttributesEditor } from '@/components/items/AttributesEditor'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  ViewEditBadge,
  ViewEditCurrency,
  ViewEditNumber,
  ViewEditSelect,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { PartThumbnail } from '@/components/parts/PartThumbnail'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

// Constants
const PART_TYPE_OPTIONS = [
  { value: 'Manufacture', label: 'Manufacture' },
  { value: 'Purchase', label: 'Purchase' },
  { value: 'Software', label: 'Software' },
  { value: 'Phantom', label: 'Phantom' },
]

const WEIGHT_UNIT_OPTIONS = [
  { value: 'kg', label: 'kg' },
  { value: 'g', label: 'g' },
  { value: 'lb', label: 'lb' },
  { value: 'oz', label: 'oz' },
]

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD' },
  { value: 'EUR', label: 'EUR' },
  { value: 'GBP', label: 'GBP' },
  { value: 'JPY', label: 'JPY' },
]

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

// Default empty part for create mode
const createEmptyPart = (): Part => ({
  id: undefined,
  masterId: undefined,
  itemNumber: '',
  revision: 'A',
  name: '',
  description: '',
  state: 'Draft',
  isCurrent: true,
  partType: undefined,
  material: undefined,
  weight: undefined,
  weightUnit: 'kg',
  cost: undefined,
  costCurrency: 'USD',
  leadTimeDays: undefined,
  designId: undefined,
  createdAt: undefined,
  modifiedAt: undefined,
})

interface CADFileEntry {
  id: string
  fileName: string
  fileType: string
  isPrimaryModel: boolean
  hasColors: boolean
  source: 'direct' | 'cad_doc'
  sourceItemId: string
  sourceItemNumber: string | null
}

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
  activeTab?: 'details' | 'relationships' | 'work-instructions' | 'history'
  /** Callback when tab changes */
  onTabChange?: (tab: string) => void
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
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  // Determine if this is create mode
  const isCreateMode = !initialPart?.id

  // Part state
  const [part, setPart] = useState<Part>(
    () => initialPart || { ...createEmptyPart(), designId: defaultDesignId },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)
  const [isImpactDialogOpen, setIsImpactDialogOpen] = useState(false)
  const [isGenerateCadOpen, setIsGenerateCadOpen] = useState(false)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    initialPart?.attributes ?? {},
  )

  // Version context state (only for existing parts)
  const [displayedPart, setDisplayedPart] = useState<Part>(part)
  const [isLoadingVersion, setIsLoadingVersion] = useState(false)

  // CAD viewer state
  const [cadFiles, setCADFiles] = useState<Array<CADFileEntry>>([])
  const [selectedCADFile, setSelectedCADFile] = useState<CADFileEntry | null>(
    null,
  )
  const [cadModelStats, setCADModelStats] = useState<{
    polygonCount?: number
    boundingBox?: { x: number; y: number; z: number }
  }>({})
  const [showCADViewer, setShowCADViewer] = useState(true)
  const [cadWireframe, setCADWireframe] = useState(false)
  const [cadShowGrid, setCADShowGrid] = useState(false)
  const [cadFullscreen, setCADFullscreen] = useState(false)
  const [cadBackground, setCADBackground] = useState<BackgroundPreset>('dark')
  const [cadMaterial, setCADMaterial] = useState<MaterialPreset>('default')
  const cadViewerRef = useRef<CADViewerHandle>(null)
  const viewerContainerRef = useRef<HTMLDivElement>(null)

  // Main branch ID for version-aware file handling
  const [mainBranchId, setMainBranchId] = useState<string | undefined>(
    undefined,
  )
  const [isWorkspaceContext, setIsWorkspaceContext] = useState(false)

  // Design and branch selection state (for create mode)
  const [designStatus, setDesignStatus] = useState<DesignStatus | null>(null)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()
  const [loadingStatus, setLoadingStatus] = useState(false)

  // Version context (only applicable for existing parts with a design)
  const { context, contextLabel, isEditable, setContext } = useVersionContext(
    isCreateMode ? undefined : part.designId,
  )

  // Update part state when initialPart changes
  useEffect(() => {
    if (initialPart) {
      setPart(initialPart)
      setDisplayedPart(initialPart)
      setAttributes(initialPart.attributes ?? {})
    }
  }, [initialPart])

  // Fetch main branch ID when design changes
  useEffect(() => {
    async function fetchMainBranchId() {
      if (!part.designId) {
        setMainBranchId(undefined)
        return
      }
      try {
        const response = await fetch(`/api/v1/designs/${part.designId}`)
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
  }, [part.designId, isCreateMode])

  // Fetch design status for branch selection (create mode)
  useEffect(() => {
    if (!part.designId || !isCreateMode) {
      setDesignStatus(null)
      setSelectedBranchId(undefined)
      return
    }

    async function fetchDesignStatus() {
      setLoadingStatus(true)
      try {
        const result = await apiFetch<{ data: DesignStatus }>(
          `/api/v1/designs/${part.designId}/status`,
        )
        setDesignStatus(result.data)
        // Clear branch selection when design changes
        setSelectedBranchId(undefined)
      } catch {
        setDesignStatus(null)
      } finally {
        setLoadingStatus(false)
      }
    }

    fetchDesignStatus()
  }, [part.designId, isCreateMode])

  // Fetch the correct item version when context changes (only for existing parts)
  // If the resolved version has a different ID, navigate to it so the route loader
  // fetches the correct version directly (BOM, relationships load against right item)
  useEffect(() => {
    async function fetchVersionAtContext() {
      if (isCreateMode || !part.designId) {
        setDisplayedPart(part)
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
        } else if (context.type === 'main') {
          // For main context, use released=true to find the main/released version
          params.set('released', 'true')
        }

        const queryString = params.toString()
        if (!queryString) {
          setDisplayedPart(part)
          return
        }

        const response = await apiFetch<{
          data: {
            item: Part | null
            existsAtContext: boolean
            resolvedItemId?: string
          }
        }>(`/api/v1/items/${part.id}/at-context?${queryString}`)

        // For branch/main contexts: if the resolved item has a different ID,
        // navigate to it so the route loader fetches the correct version.
        // For tag/commit contexts (historical views): just update displayedPart
        // in-place since these are read-only snapshots.
        const shouldNavigate =
          (context.type === 'branch' || context.type === 'main') &&
          response.data.resolvedItemId &&
          response.data.resolvedItemId !== part.id

        if (shouldNavigate) {
          const search: Record<string, string | undefined> = {}
          if (context.type === 'branch' && context.branchId) {
            search.branch = context.branchId
          }
          navigate({
            to: '/parts/$id',
            params: { id: response.data.resolvedItemId! },
            search,
          } as any)
          return
        }

        // Same item or historical view — update displayed part
        if (response.data.item) {
          setDisplayedPart(response.data.item)
        } else {
          setDisplayedPart(part)
        }
      } catch (err) {
        console.error('Failed to fetch item at context:', err)
        setDisplayedPart(part)
      } finally {
        setIsLoadingVersion(false)
      }
    }

    fetchVersionAtContext()
  }, [part, context, isCreateMode, navigate])

  // Check if current context is a workspace branch
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

  // Load CAD files
  useEffect(() => {
    if (!isCreateMode && displayedPart.id) {
      loadCADFiles()
    }
  }, [displayedPart.id, context, mainBranchId, isCreateMode])

  const loadCADFiles = async () => {
    if (!displayedPart.id) return
    try {
      const url = new URL(
        `/api/v1/items/${displayedPart.id}/cad-files`,
        window.location.origin,
      )
      const effectBranchId =
        context.type === 'branch' ? context.branchId : undefined
      if (effectBranchId) url.searchParams.set('branchId', effectBranchId)
      if (mainBranchId) url.searchParams.set('mainBranchId', mainBranchId)

      const response = await fetch(url.toString())
      if (response.ok) {
        const data = await response.json()
        const cad: Array<CADFileEntry> = (
          data.data?.files ??
          data.files ??
          []
        ).map((f: any) => ({
          id: f.id,
          fileName: f.fileName,
          fileType: f.fileType,
          isPrimaryModel: f.isPrimaryModel ?? false,
          hasColors: f.hasColors ?? false,
          source: f.source ?? 'direct',
          sourceItemId: f.sourceItemId ?? displayedPart.id,
          sourceItemNumber: f.sourceItemNumber ?? null,
        }))
        setCADFiles(cad)
        if (cad.length > 0) {
          // Priority: GLB with colors > primary direct file > any primary file > first file
          const glbWithColors = cad.find(
            (f) => f.fileType === 'glb' && f.hasColors,
          )
          const primaryDirect = cad.find(
            (f) => f.isPrimaryModel && f.source === 'direct',
          )
          const anyPrimary = cad.find((f) => f.isPrimaryModel)
          setSelectedCADFile(
            glbWithColors ?? primaryDirect ?? anyPrimary ?? cad[0],
          )
        } else {
          setSelectedCADFile(null)
        }
      }
    } catch (error) {
      console.error('Failed to load CAD files:', error)
    }
  }

  // The part to display (version-aware for existing parts)
  const currentPart = isCreateMode ? part : displayedPart

  // Branch selection logic for create mode
  const isPostRelease = designStatus?.protection.phase === 'post-release'
  const showBranchSelector = isCreateMode && part.designId
  const branchRequired = isPostRelease

  // Field update helper
  const updateField = (field: keyof Part, value: any) => {
    setPart((prev) => ({ ...prev, [field]: value }))
  }

  // Action handlers
  const needsCheckout =
    !isCreateMode && currentPart.state === 'Released' && context.type === 'main'

  const handleEdit = () => {
    if (needsCheckout) {
      setIsCheckoutDialogOpen(true)
      return
    }
    setPart(currentPart)
    setIsEditing(true)
  }

  const handleCheckoutComplete = (branchId: string) => {
    setContext({ type: 'branch', branchId })
    setPart(currentPart)
    setIsEditing(true)
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
      setIsEditing(false)
    }
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
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
    return undefined
  }

  const handleViewCAD = (fileId: string, fileName: string) => {
    // Look up in cadFiles first for full metadata, fall back to minimal entry
    const existing = cadFiles.find((f) => f.id === fileId)
    if (existing) {
      setSelectedCADFile(existing)
    } else {
      const fileType = fileName.toLowerCase().split('.').pop() || ''
      setSelectedCADFile({
        id: fileId,
        fileName,
        fileType,
        isPrimaryModel: false,
        hasColors: false,
        source: 'direct',
        sourceItemId: displayedPart.id ?? '',
        sourceItemNumber: null,
      })
    }
    setShowCADViewer(true)
  }

  const handleCADModelLoad = (stats: {
    polygonCount: number
    boundingBox: { x: number; y: number; z: number }
  }) => {
    setCADModelStats(stats)
  }

  const handleDownloadCAD = () => {
    if (selectedCADFile) {
      window.open(`/api/v1/files/${selectedCADFile.id}/download`, '_blank')
    }
  }

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    const container = viewerContainerRef.current
    if (!container) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      container.requestFullscreen()
    }
  }, [])

  // Sync fullscreen state with browser
  useEffect(() => {
    const handleFsChange = () => {
      setCADFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    return () =>
      document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  // Keyboard shortcuts for the viewer
  const keyboardActions = useMemo(
    () => ({
      resetView: () => cadViewerRef.current?.resetView(),
      toggleWireframe: () => setCADWireframe((prev) => !prev),
      toggleFullscreen,
      toggleGrid: () => setCADShowGrid((prev) => !prev),
      setView: (view: StandardView) => cadViewerRef.current?.setView(view),
    }),
    [toggleFullscreen],
  )

  useCADViewerKeyboard(
    viewerContainerRef,
    keyboardActions,
    showCADViewer && !!selectedCADFile,
  )

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

  // Available tabs (History and Work Instructions not available in create mode)
  const availableTabs = isCreateMode
    ? ['details', 'relationships']
    : ['details', 'relationships', 'work-instructions', 'history']

  return (
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
            <PartThumbnail itemId={part.id} size="lg" />
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
              {!isCreateMode && currentPart.state && (
                <Badge
                  className="text-base"
                  variant={stateVariant(currentPart.state)}
                >
                  {currentPart.state}
                </Badge>
              )}
              {!isCreateMode && currentPart.state && (
                <PhaseBadge itemType="Part" state={currentPart.state} />
              )}
              {!isCreateMode &&
                currentPart.designId &&
                context.type !== 'main' && (
                  <Badge variant={getContextBadgeVariant()} className="text-sm">
                    <GitBranch className="h-3 w-3 mr-1" />
                    {contextLabel}
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
                  </TooltipProvider>
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
                {!isCreateMode && currentPart.partType === 'Manufacture' && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => setIsGenerateCadOpen(true)}
                      >
                        <Box className="h-4 w-4 mr-2" />
                        Generate CAD
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
          className={`grid w-full ${isCreateMode ? 'grid-cols-2' : 'grid-cols-4'}`}
        >
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
          {!isCreateMode && (
            <TabsTrigger value="work-instructions">
              Work Instructions
            </TabsTrigger>
          )}
          {!isCreateMode && <TabsTrigger value="history">History</TabsTrigger>}
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
                    <ViewEditBadge
                      label="State"
                      value={isEditing ? part.state : currentPart.state}
                      onChange={(v) => updateField('state', v)}
                      isEditing={isEditing}
                      options={STATE_OPTIONS}
                      variant={stateVariant}
                      readOnly={!isCreateMode} // State is managed by lifecycle
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
                    {/* Design selector (only in create mode or if no design assigned) */}
                    {(isCreateMode || !currentPart.designId) &&
                      designs.length > 0 && (
                        <div className="md:col-span-2 space-y-4">
                          <div className="flex items-center gap-4">
                            <ViewEditSelect
                              label="Design"
                              value={
                                isEditing ? part.designId : currentPart.designId
                              }
                              onChange={(v) => updateField('designId', v)}
                              isEditing={isEditing && isCreateMode}
                              options={designs.map((d) => ({
                                value: d.id,
                                label: `${d.code} - ${d.name}`,
                              }))}
                              placeholder="Select a design..."
                              required
                              data-testid="design-selector"
                            />
                            {part.designId &&
                              !loadingStatus &&
                              designStatus && (
                                <DesignPhaseIndicator
                                  designId={part.designId}
                                  status={designStatus}
                                />
                              )}
                          </div>

                          {/* Branch Selection - Available for new items when design is selected */}
                          {showBranchSelector && (
                            <div className="space-y-2">
                              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                                Target Branch{' '}
                                {branchRequired && (
                                  <span className="text-red-500">*</span>
                                )}
                              </label>
                              <BranchSelector
                                designId={part.designId}
                                value={selectedBranchId}
                                onChange={setSelectedBranchId}
                                showMainOption={!branchRequired}
                                placeholder={
                                  branchRequired
                                    ? 'Select branch...'
                                    : 'Main branch (default)'
                                }
                              />
                              {branchRequired && (
                                <div className="flex items-start gap-2 mt-2 p-3 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-sm rounded-md">
                                  <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                                  <span>
                                    This design is under change control. New
                                    parts must be created on an ECO or workspace
                                    branch.
                                  </span>
                                </div>
                              )}
                              {!branchRequired && !selectedBranchId && (
                                <div className="flex items-start gap-2 mt-2 p-3 bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-400 text-sm rounded-md">
                                  <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                                  <span>
                                    No branch selected - part will be created on
                                    the main branch. Select a workspace branch
                                    for private development work.
                                  </span>
                                </div>
                              )}
                              {branchRequired && !selectedBranchId && (
                                <p className="text-sm text-red-500">
                                  Please select a branch to create this part on
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                  </dl>
                </CardContent>
              </Card>

              {/* Manufacturing Details Card */}
              <Card>
                <CardHeader>
                  <CardTitle>Manufacturing Details</CardTitle>
                  <CardDescription>
                    Production and sourcing information
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditBadge
                      label="Type"
                      value={isEditing ? part.partType : currentPart.partType}
                      onChange={(v) => updateField('partType', v)}
                      isEditing={isEditing}
                      options={PART_TYPE_OPTIONS}
                      variant={(v) => {
                        const m: Record<
                          string,
                          'default' | 'secondary' | 'success' | 'outline'
                        > = {
                          Manufacture: 'default',
                          Purchase: 'secondary',
                          Software: 'success',
                          Phantom: 'outline',
                        }
                        return m[v] || 'default'
                      }}
                    />
                    <ViewEditText
                      label="Material"
                      value={isEditing ? part.material : currentPart.material}
                      onChange={(v) => updateField('material', v)}
                      isEditing={isEditing}
                      placeholder="e.g., Aluminum 6061"
                    />
                    <ViewEditNumber
                      label="Weight"
                      value={isEditing ? part.weight : currentPart.weight}
                      onChange={(v) => updateField('weight', v)}
                      isEditing={isEditing}
                      unitOptions={WEIGHT_UNIT_OPTIONS}
                      unitValue={
                        isEditing ? part.weightUnit : currentPart.weightUnit
                      }
                      onUnitChange={(v) => updateField('weightUnit', v)}
                      step="0.001"
                    />
                    <ViewEditCurrency
                      label="Cost"
                      value={isEditing ? part.cost : currentPart.cost}
                      onChange={(v) => updateField('cost', v)}
                      isEditing={isEditing}
                      currency={
                        isEditing ? part.costCurrency : currentPart.costCurrency
                      }
                      currencyOptions={CURRENCY_OPTIONS}
                      onCurrencyChange={(v) => updateField('costCurrency', v)}
                    />
                    <ViewEditNumber
                      label="Lead Time"
                      value={
                        isEditing ? part.leadTimeDays : currentPart.leadTimeDays
                      }
                      onChange={(v) =>
                        updateField('leadTimeDays', v ? parseInt(v) : undefined)
                      }
                      isEditing={isEditing}
                      unit="days"
                      min={0}
                    />
                  </dl>
                </CardContent>
              </Card>

              {/* CAD 3D Viewer (only for existing parts with CAD files) */}
              {!isCreateMode && selectedCADFile && showCADViewer && (
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle>3D CAD Model</CardTitle>
                        <CardDescription>
                          Interactive 3D visualization •{' '}
                          {selectedCADFile.fileName}
                          {selectedCADFile.source === 'cad_doc' &&
                            selectedCADFile.sourceItemNumber &&
                            ` (from ${selectedCADFile.sourceItemNumber})`}
                        </CardDescription>
                      </div>
                      <div className="flex items-center gap-2">
                        {cadFiles.length > 1 && (
                          <Select
                            value={selectedCADFile.id}
                            onValueChange={(fileId) => {
                              const file = cadFiles.find((f) => f.id === fileId)
                              if (file) setSelectedCADFile(file)
                            }}
                          >
                            <SelectTrigger className="w-[220px] h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {cadFiles.some((f) => f.source === 'direct') && (
                                <SelectGroup>
                                  <SelectLabel>Direct Files</SelectLabel>
                                  {cadFiles
                                    .filter((f) => f.source === 'direct')
                                    .map((f) => (
                                      <SelectItem key={f.id} value={f.id}>
                                        {f.fileName}
                                      </SelectItem>
                                    ))}
                                </SelectGroup>
                              )}
                              {(() => {
                                const docGroups = new Map<
                                  string,
                                  Array<CADFileEntry>
                                >()
                                for (const f of cadFiles.filter(
                                  (cf) => cf.source === 'cad_doc',
                                )) {
                                  const key =
                                    f.sourceItemNumber ?? f.sourceItemId
                                  if (!docGroups.has(key))
                                    docGroups.set(key, [])
                                  docGroups.get(key)!.push(f)
                                }
                                return Array.from(docGroups.entries()).map(
                                  ([label, files]) => (
                                    <SelectGroup key={label}>
                                      <SelectLabel>{label}</SelectLabel>
                                      {files.map((f) => (
                                        <SelectItem key={f.id} value={f.id}>
                                          {f.fileName}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  ),
                                )
                              })()}
                            </SelectContent>
                          </Select>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowCADViewer(false)}
                          title="Hide 3D viewer"
                        >
                          <EyeOff className="h-4 w-4 mr-2" />
                          Hide Viewer
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div
                      ref={viewerContainerRef}
                      className={`relative ${cadFullscreen ? 'h-screen' : 'h-[500px]'}`}
                      tabIndex={0}
                    >
                      <CADViewerToolbar
                        wireframe={cadWireframe}
                        showGrid={cadShowGrid}
                        isFullscreen={cadFullscreen}
                        backgroundPreset={cadBackground}
                        materialPreset={cadMaterial}
                        polygonCount={cadModelStats.polygonCount}
                        hasEmbeddedColors={
                          selectedCADFile.hasColors &&
                          selectedCADFile.fileType === 'glb'
                        }
                        onResetView={() => cadViewerRef.current?.resetView()}
                        onToggleWireframe={() =>
                          setCADWireframe((prev) => !prev)
                        }
                        onToggleGrid={() => setCADShowGrid((prev) => !prev)}
                        onToggleFullscreen={toggleFullscreen}
                        onBackgroundChange={setCADBackground}
                        onMaterialChange={setCADMaterial}
                        onDownload={handleDownloadCAD}
                      />
                      <CADViewer
                        ref={cadViewerRef}
                        fileUrl={`/api/v1/files/${selectedCADFile.id}/download`}
                        fileType={selectedCADFile.fileType}
                        fileName={selectedCADFile.fileName}
                        wireframe={cadWireframe}
                        showGrid={cadShowGrid}
                        backgroundPreset={cadBackground}
                        materialPreset={cadMaterial}
                        hasEmbeddedColors={
                          selectedCADFile.hasColors &&
                          selectedCADFile.fileType === 'glb'
                        }
                        onLoad={handleCADModelLoad}
                        onError={(error) =>
                          handleError(error, {
                            title: 'Failed to load CAD model',
                          })
                        }
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Show Viewer Button (when hidden) */}
              {!isCreateMode && cadFiles.length > 0 && !showCADViewer && (
                <Card>
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-slate-900 dark:text-white">
                          3D CAD Model Available
                        </p>
                        <p className="text-sm text-slate-600 dark:text-slate-400">
                          {cadFiles.length} viewable CAD{' '}
                          {cadFiles.length === 1 ? 'file' : 'files'}
                          {cadFiles.some((f) => f.source === 'cad_doc')
                            ? ' (includes related documents)'
                            : ' attached'}
                        </p>
                      </div>
                      <Button
                        variant="default"
                        onClick={() => setShowCADViewer(true)}
                        title="Show 3D viewer"
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        Show 3D Viewer
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Sidebar - Right column */}
            <div className="space-y-6">
              {/* Custom Attributes */}
              {isEditing ? (
                <Card>
                  <AttributesEditor
                    value={attributes}
                    onChange={setAttributes}
                    disabled={isSubmitting}
                    className="border-0 rounded-none"
                  />
                </Card>
              ) : (
                <Card>
                  <Collapsible
                    defaultOpen={
                      Object.keys(currentPart.attributes ?? {}).length > 0
                    }
                  >
                    <CardHeader className="pb-3">
                      <CollapsibleTrigger className="hover:opacity-70">
                        <CardTitle>Custom Attributes</CardTitle>
                      </CollapsibleTrigger>
                    </CardHeader>
                    <CollapsibleContent>
                      <CardContent className="pt-0">
                        {Object.keys(currentPart.attributes ?? {}).length >
                        0 ? (
                          <dl className="space-y-3">
                            {Object.entries(
                              currentPart.attributes ?? {},
                            ).map(([key, value]) => (
                              <div key={key} className="space-y-1">
                                <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                                  {key}
                                </dt>
                                <dd className="text-sm text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
                                  {value || '-'}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <p className="text-sm text-slate-500 dark:text-slate-400">
                            No custom attributes defined.
                          </p>
                        )}
                      </CardContent>
                    </CollapsibleContent>
                  </Collapsible>
                </Card>
              )}

              {/* Files (only for existing parts) */}
              {!isCreateMode && currentPart.id && (
                <Card>
                  <CardHeader>
                    <CardTitle>Files</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FileUploadZone
                      itemId={currentPart.id}
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
                        loadCADFiles()
                        router.invalidate()
                      }}
                      onUploadError={(error) =>
                        handleError(error, { title: 'Upload failed' })
                      }
                    />
                    <FileList
                      itemId={currentPart.id}
                      branchId={
                        context.type === 'branch' ? context.branchId : undefined
                      }
                      mainBranchId={mainBranchId}
                      onViewCAD={handleViewCAD}
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
                          currentPart.createdAt
                            ? new Date(
                                currentPart.createdAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      <ViewEditStatic
                        label="Last Modified"
                        value={
                          currentPart.modifiedAt
                            ? new Date(
                                currentPart.modifiedAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      {!isCreateMode && (
                        <>
                          <ViewEditStatic
                            label="Master ID"
                            value={currentPart.masterId}
                            mono
                          />
                          <ViewEditStatic
                            label="Part ID"
                            value={currentPart.id}
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
          {currentPart.id ? (
            <>
              <DigitalThreadNavigator
                itemId={currentPart.id}
                itemNumber={currentPart.itemNumber}
                itemName={currentPart.name}
                designId={currentPart.designId}
              />
              <PartRelationshipsPanel
                itemId={currentPart.id}
                itemType="Part"
                branchId={
                  context.type === 'branch' ? context.branchId : undefined
                }
              />
              <RequirementLinkingPanel
                itemId={currentPart.id}
                designId={currentPart.designId}
                readOnly={!isEditable}
              />
              <PartValidationPanel
                partId={currentPart.id}
                designId={currentPart.designId}
                isEditable={isEditable}
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

      {/* Generate CAD Dialog */}
      {!isCreateMode && currentPart.partType === 'Manufacture' && (
        <GenerateCadDialog
          open={isGenerateCadOpen}
          onOpenChange={setIsGenerateCadOpen}
          part={currentPart}
        />
      )}
    </PageContainer>
  )
}
