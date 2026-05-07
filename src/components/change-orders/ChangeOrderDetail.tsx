import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ArrowLeft, Box, Check, Edit, Save, Trash2, X } from 'lucide-react'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import type { EffectiveWorkflowStructure } from '@/lib/workflows/types'
import { changeOrderTypeSchema } from '@/lib/items/types/change-order'
import { PageContainer } from '@/components/layout'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { EcoHistoryGraphView } from '@/components/change-orders/EcoHistoryGraphView'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { FileList, FileUploadZone } from '@/components/vault'
import { GraphNavigator } from '@/components/items/GraphNavigator'
import { EcoAffectedItemsPanel } from '@/components/change-orders/EcoAffectedItemsPanel'
import { ImpactAssessmentPanel } from '@/components/change-orders/ImpactAssessmentPanel'
import { EcoSummaryDashboard } from '@/components/change-orders/EcoSummaryDashboard'
import { ConflictsList } from '@/components/change-orders/ConflictsList'
import { ApprovalStatusPanel } from '@/components/change-orders/ApprovalStatusPanel'
import { WorkflowTransitionActions } from '@/components/workflows/WorkflowTransitionActions'
import { WorkflowInstanceEditor } from '@/components/change-orders/WorkflowInstanceEditor'
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
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ViewEditBadge,
  ViewEditSelect,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

interface Design {
  id: string
  code: string
  name: string
  programId: string
  programName?: string
  designType: 'Engineering' | 'Library'
  phase: string
}

// Constants
const STATE_OPTIONS = [
  { value: 'Draft', label: 'Draft' },
  { value: 'Submitted', label: 'Submitted' },
  { value: 'ImpactAssessment', label: 'Impact Assessment' },
  { value: 'Review', label: 'Review' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'Implementation', label: 'Implementation' },
  { value: 'Implemented', label: 'Implemented' },
  { value: 'Closed', label: 'Closed' },
]

// Derive change type options from the schema
const CHANGE_TYPE_OPTIONS = changeOrderTypeSchema.options.map((value) => ({
  value,
  label: value,
}))

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
]

const stateVariant = (state: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Draft: 'secondary',
    Submitted: 'default',
    ImpactAssessment: 'default',
    Review: 'warning',
    Approved: 'success',
    Rejected: 'destructive',
    Implementation: 'default',
    Implemented: 'success',
    Closed: 'secondary',
  }
  return variants[state] || 'default'
}

const priorityVariant = (priority: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    low: 'secondary',
    medium: 'default',
    high: 'warning',
    critical: 'destructive',
  }
  return variants[priority] || 'default'
}

const riskVariant = (risk: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    low: 'success',
    medium: 'default',
    high: 'warning',
    critical: 'destructive',
  }
  return variants[risk] || 'default'
}

const createEmptyChangeOrder = (): ChangeOrder => ({
  id: undefined,
  masterId: undefined,
  itemNumber: '',
  revision: 'A',
  name: '',
  description: '',
  state: 'Draft',
  isCurrent: true,
  changeType: 'ECO',
  priority: 'medium',
  reasonForChange: '',
  impactDescription: '',
  riskLevel: undefined,
  designId: undefined,
  createdAt: undefined,
  modifiedAt: undefined,
})

type TabValue =
  | 'overview'
  | 'affected-items'
  | 'conflicts'
  | 'impact'
  | 'files'
  | 'approvals'
  | 'workflow'
  | 'history'

interface ChangeOrderDetailProps {
  changeOrder?: ChangeOrder
  onSave: (changeOrder: ChangeOrder, designIds?: Array<string>) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: TabValue
  onTabChange?: (tab: string) => void
}

