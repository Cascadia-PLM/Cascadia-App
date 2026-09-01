// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Box, Check, Edit, Save, Trash2, X } from 'lucide-react'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import { changeOrderTypeSchema } from '@/lib/items/types/change-order'
import { PageContainer } from '@/components/layout'
import {
  AttributesEditor,
  formatAttributeValue,
} from '@/components/items/AttributesEditor'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { StateBadge } from '@/components/items/StateBadge'
import { EcoHistoryGraphView } from '@/components/change-orders/EcoHistoryGraphView'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { useLifecyclePhases } from '@/lib/hooks/useLifecyclePhases'
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
import {
  changeOrderWorkflowStructureQuery,
  useInvalidateResources,
} from '@/lib/query'
import { designDetailQuery, designListQuery } from '@/lib/query/options/designs'
import { itemAtContextQuery } from '@/lib/query/options/items'

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
  itemType: 'ChangeOrder',
  itemNumber: '',
  name: '',
  description: '',
  state: '',
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

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart; the `onValueChange` cast below is the one seam where
 * Radix's `string` meets it, and the triggers are rendered from the same
 * source of truth.
 */
export const CHANGE_ORDER_DETAIL_TABS = [
  'overview',
  'affected-items',
  'conflicts',
  'impact',
  'files',
  'approvals',
  'workflow',
  'history',
] as const
export type ChangeOrderDetailTab = (typeof CHANGE_ORDER_DETAIL_TABS)[number]

interface ChangeOrderDetailProps {
  changeOrder?: ChangeOrder
  onSave: (changeOrder: ChangeOrder, designIds?: Array<string>) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: ChangeOrderDetailTab
  onTabChange?: (tab: ChangeOrderDetailTab) => void
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
  const invalidate = useInvalidateResources()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  const isCreateMode = !initialChangeOrder?.id

  const [changeOrder, setChangeOrder] = useState<ChangeOrder>(
    () => initialChangeOrder || createEmptyChangeOrder(),
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [attributes, setAttributes] = useState<Record<string, unknown>>(
    initialChangeOrder?.attributes || {},
  )

  const { data: workflowStructure } = useQuery(
    changeOrderWorkflowStructureQuery(
      changeOrder.id ?? '',
      !isCreateMode && !!changeOrder.id,
    ),
  )

  // Editable while the workflow has not reached a final state — the same rule
  // the server enforces (`assertChangeOrderEditable`). Gating on the literal
  // state name 'Draft' made a change order uneditable and undeletable through
  // the UI whenever its workflow called the initial state anything else.
  const currentWorkflowState = workflowStructure?.states.find(
    (s) => s.id === workflowStructure.currentState,
  )
  const isEditable =
    !isCreateMode &&
    (workflowStructure === undefined || currentWorkflowState?.isFinal !== true)

  // Deletable only in the initial state, which is the rule the server enforces
  // (`ItemService.requireNoRetainedEvidence`): past it the change order holds
  // votes, workflow history and an affected-item list that a hard delete would
  // cascade away. Read from the ChangeOrder definition rather than the
  // instance so a change order that has no workflow instance yet — freshly
  // created, and the one case the delete exists for — still offers it.
  const { data: changeOrderLifecycle } = useLifecyclePhases('ChangeOrder')
  const isDeletable =
    !isCreateMode &&
    (changeOrderLifecycle?.states ?? []).some(
      (s) => s.isInitial === true && s.id === changeOrder.state,
    )

  const { context, setContext } = useVersionContext(
    isCreateMode ? undefined : changeOrder.designId,
  )

  const isHistoricalView = context.type === 'commit' || context.type === 'tag'

  // Design selection state for create mode
  const [selectedDesigns, setSelectedDesigns] = useState<Array<Design>>([])
  const [designSearchQuery, setDesignSearchQuery] = useState('')
  const { data: availableDesigns = [], isFetching: loadingDesigns } = useQuery({
    ...designListQuery<Design>(),
    enabled: isCreateMode,
  })

  useEffect(() => {
    if (initialChangeOrder) {
      setChangeOrder(initialChangeOrder)
      setAttributes(initialChangeOrder.attributes || {})
    }
  }, [initialChangeOrder])

  // The design's main branch, for the history and structure views.
  const { data: ownDesign } = useQuery({
    ...designDetailQuery(changeOrder.designId ?? ''),
    enabled: !isCreateMode && Boolean(changeOrder.designId),
  })
  const mainBranchId = ownDesign?.defaultBranchId ?? undefined

  // The change order as it stood at the selected version context. Viewing
  // `main` addresses nothing, so the query stays disabled and the item the
  // caller already holds is shown.
  const { data: versionAtContext } = useQuery(
    itemAtContextQuery<ChangeOrder>(
      changeOrder.id ?? '',
      context,
      !isCreateMode && Boolean(changeOrder.designId),
    ),
  )

  const currentChangeOrder = isCreateMode
    ? changeOrder
    : (versionAtContext ?? changeOrder)

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

  // A change order has to affect at least one design — the server refuses
  // otherwise, since a design-less ECO belongs to no program and so would be
  // readable by everyone. Mirrored here so the refusal is visible before
  // submit rather than as an error afterwards.
  const hasRequiredDesigns = !isCreateMode || selectedDesigns.length > 0

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
      setAttributes(currentChangeOrder.attributes || {})
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
                <StateBadge
                  itemType="ChangeOrder"
                  state={currentChangeOrder.state}
                  className="text-base"
                />
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
                  disabled={isSubmitting || !hasRequiredDesigns}
                  title={
                    hasRequiredDesigns
                      ? undefined
                      : 'Select at least one affected design'
                  }
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
                {isEditable && (
                  <>
                    <Button variant="outline" onClick={handleEdit}>
                      <Edit className="h-4 w-4 mr-2" />
                      Edit
                    </Button>
                    {onDelete && isDeletable && (
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
      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange?.(value as ChangeOrderDetailTab)}
        className="w-full"
      >
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
                          ? changeOrder.description
                          : currentChangeOrder.description
                      }
                      onChange={(v) => updateField('description', v)}
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
                                data-testid="design-option"
                                data-design-id={design.id}
                                aria-pressed={isSelected}
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
                  <EcoSummaryDashboard changeOrderId={currentChangeOrder.id} />
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
                        void invalidate('files')
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
                                  {formatAttributeValue(value) || '-'}
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
                changeOrderState={currentChangeOrder.state ?? ''}
                readOnly={isHistoricalView}
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
                onResolve={() => void invalidate('change-orders')}
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
                changeOrderNumber={currentChangeOrder.itemNumber}
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
                      onStructureChange={() => void invalidate('change-orders')}
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
