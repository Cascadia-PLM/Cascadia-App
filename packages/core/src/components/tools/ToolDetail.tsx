// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Edit, Save, Trash2, X } from 'lucide-react'
import { CapabilitiesEditor, CapabilitiesView } from './CapabilitiesEditor'
import type { KnownToolSubtype, Tool } from '@/lib/items/types/tool'
import type { SearchableSelectOption } from '@/components/ui/SearchableSelect'
import type { UrlEnrichmentResult } from '@/components/items/useUrlDropEnrichment'
import { TOOL_SUBTYPES, getSubtypeGroup } from '@/lib/items/types/tool'
import { PageContainer } from '@/components/layout'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { UrlDropOverlay } from '@/components/items/UrlDropOverlay'
import { useUrlDropEnrichment } from '@/components/items/useUrlDropEnrichment'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { ITEM_NUMBER_PLACEHOLDER } from '@/lib/items/numbering/format'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  SearchableSelect,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ViewEditSelect,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { StateBadge } from '@/components/items/StateBadge'
import { FreeTransitionControl } from '@/components/items/FreeTransitionControl'

// Tool state options match lifecycle: Draft -> Active -> Maintenance -> Retired
const TOOL_TYPE_OPTIONS = [
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'quality', label: 'Quality' },
  { value: 'utility', label: 'Utility' },
]

function subtypeLabel(subtype?: string): string {
  if (!subtype) return '-'
  const known = TOOL_SUBTYPES[subtype as KnownToolSubtype] as
    { label: string } | undefined
  return known ? known.label : subtype
}

const createEmptyTool = (): Tool => ({
  id: undefined,
  masterId: undefined,
  itemType: 'Tool',
  itemNumber: '',
  name: '',
  state: '',
  isCurrent: true,
  toolType: 'manufacturing',
  toolSubtype: '',
  manufacturer: '',
  model: '',
  capabilities: {},
  location: '',
  notes: '',
})

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart; the `onValueChange` cast below is the one seam where
 * Radix's `string` meets it, and the triggers are rendered from the same
 * source of truth.
 */
export const TOOL_DETAIL_TABS = ['details', 'history'] as const
export type ToolDetailTab = (typeof TOOL_DETAIL_TABS)[number]

interface ToolDetailProps {
  /** Called after a lifecycle transition succeeds (refresh the item) */
  onTransitioned?: () => void
  tool?: Tool
  onSave: (tool: Tool) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: ToolDetailTab
  onTabChange?: (tab: ToolDetailTab) => void
}