export function ChangeOrderDetail({
  changeOrder: initialChangeOrder,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'overview',
  onTabChange,
}: ChangeOrderDetailProps) {
  const router = useRouter()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  const isCreateMode = !initialChangeOrder?.id

  const [changeOrder, setChangeOrder] = useState<ChangeOrder>(
    () => initialChangeOrder || createEmptyChangeOrder(),
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [refreshKey, setRefreshKey] = useState(0)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    // Convert unknown values to strings for the editor
    Object.fromEntries(
      Object.entries(initialChangeOrder?.attributes || {}).map(
        ([key, value]) => [
          key,
          Array.isArray(value) ? value.join(', ') : String(value),
        ],
      ),
    ),
  )

  const [displayedChangeOrder, setDisplayedChangeOrder] =
    useState<ChangeOrder>(changeOrder)
  const [mainBranchId, setMainBranchId] = useState<string | undefined>(
    undefined,
  )
  const [workflowStructure, setWorkflowStructure] = useState<
    | (EffectiveWorkflowStructure & {
        currentState: string
        instanceId: string
      })
    | null
  >(null)

  const { context, setContext } = useVersionContext(
    isCreateMode ? undefined : changeOrder.designId,
  )

  const isHistoricalView = context.type === 'commit' || context.type === 'tag'

  // Design selection state for create mode
  const [availableDesigns, setAvailableDesigns] = useState<Array<Design>>([])
  const [selectedDesigns, setSelectedDesigns] = useState<Array<Design>>([])
  const [designSearchQuery, setDesignSearchQuery] = useState('')
  const [loadingDesigns, setLoadingDesigns] = useState(false)

  useEffect(() => {
    if (initialChangeOrder) {
      setChangeOrder(initialChangeOrder)
      setDisplayedChangeOrder(initialChangeOrder)
      setAttributes(
        Object.fromEntries(
          Object.entries(initialChangeOrder.attributes || {}).map(
            ([key, value]) => [
              key,
              Array.isArray(value) ? value.join(', ') : String(value),
            ],
          ),
        ),
      )
    }
  }, [initialChangeOrder])

  // Fetch available designs when in create mode
  useEffect(() => {
    if (!isCreateMode) return

    async function fetchDesigns() {
      setLoadingDesigns(true)
      try {
        const response = await fetch('/api/v1/designs')
        if (response.ok) {
          const data = await response.json()
          setAvailableDesigns(data.data?.designs ?? [])
        }
      } catch {
        // Fetch failed silently
      } finally {
        setLoadingDesigns(false)
      }
    }
    fetchDesigns()
  }, [isCreateMode])

  useEffect(() => {
    async function fetchMainBranchId() {
      if (!changeOrder.designId) {
        setMainBranchId(undefined)
        return
      }
      try {
        const response = await fetch(`/api/v1/designs/${changeOrder.designId}`)
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
  }, [changeOrder.designId, isCreateMode])

  useEffect(() => {
    async function fetchWorkflowStructure() {
      if (isCreateMode || !changeOrder.id) {
        setWorkflowStructure(null)
        return
      }
      try {
        const response = await fetch(
          `/api/v1/change-orders/${changeOrder.id}/workflow/structure`,
        )
        if (response.ok) {
          const data = await response.json()
          setWorkflowStructure(data.data)
        }
      } catch (err) {
        console.error('Error fetching workflow structure:', err)
        setWorkflowStructure(null)
      }
    }
    fetchWorkflowStructure()
  }, [changeOrder.id, refreshKey, isCreateMode])

  useEffect(() => {
    async function fetchVersionAtContext() {
      if (isCreateMode || !changeOrder.designId || context.type === 'main') {
        setDisplayedChangeOrder(changeOrder)
        return
      }

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
          setDisplayedChangeOrder(changeOrder)
          return
        }

        const response = await apiFetch<{
          data: { item: ChangeOrder | null; existsAtContext: boolean }
        }>(`/api/v1/items/${changeOrder.id}/at-context?${queryString}`)

        if (response.data.item) {
          setDisplayedChangeOrder(response.data.item)
        } else {
          setDisplayedChangeOrder(changeOrder)
        }
      } catch (err) {
        console.error('Failed to fetch item at context:', err)
        setDisplayedChangeOrder(changeOrder)
      }
    }

    fetchVersionAtContext()
  }, [changeOrder, context, isCreateMode])

  const currentChangeOrder = isCreateMode ? changeOrder : displayedChangeOrder

  const updateField = (field: keyof ChangeOrder, value: any) => {
    setChangeOrder((prev) => ({ ...prev, [field]: value }))
  }

  const handleEdit = () => {
    setChangeOrder(currentChangeOrder)
    setIsEditing(true)
  }

  const toggleDesignSelection = (design: Design) => {
    setSelectedDesigns((prev) => {
      const isSelected = prev.some((d) => d.id === design.id)
      if (isSelected) {
        return prev.filter((d) => d.id !== design.id)
      } else {
        return [...prev, design]
      }
    })
  }

  // Filter designs based on search query
  const filteredDesigns = designSearchQuery
    ? availableDesigns.filter(
        (design) =>
          design.code.toLowerCase().includes(designSearchQuery.toLowerCase()) ||
          design.name.toLowerCase().includes(designSearchQuery.toLowerCase()),
      )
    : availableDesigns

  const handleSave = async () => {
    const designIds = isCreateMode
      ? selectedDesigns.map((d) => d.id)
      : undefined
    // Include attributes in the change order being saved
    const changeOrderWithAttributes = {
      ...changeOrder,
      attributes,
    }
    await onSave(changeOrderWithAttributes, designIds)
    if (!isCreateMode) {
      setIsEditing(false)
    }
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      setChangeOrder(currentChangeOrder)
      // Reset attributes to current values
      setAttributes(
        Object.fromEntries(
          Object.entries(currentChangeOrder.attributes || {}).map(
            ([key, value]) => [
              key,
              Array.isArray(value) ? value.join(', ') : String(value),
            ],
          ),
        ),
      )
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentChangeOrder.id) return

    confirm({
      title: 'Delete Change Order',
      description: `Are you sure you want to delete ${currentChangeOrder.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: onDelete,
    })
  }

  // In create mode, only show Overview tab
  const tabs = isCreateMode
    ? [{ value: 'overview', label: 'Overview' }]
    : [
        { value: 'overview', label: 'Overview' },
        { value: 'affected-items', label: 'Affected Items' },
        { value: 'conflicts', label: 'Conflicts' },
        { value: 'impact', label: 'Impact' },
        { value: 'approvals', label: 'Approvals' },
        { value: 'workflow', label: 'Workflow' },
        { value: 'history', label: 'History' },
      ]

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/change-orders">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode
                  ? 'Create New Change Order'
                  : currentChangeOrder.itemNumber || 'New Change Order'}
              </h1>
              {!isCreateMode && currentChangeOrder.state && (
                <Badge
                  className="text-base"
                  variant={stateVariant(currentChangeOrder.state)}
                >
                  {currentChangeOrder.state}
                </Badge>
              )}
              {!isCreateMode && currentChangeOrder.priority && (
                <Badge
                  className="text-base"
                  variant={priorityVariant(currentChangeOrder.priority)}
                >
                  {currentChangeOrder.priority.toUpperCase()}
                </Badge>
              )}
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {isCreateMode
                ? 'Enter the details for the new change order'
                : `Revision ${currentChangeOrder.revision} • ${currentChangeOrder.name || 'Unnamed'}`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!isCreateMode && !isEditing && currentChangeOrder.id && (
            <WorkflowTransitionActions
              itemId={currentChangeOrder.id}
              itemNumber={currentChangeOrder.itemNumber ?? ''}
              onTransitionComplete={() => setRefreshKey((k) => k + 1)}
            />
          )}
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
                  data-testid="change-order-submit"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {isSubmitting
                    ? 'Saving...'
                    : isCreateMode
                      ? 'Create Change Order'
                      : 'Save Changes'}
                </Button>
              </>
            ) : (
              <>
                {currentChangeOrder.state === 'Draft' && (
                  <>
                    <Button variant="outline" onClick={handleEdit}>
                      <Edit className="h-4 w-4 mr-2" />
                      Edit
                    </Button>
                    {onDelete && (
                      <Button variant="destructive" onClick={handleDelete}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
        <TabsList className={`grid w-full grid-cols-${tabs.length}`}>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Overview Tab */}
        <TabsContent
          value="overview"
          className="mt-6"
          data-testid="change-order-form"
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Content - Left 2 columns */}
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                  <CardDescription>
                    General information about this change order
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {isCreateMode ? (
                      <ViewEditStatic
                        label="Change Order Number"
                        value={
                          <span className="text-muted-foreground">
                            Auto-generated on creation
                          </span>
                        }
                      />
                    ) : (
                      <ViewEditText
                        label="Item Number"
                        value={currentChangeOrder.itemNumber}
                        onChange={(v) => updateField('itemNumber', v)}
                        isEditing={false}
                        placeholder="ECO-001"
                      />
                    )}
                    <ViewEditSelect
                      label="Change Type"
                      value={
                        isEditing
                          ? changeOrder.changeType
                          : currentChangeOrder.changeType
                      }
                      onChange={(v) => updateField('changeType', v)}
                      isEditing={isEditing}
                      options={CHANGE_TYPE_OPTIONS}
                      required
                    />
                    <ViewEditBadge
                      label="Priority"
                      value={
                        isEditing
                          ? changeOrder.priority
                          : currentChangeOrder.priority
                      }
                      onChange={(v) => updateField('priority', v)}
                      isEditing={isEditing}
                      options={PRIORITY_OPTIONS}
                      variant={priorityVariant}
                    />
                    <ViewEditStatic
                      label="Risk Level"
                      value={
                        currentChangeOrder.riskLevel ? (
                          <Badge
                            variant={riskVariant(currentChangeOrder.riskLevel)}
                          >
                            {currentChangeOrder.riskLevel.toUpperCase()}
                          </Badge>
                        ) : (
                          'Not Assessed'
                        )
                      }
                    />
                    <ViewEditText
                      label="Name"
                      value={
                        isEditing ? changeOrder.name : currentChangeOrder.name
                      }
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="Change order name"
                      required
                      className="md:col-span-2"
                      data-testid="change-order-name"
                    />
                    <ViewEditTextarea
                      label="Description"
                      value={
                        isEditing
                          ? (changeOrder as any).description
                          : (currentChangeOrder as any).description
                      }
                      onChange={(v) =>
                        updateField('description' as keyof ChangeOrder, v)
                      }
                      isEditing={isEditing}
                      placeholder="Describe the change..."
                      className="md:col-span-2"
                    />
                    <ViewEditTextarea
                      label="Reason for Change"
                      value={
                        isEditing
                          ? changeOrder.reasonForChange
                          : currentChangeOrder.reasonForChange
                      }
                      onChange={(v) => updateField('reasonForChange', v)}
                      isEditing={isEditing}
                      placeholder="Why is this change needed?"
                      className="md:col-span-2"
                    />
                    <ViewEditTextarea
                      label="Impact Description"
                      value={
                        isEditing
                          ? changeOrder.impactDescription
                          : currentChangeOrder.impactDescription
                      }
                      onChange={(v) => updateField('impactDescription', v)}
                      isEditing={isEditing}
                      placeholder="What will be affected?"
                      className="md:col-span-2"
                    />
                  </dl>
                </CardContent>
              </Card>

              {/* Design Selector (only for create mode) */}
              {isCreateMode && (
                <Card>
                  <CardHeader>
                    <CardTitle>Affected Designs</CardTitle>
                    <CardDescription>
                      Select one or more designs that this change order will
                      affect. ECO branches will be created for each selected
                      design.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Search Input */}
                    <div>
                      <Label>Search Designs</Label>
                      <Input
                        type="text"
                        placeholder="Search by code or name..."
                        value={designSearchQuery}
                        onChange={(e) => setDesignSearchQuery(e.target.value)}
                      />
                    </div>

                    {/* Selected Designs */}
                    {selectedDesigns.length > 0 && (
                      <div className="p-3 bg-cyan-50 dark:bg-cyan-900/20 rounded-lg">
                        <Label className="text-xs text-cyan-700 dark:text-cyan-300">
                          Selected ({selectedDesigns.length})
                        </Label>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {selectedDesigns.map((design) => (
                            <Badge
                              key={design.id}
                              variant="default"
                              className="cursor-pointer hover:bg-cyan-600"
                              onClick={() => toggleDesignSelection(design)}
                            >
                              {design.code} &times;
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Design List */}
                    <div className="border border-slate-300 dark:border-slate-700 rounded-lg max-h-60 overflow-y-auto auto-hide-scroll">
                      {loadingDesigns ? (
                        <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                          Loading designs...
                        </div>
                      ) : filteredDesigns.length === 0 ? (
                        <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                          {availableDesigns.length === 0
                            ? 'No designs available.'
                            : 'No designs match your search.'}
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-200 dark:divide-slate-700">
                          {filteredDesigns.map((design) => {
                            const isSelected = selectedDesigns.some(
                              (d) => d.id === design.id,
                            )
                            return (
                              <button
                                key={design.id}
                                type="button"
                                onClick={() => toggleDesignSelection(design)}
                                className={`w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors ${
                                  isSelected
                                    ? 'bg-cyan-50 dark:bg-cyan-950'
                                    : ''
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <div
                                    className={`flex-shrink-0 w-5 h-5 rounded border flex items-center justify-center ${
                                      isSelected
                                        ? 'bg-cyan-500 border-cyan-500'
                                        : 'border-slate-300 dark:border-slate-600'
                                    }`}
                                  >
                                    {isSelected && (
                                      <Check className="h-3 w-3 text-white" />
                                    )}
                                  </div>
                                  <Box className="h-4 w-4 text-slate-400 flex-shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                                        {design.code}
                                      </span>
                                      <Badge
                                        variant="outline"
                                        className="text-xs"
                                      >
                                        {design.designType}
                                      </Badge>
                                      <Badge
                                        variant={
                                          design.phase === 'Production'
                                            ? 'default'
                                            : 'secondary'
                                        }
                                        className="text-xs"
                                      >
                                        {design.phase}
                                      </Badge>
                                    </div>
                                    <p className="text-sm text-slate-600 dark:text-slate-400 truncate">
                                      {design.name}
                                    </p>
                                  </div>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* ECO Summary Dashboard (only for existing ECOs) */}
              {!isCreateMode &&
                currentChangeOrder.id &&
                currentChangeOrder.changeType === 'ECO' && (
                  <EcoSummaryDashboard
                    changeOrderId={currentChangeOrder.id}
                    onRefresh={() => setRefreshKey((k) => k + 1)}
                    key={refreshKey}
                  />
                )}
            </div>

            {/* Sidebar - Right column */}
            <div className="space-y-6">
              {/* Files (only for existing change orders) */}
              {!isCreateMode && currentChangeOrder.id && (
                <Card>
                  <CardHeader>
                    <CardTitle>Files</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FileUploadZone
                      itemId={currentChangeOrder.id}
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
                      itemId={currentChangeOrder.id}
                      branchId={
                        context.type === 'branch' ? context.branchId : undefined
                      }
                      mainBranchId={mainBranchId}
                    />
                  </CardContent>
                </Card>
              )}

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
                      Object.keys(currentChangeOrder.attributes || {}).length >
                      0
                    }
                  >
                    <CardHeader className="pb-3">
                      <CollapsibleTrigger className="hover:opacity-70">
                        <CardTitle>Custom Attributes</CardTitle>
                      </CollapsibleTrigger>
                    </CardHeader>
                    <CollapsibleContent>
                      <CardContent className="pt-0">
                        {Object.keys(currentChangeOrder.attributes || {})
                          .length > 0 ? (
                          <dl className="space-y-3">
                            {Object.entries(
                              currentChangeOrder.attributes || {},
                            ).map(([key, value]) => (
                              <div key={key} className="space-y-1">
                                <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                                  {key}
                                </dt>
                                <dd className="text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
                                  {Array.isArray(value)
                                    ? value.join(', ')
                                    : String(value)}
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
                          currentChangeOrder.createdAt
                            ? new Date(
                                currentChangeOrder.createdAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      <ViewEditStatic
                        label="Last Modified"
                        value={
                          currentChangeOrder.modifiedAt
                            ? new Date(
                                currentChangeOrder.modifiedAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      <ViewEditStatic
                        label="Submitted"
                        value={
                          currentChangeOrder.submittedAt
                            ? new Date(
                                currentChangeOrder.submittedAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      <ViewEditStatic
                        label="Approved"
                        value={
                          currentChangeOrder.approvedAt
                            ? new Date(
                                currentChangeOrder.approvedAt,
                              ).toLocaleDateString()
                            : '-'
                        }
                      />
                      {!isCreateMode && (
                        <>
                          <ViewEditStatic
                            label="Master ID"
                            value={currentChangeOrder.masterId}
                            mono
                          />
                          <ViewEditStatic
                            label="Change Order ID"
                            value={currentChangeOrder.id}
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

        {/* Affected Items Tab */}
        {!isCreateMode && (
          <TabsContent value="affected-items" className="mt-6">
            {currentChangeOrder.id && (
              <EcoAffectedItemsPanel
                changeOrderId={currentChangeOrder.id}
                changeOrderState={currentChangeOrder.state ?? 'Draft'}
                readOnly={isHistoricalView}
                onItemsChange={() => setRefreshKey((k) => k + 1)}
              />
            )}
          </TabsContent>
        )}

        {/* Conflicts Tab */}
        {!isCreateMode && (
          <TabsContent value="conflicts" className="mt-6">
            {currentChangeOrder.id && (
              <ConflictsList
                ecoId={currentChangeOrder.id}
                ecoNumber={currentChangeOrder.itemNumber}
                onResolve={() => setRefreshKey((k) => k + 1)}
              />
            )}
          </TabsContent>
        )}

        {/* Impact Tab */}
        {!isCreateMode && (
          <TabsContent value="impact" className="mt-6 space-y-6">
            {currentChangeOrder.id && (
              <ImpactAssessmentPanel changeOrderId={currentChangeOrder.id} />
            )}
            {currentChangeOrder.id && (
              <GraphNavigator
                itemId={currentChangeOrder.id}
                itemType="ChangeOrder"
                defaultDepth={2}
              />
            )}
          </TabsContent>
        )}

        {/* Approvals Tab */}
        {!isCreateMode && (
          <TabsContent value="approvals" className="mt-6">
            {currentChangeOrder.id && (
              <ApprovalStatusPanel
                changeOrderId={currentChangeOrder.id}
                onApprovalChange={() => setRefreshKey((k) => k + 1)}
              />
            )}
          </TabsContent>
        )}

        {/* Workflow Tab */}
        {!isCreateMode && (
          <TabsContent value="workflow" className="mt-6">
            {currentChangeOrder.id && workflowStructure ? (
              <Card>
                <CardHeader>
                  <CardTitle>Workflow Editor</CardTitle>
                  <CardDescription>
                    {workflowStructure.canEdit
                      ? 'Add, remove, or modify workflow states and transitions'
                      : 'View the workflow structure'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[600px] border rounded-lg overflow-hidden">
                    <WorkflowInstanceEditor
                      changeOrderId={currentChangeOrder.id}
                      instanceId={workflowStructure.instanceId}
                      states={workflowStructure.states}
                      transitions={workflowStructure.transitions}
                      currentState={workflowStructure.currentState}
                      canEdit={workflowStructure.canEdit && !isHistoricalView}
                      onStructureChange={() => setRefreshKey((k) => k + 1)}
                    />
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-8">
                  <p className="text-center text-slate-500 dark:text-slate-400">
                    No workflow associated with this change order
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}

        {/* History Tab */}
        {!isCreateMode && (
          <TabsContent value="history" className="mt-6">
            {currentChangeOrder.changeType === 'ECO' ? (
              <EcoHistoryGraphView
                changeOrderId={currentChangeOrder.id ?? ''}
              />
            ) : (
              <ItemHistoryTab
                itemId={currentChangeOrder.id ?? ''}
                designId={currentChangeOrder.designId ?? null}
                versionContext={context}
                onViewHistoricalState={setContext}
              />
            )}
          </TabsContent>
        )}
      </Tabs>
    </PageContainer>
  )
}
