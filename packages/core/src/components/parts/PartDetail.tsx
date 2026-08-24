// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Edit,
  Eye,
  EyeOff,
  GitBranch,
  GitCompare,
  Info,
  Loader2,
  Lock,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { Part } from '@/lib/items/types/part'
import type { Design } from '@/lib/types/design'
import type {
  CADCompareLayer,
  CADCompareSlot,
  CADModelStats,
  CADViewerHandle,
} from '@/components/parts/CADViewer'
import type { CompareSlotSelection } from '@/components/parts/CADComparePanel'
import type { DesignStatus } from '@/components/versioning/DesignPhaseIndicator'
import type {
  BackgroundPreset,
  MaterialPreset,
  StandardView,
} from '@/components/parts/CADViewerTypes'
import type { UrlEnrichmentResult } from '@/components/items/useUrlDropEnrichment'
import type { ModelVersionEntry } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { PartRelationshipsPanel } from '@/components/items/PartRelationshipsPanel'
import { RequirementLinkingPanel } from '@/components/requirements/RequirementLinkingPanel'
import { PartValidationPanel } from '@/components/parts/PartValidationPanel'
import { ImpactAnalysisDialog } from '@/components/impact'
import { Slot } from '@/lib/ui/slot-registry'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { PhaseBadge } from '@/components/items/PhaseBadge'
import {
  FileList,
  FileUploadZone,
  ImageGallery,
  useItemImages,
} from '@/components/vault'
import { WorkInstructionsForPartPanel } from '@/components/work-instructions'
import { DesignPhaseIndicator } from '@/components/versioning/DesignPhaseIndicator'
import { BranchSelector } from '@/components/versioning/BranchSelector'
import { CheckoutDialog } from '@/components/items/CheckoutDialog'
import {
  CADViewer,
  COMPARE_SLOT_COLORS,
  DEFAULT_COMPARE_OPACITY,
} from '@/components/parts/CADViewer'
import {
  CADComparePanel,
  modelVersionLabel,
  resolveSlot,
} from '@/components/parts/CADComparePanel'
import { CADViewerToolbar } from '@/components/parts/CADViewerToolbar'
import { useCADViewerKeyboard } from '@/components/parts/useCADViewerKeyboard'
import { AttributesEditor } from '@/components/items/AttributesEditor'
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
import { PartAmlSection } from '@/components/parts/PartAmlSection'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { itemModelVersionsQuery, useInvalidateResources } from '@/lib/query'
import { itemResolvedAtContextQuery } from '@/lib/query/options/items'
import { apiFetch } from '@/lib/api/client'
import { StateBadge } from '@/components/items/StateBadge'
import { useReleasedFamily } from '@/lib/hooks/useReleasedFamily'

// Constants
const PART_TYPE_OPTIONS = [
  { value: 'Manufacture', label: 'Manufacture' },
  { value: 'Purchase', label: 'Purchase' },
  { value: 'Software', label: 'Software' },
  { value: 'Phantom', label: 'Phantom' },
]