export function ToolDetail({
  onTransitioned,
  tool: initialTool,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: ToolDetailProps) {
  const { confirm } = useAlertDialog()

  const isCreateMode = !initialTool?.id

  const [tool, setTool] = useState<Tool>(() => initialTool || createEmptyTool())
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [capabilities, setCapabilities] = useState<Record<string, unknown>>(
    initialTool?.capabilities ?? {},
  )
  const [attributes, setAttributes] = useState<Record<string, string>>(
    initialTool?.attributes ?? {},
  )

  const { showSuccess, showInfo } = useErrorHandler()

  useEffect(() => {
    if (initialTool) {
      setTool(initialTool)
      setCapabilities(initialTool.capabilities ?? {})
      setAttributes(initialTool.attributes ?? {})
    }
  }, [initialTool])

  const currentTool = tool

  const updateField = (field: keyof Tool, value: any) => {
    setTool((prev) => ({ ...prev, [field]: value }))
  }

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
      setTool((prev) => {
        const defaults = createEmptyTool() as unknown as Record<string, unknown>
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
        return next as unknown as Tool
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
    itemType: 'Tool',
    enabled: isCreateMode,
    onEnriched: applyEnrichment,
  })

  const handleEdit = () => {
    setIsEditing(true)
  }

  const handleSave = async () => {
    const toolToSave = {
      ...tool,
      attributes,
      capabilities:
        Object.keys(capabilities).length > 0 ? capabilities : undefined,
    }
    await onSave(toolToSave)
    if (!isCreateMode) setIsEditing(false)
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      setTool(initialTool)
      setCapabilities(initialTool.capabilities ?? {})
      setAttributes(initialTool.attributes ?? {})
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentTool.id) return
    confirm({
      title: 'Delete Tool',
      description: `Are you sure you want to delete ${currentTool.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: onDelete,
    })
  }

  const formatDate = (date?: string | Date) => {
    if (!date) return '-'
    try {
      return new Date(date).toLocaleDateString()
    } catch {
      return '-'
    }
  }

  // Filter subtypes by current tool type, with group labels for searchable dropdown
  const subtypeOptions: Array<SearchableSelectOption> = Object.entries(
    TOOL_SUBTYPES,
  )
    .filter(
      ([, meta]) =>
        meta.toolType === (isEditing ? tool.toolType : currentTool.toolType),
    )
    .map(([key, meta]) => ({
      value: key,
      label: meta.label,
      group: getSubtypeGroup(key),
    }))

  return (
    <div className="relative" {...dropHandlers}>
      <PageContainer>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link to="/tools">
              <Button variant="outline" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode ? 'Create New Tool' : currentTool.itemNumber}
              </h1>
              <p className="text-slate-600 dark:text-slate-400 mt-1">
                {isCreateMode
                  ? 'Enter the details for the new tool'
                  : currentTool.name || 'Unnamed'}
              </p>
            </div>
          </div>

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
                <Button onClick={handleSave} disabled={isSubmitting}>
                  <Save className="h-4 w-4 mr-2" />
                  {isSubmitting
                    ? 'Saving...'
                    : isCreateMode
                      ? 'Create Tool'
                      : 'Save Changes'}
                </Button>
              </>
            ) : (
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
          </div>
        </div>

        {!isCreateMode && (
          <div className="flex gap-2">
            <StateBadge
              itemType="Tool"
              state={currentTool.state}
              className="text-sm"
            />
            {currentTool.id && (
              <FreeTransitionControl
                itemId={currentTool.id}
                state={currentTool.state}
                onTransitioned={onTransitioned}
              />
            )}
          </div>
        )}

        <Tabs
          value={activeTab}
          onValueChange={(value) => onTabChange?.(value as ToolDetailTab)}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="mt-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-6">
                {/* Overview Card */}
                <Card>
                  <CardHeader>
                    <CardTitle>Overview</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <ViewEditText
                        label="Item Number"
                        value={
                          isEditing ? tool.itemNumber : currentTool.itemNumber
                        }
                        onChange={(v) => updateField('itemNumber', v)}
                        isEditing={isEditing && isCreateMode}
                        placeholder={ITEM_NUMBER_PLACEHOLDER}
                      />
                      <ViewEditText
                        label="Name"
                        value={isEditing ? tool.name : currentTool.name}
                        onChange={(v) => updateField('name', v)}
                        isEditing={isEditing}
                        placeholder="e.g., Prusa MK4S"
                        required
                      />
                    </dl>
                  </CardContent>
                </Card>

                {/* Tool Information Card */}
                <Card>
                  <CardHeader>
                    <CardTitle>Tool Information</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <ViewEditSelect
                        label="Tool Type"
                        value={isEditing ? tool.toolType : currentTool.toolType}
                        onChange={(v) => updateField('toolType', v)}
                        isEditing={isEditing}
                        options={TOOL_TYPE_OPTIONS}
                      />
                      {isEditing ? (
                        <div>
                          <dt className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">
                            Subtype
                          </dt>
                          <dd>
                            <SearchableSelect
                              value={tool.toolSubtype || ''}
                              onValueChange={(v) =>
                                updateField('toolSubtype', v)
                              }
                              options={[
                                ...subtypeOptions,
                                { value: 'other', label: 'Other' },
                              ]}
                              placeholder="Search subtypes..."
                              searchPlaceholder="Type to filter..."
                            />
                          </dd>
                        </div>
                      ) : (
                        <ViewEditStatic
                          label="Subtype"
                          value={subtypeLabel(currentTool.toolSubtype)}
                        />
                      )}
                      <ViewEditText
                        label="Manufacturer"
                        value={
                          isEditing
                            ? tool.manufacturer
                            : currentTool.manufacturer
                        }
                        onChange={(v) => updateField('manufacturer', v)}
                        isEditing={isEditing}
                        placeholder="e.g., Prusa Research"
                      />
                      <ViewEditText
                        label="Model"
                        value={isEditing ? tool.model : currentTool.model}
                        onChange={(v) => updateField('model', v)}
                        isEditing={isEditing}
                        placeholder="e.g., MK4S"
                      />
                    </dl>
                  </CardContent>
                </Card>

                {/* Capabilities Card */}
                {(isEditing ||
                  (currentTool.capabilities &&
                    Object.keys(currentTool.capabilities).length > 0)) && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Capabilities</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {isEditing ? (
                        <CapabilitiesEditor
                          subtype={tool.toolSubtype || ''}
                          capabilities={capabilities}
                          onChange={setCapabilities}
                        />
                      ) : (
                        <CapabilitiesView
                          capabilities={currentTool.capabilities ?? {}}
                        />
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>

              {/* Right sidebar */}
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Status & Location</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ViewEditText
                      label="Location"
                      value={isEditing ? tool.location : currentTool.location}
                      onChange={(v) => updateField('location', v)}
                      isEditing={isEditing}
                      placeholder="e.g., Workshop bench 3"
                    />
                  </CardContent>
                </Card>

                {/* Notes */}
                <Card>
                  <CardHeader>
                    <CardTitle>Notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ViewEditTextarea
                      label=""
                      value={isEditing ? tool.notes : currentTool.notes}
                      onChange={(v) => updateField('notes', v)}
                      isEditing={isEditing}
                      placeholder="Free-form notes about this tool..."
                    />
                  </CardContent>
                </Card>

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
                        Object.keys(currentTool.attributes ?? {}).length > 0
                      }
                    >
                      <CardHeader className="pb-3">
                        <CollapsibleTrigger className="hover:opacity-70">
                          <CardTitle>Custom Attributes</CardTitle>
                        </CollapsibleTrigger>
                      </CardHeader>
                      <CollapsibleContent>
                        <CardContent className="pt-0">
                          {Object.keys(currentTool.attributes ?? {}).length >
                          0 ? (
                            <dl className="space-y-3">
                              {Object.entries(currentTool.attributes ?? {}).map(
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
                          label="Revision"
                          value={currentTool.revision}
                        />
                        <ViewEditStatic
                          label="Created"
                          value={formatDate(currentTool.createdAt)}
                        />
                        <ViewEditStatic
                          label="Last Modified"
                          value={formatDate(currentTool.modifiedAt)}
                        />
                        {!isCreateMode && (
                          <ViewEditStatic
                            label="Tool ID"
                            value={currentTool.id}
                            mono
                          />
                        )}
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="history" className="mt-6">
            {currentTool.id ? (
              <ItemHistoryTab
                itemId={currentTool.id}
                designId={currentTool.designId ?? null}
                versionContext={{ type: 'main' }}
                onViewHistoricalState={() => {}}
              />
            ) : (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-slate-500">
                    Save the tool first to view history
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </PageContainer>
      <UrlDropOverlay isDragging={isDragging} isEnriching={isEnriching} />
    </div>
  )
}