const TRACKING_MODE_OPTIONS = [
  { value: 'none', label: 'Not tracked' },
  { value: 'lot', label: 'Lot tracked' },
  { value: 'serial', label: 'Serial tracked' },
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
  activeTab?:
    | 'details'
    | 'gallery'
    | 'relationships'
    | 'sources'
    | 'work-instructions'
    | 'history'
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
  const [attributes, setAttributes] = useState<Record<string, string>>(
    initialPart?.attributes ?? {},
  )

  // Drag-and-drop a web link onto the create form to auto-fill it.
  const applyEnrichment = useCallback(
    (result: UrlEnrichmentResult) => {
      // Always keep the source link as provenance (existing keys win).
      setAttributes((prev) => {
        const merged: Record<string, string> = { ...result.attributes, ...prev }
        if (!merged.link || !merged.link.trim()) merged.link = result.link
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

  // CAD viewer state
  const [cadFiles, setCADFiles] = useState<Array<CADFileEntry>>([])
  const [selectedCADFile, setSelectedCADFile] = useState<CADFileEntry | null>(
    null,
  )
  const [cadModelStats, setCADModelStats] = useState<Partial<CADModelStats>>({})
  const [showCADViewer, setShowCADViewer] = useState(true)
  const [cadWireframe, setCADWireframe] = useState(false)
  const [cadShowGrid, setCADShowGrid] = useState(false)
  const [cadFullscreen, setCADFullscreen] = useState(false)
  const [cadBackground, setCADBackground] = useState<BackgroundPreset>('dark')
  const [cadMaterial, setCADMaterial] = useState<MaterialPreset>('default')
  const cadViewerRef = useRef<CADViewerHandle>(null)
  const viewerContainerRef = useRef<HTMLDivElement>(null)

  // Version comparison state — one selection per side, each naming its own
  // version, file, color and translucency.
  const [cadCompareOpen, setCADCompareOpen] = useState(false)
  const [cadCompareA, setCADCompareA] = useState<CompareSlotSelection>(() =>
    emptyCompareSlot('A'),
  )
  const [cadCompareB, setCADCompareB] = useState<CompareSlotSelection>(() =>
    emptyCompareSlot('B'),
  )

  // Bumped whenever the item's thumbnail may have changed, to bust the img cache
  const [thumbnailVersion, setThumbnailVersion] = useState(0)

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
          const body = await response.json()
          setMainBranchId(body.data?.design?.defaultBranchId)
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
            glbWithColors ?? primaryDirect ?? anyPrimary ?? cad[0] ?? null,
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

  // Comparable versions of this part's master, fetched when the compare
  // panel is open. Master-scoped, so every entry stays valid as the user
  // moves between version contexts of the same part.
  const { data: modelVersions = [], isLoading: modelVersionsLoading } =
    useQuery(
      itemModelVersionsQuery(
        isCreateMode ? undefined : displayedPart.id,
        cadCompareOpen,
      ),
    )

  const contextBranchId =
    context.type === 'branch' ? (context.branchId ?? null) : null
  const selectedCADFileId = selectedCADFile?.id ?? null

  // Landing on a different version row re-seeds the comparison from scratch
  useEffect(() => {
    setCADCompareA(emptyCompareSlot('A'))
    setCADCompareB(emptyCompareSlot('B'))
  }, [displayedPart.id])

  // Seed side A from what the page is already showing and side B from the
  // most useful other version, so opening the panel is a comparison right
  // away rather than two empty pickers. Only ever fills a side the user has
  // not chosen, so re-renders never fight their selection.
  useEffect(() => {
    if (!cadCompareOpen || cadCompareA.versionKey !== null) return

    const entryA = versionEntryForContext(
      modelVersions,
      displayedPart.id,
      contextBranchId,
    )
    const fileA =
      entryA?.files.find((f) => f.id === selectedCADFileId) ??
      entryA?.files.at(0)
    if (!entryA || !fileA) return

    setCADCompareA({
      ...emptyCompareSlot('A'),
      versionKey: entryA.key,
      fileId: fileA.id,
    })

    const entryB = defaultCounterpart(modelVersions, entryA)
    const fileB = entryB?.files.at(0)
    if (entryB && fileB) {
      setCADCompareB({
        ...emptyCompareSlot('B'),
        versionKey: entryB.key,
        fileId: fileB.id,
      })
    }
  }, [
    cadCompareOpen,
    cadCompareA.versionKey,
    modelVersions,
    displayedPart.id,
    contextBranchId,
    selectedCADFileId,
  ])

  const compareLayer = (
    selection: CompareSlotSelection,
  ): CADCompareLayer | null => {
    const { entry, file } = resolveSlot(modelVersions, selection)
    if (!entry || !file) return null
    return {
      fileId: file.id,
      fileUrl: `/api/v1/files/${file.id}/download`,
      fileType: file.fileType,
      fileName: file.fileName,
      versionLabel: modelVersionLabel(entry),
      color: selection.color,
      opacity: selection.opacity,
      visible: selection.visible,
    }
  }

  const compareLayerA = cadCompareOpen ? compareLayer(cadCompareA) : null
  const compareLayerB = cadCompareOpen ? compareLayer(cadCompareB) : null
  // Comparison mode starts only once a side resolves to a real model, so
  // opening the panel never blanks the canvas while the versions load.
  const cadComparison =
    (compareLayerA ?? compareLayerB)
      ? { a: compareLayerA, b: compareLayerB }
      : null

  const handleCompareChange = (
    slot: CADCompareSlot,
    next: CompareSlotSelection,
  ) => {
    if (slot === 'A') setCADCompareA(next)
    else setCADCompareB(next)
  }

  const handleCompareSwap = () => {
    // Colors belong to the side, not to the model: swapping moves the
    // versions and leaves A and B their own tints, so the legend holds still.
    const previousA = cadCompareA
    const previousB = cadCompareB
    setCADCompareA({ ...previousB, color: previousA.color })
    setCADCompareB({ ...previousA, color: previousB.color })
  }

  const closeCompare = () => {
    setCADCompareOpen(false)
    setCADCompareA(emptyCompareSlot('A'))
    setCADCompareB(emptyCompareSlot('B'))
  }

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

  // Branch selection logic for create mode
  const isPostRelease = designStatus?.protection.phase === 'post-release'
  const showBranchSelector = isCreateMode && part.designId
  const branchRequired = isPostRelease

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

  const handleCADModelLoad = (stats: CADModelStats) => {
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
                version={thumbnailVersion}
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
        <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
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
                      {/* Design selector (only in create mode or if no design assigned) */}
                      {(isCreateMode || !currentPart.designId) &&
                        designs.length > 0 && (
                          <div className="md:col-span-2 space-y-4">
                            <div className="flex items-center gap-4">
                              <ViewEditSelect
                                label="Design"
                                value={
                                  isEditing
                                    ? part.designId
                                    : currentPart.designId
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
                                      parts must be created on an ECO or
                                      workspace branch.
                                    </span>
                                  </div>
                                )}
                                {!branchRequired && !selectedBranchId && (
                                  <div className="flex items-start gap-2 mt-2 p-3 bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-400 text-sm rounded-md">
                                    <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                                    <span>
                                      No branch selected - part will be created
                                      on the main branch. Select a workspace
                                      branch for private development work.
                                    </span>
                                  </div>
                                )}
                                {branchRequired && !selectedBranchId && (
                                  <p className="text-sm text-red-500">
                                    Please select a branch to create this part
                                    on
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
                      <ViewEditBadge
                        label="Tracking"
                        value={
                          isEditing
                            ? (part.trackingMode ?? 'none')
                            : (currentPart.trackingMode ?? 'none')
                        }
                        onChange={(v) => updateField('trackingMode', v)}
                        isEditing={isEditing}
                        options={TRACKING_MODE_OPTIONS}
                        variant={(v) => {
                          const m: Record<
                            string,
                            'default' | 'secondary' | 'success' | 'outline'
                          > = {
                            none: 'outline',
                            lot: 'secondary',
                            serial: 'success',
                          }
                          return m[v] || 'outline'
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
                          isEditing
                            ? part.costCurrency
                            : currentPart.costCurrency
                        }
                        currencyOptions={CURRENCY_OPTIONS}
                        onCurrencyChange={(v) => updateField('costCurrency', v)}
                      />
                      <ViewEditNumber
                        label="Lead Time"
                        value={
                          isEditing
                            ? part.leadTimeDays
                            : currentPart.leadTimeDays
                        }
                        onChange={(v) =>
                          updateField(
                            'leadTimeDays',
                            v ? parseInt(v) : undefined,
                          )
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
                            {cadCompareOpen ? (
                              'Comparing two versions — pick each side in the panel'
                            ) : (
                              <>
                                Interactive 3D visualization •{' '}
                                {selectedCADFile.fileName}
                                {selectedCADFile.source === 'cad_doc' &&
                                  selectedCADFile.sourceItemNumber &&
                                  ` (from ${selectedCADFile.sourceItemNumber})`}
                              </>
                            )}
                          </CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                          {cadFiles.length > 1 && !cadCompareOpen && (
                            <Select
                              value={selectedCADFile.id}
                              onValueChange={(fileId) => {
                                const file = cadFiles.find(
                                  (f) => f.id === fileId,
                                )
                                if (file) setSelectedCADFile(file)
                              }}
                            >
                              <SelectTrigger className="w-[220px] h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {cadFiles.some(
                                  (f) => f.source === 'direct',
                                ) && (
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
                            variant={cadCompareOpen ? 'secondary' : 'ghost'}
                            size="sm"
                            onClick={() => {
                              if (cadCompareOpen) closeCompare()
                              else setCADCompareOpen(true)
                            }}
                            title="Compare two versions of this part"
                          >
                            <GitCompare className="h-4 w-4 mr-2" />
                            Compare
                          </Button>
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
                          comparison={cadComparison}
                          onLoad={handleCADModelLoad}
                          onError={(error) =>
                            handleError(error, {
                              title: 'Failed to load CAD model',
                            })
                          }
                          onComparisonError={(error) =>
                            handleError(error, {
                              title: 'Failed to load a model being compared',
                            })
                          }
                        />
                        {cadCompareOpen && (
                          <CADComparePanel
                            versions={modelVersions}
                            isLoading={modelVersionsLoading}
                            a={cadCompareA}
                            b={cadCompareB}
                            onChange={handleCompareChange}
                            onSwap={handleCompareSwap}
                            onClose={closeCompare}
                          />
                        )}
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
                              {Object.entries(currentPart.attributes ?? {}).map(
                                ([key, value]) => (
                                  <div key={key} className="space-y-1">
                                    <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                                      {key}
                                    </dt>
                                    <dd className="text-sm text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
                                      {value || '-'}
                                    </dd>
                                  </div>
                                ),
                              )}
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
                          setThumbnailVersion((v) => v + 1)
                          void invalidate('files')
                        }}
                        onUploadError={(error) =>
                          handleError(error, { title: 'Upload failed' })
                        }
                      />
                      <FileList
                        itemId={currentPart.id}
                        branchId={
                          context.type === 'branch'
                            ? context.branchId
                            : undefined
                        }
                        mainBranchId={mainBranchId}
                        onViewCAD={handleViewCAD}
                        onThumbnailChanged={() =>
                          setThumbnailVersion((v) => v + 1)
                        }
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

/** A side of the comparison with nothing picked yet, in its own tint. */
function emptyCompareSlot(slot: CADCompareSlot): CompareSlotSelection {
  return {
    versionKey: null,
    fileId: null,
    color: COMPARE_SLOT_COLORS[slot],
    opacity: DEFAULT_COMPARE_OPACITY,
    visible: true,
  }
}

/**
 * The version entry matching the context the page is displaying.
 *
 * Matching on the item row is what makes this exact: a branch working copy
 * and its released counterpart are different rows, so the row the page
 * resolved to names the entry unambiguously. The branch fallback covers the
 * case where a branch has not minted a working copy yet, and both entries
 * therefore point at the released row.
 */
function versionEntryForContext(
  versions: Array<ModelVersionEntry>,
  itemId: string | undefined,
  branchId: string | null,
): ModelVersionEntry | null {
  const withModels = versions.filter((v) => v.files.length > 0)
  const onBranch = branchId
    ? withModels.find((v) => v.branch?.id === branchId)
    : undefined
  return (
    onBranch ??
    withModels.find((v) => v.itemId === itemId) ??
    withModels.find((v) => v.kind === 'current') ??
    withModels.at(0) ??
    null
  )
}

/**
 * The version worth showing opposite `against` by default: what a change is
 * normally measured against. From an in-work branch that is the released
 * revision it will supersede; from a released one it is whatever work is in
 * flight, then the revision before it.
 */
function defaultCounterpart(
  versions: Array<ModelVersionEntry>,
  against: ModelVersionEntry,
): ModelVersionEntry | null {
  const candidates = versions.filter(
    (v) =>
      v.key !== against.key &&
      v.files.length > 0 &&
      v.files.at(0)?.id !== against.files.at(0)?.id,
  )
  const order: Array<ModelVersionEntry['kind']> =
    against.kind === 'branch'
      ? ['current', 'historical', 'branch']
      : ['branch', 'historical', 'current']

  for (const kind of order) {
    const match = candidates.find((v) => v.kind === kind)
    if (match) return match
  }
  return null
}
