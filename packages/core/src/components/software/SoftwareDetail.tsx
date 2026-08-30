// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ArrowLeft, Edit, Save, Trash2, X } from 'lucide-react'
import { BuildArtifactCard } from './BuildArtifactCard'
import { SourceViewer } from './SourceViewer'
import type { Software } from '@/lib/items/types/software'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
import { useReleasedFamily } from '@/lib/hooks/useReleasedFamily'

const SOFTWARE_TYPE_OPTIONS = [
  { value: 'firmware', label: 'Firmware' },
  { value: 'application', label: 'Application' },
  { value: 'library', label: 'Library' },
  { value: 'configuration', label: 'Configuration' },
  { value: 'fpga', label: 'FPGA' },
]

const SOURCE_MODE_OPTIONS = [
  { value: 'internal', label: 'Internal (source lives in Cascadia)' },
  { value: 'external', label: 'External (pinned repository ref)' },
]

const createEmptySoftware = (defaultDesignId?: string): Software => ({
  id: undefined,
  masterId: undefined,
  itemType: 'Software',
  designId: defaultDesignId ?? '',
  itemNumber: '',
  name: '',
  state: '',
  isCurrent: true,
  description: '',
  softwareType: 'firmware',
  sourceMode: 'internal',
  version: '',
  targetHardware: '',
  toolchain: '',
})

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart; the `onValueChange` cast below is the one seam where
 * Radix's `string` meets it, and the triggers are rendered from the same
 * source of truth.
 */
export const SOFTWARE_DETAIL_TABS = ['details', 'source', 'history'] as const
export type SoftwareDetailTab = (typeof SOFTWARE_DETAIL_TABS)[number]

interface SoftwareDetailProps {
  software?: Software
  designs?: Array<Design>
  defaultDesignId?: string
  onSave: (software: Software) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: SoftwareDetailTab
  onTabChange?: (tab: SoftwareDetailTab) => void
}

export function SoftwareDetail({
  software: initialSoftware,
  designs = [],
  defaultDesignId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: SoftwareDetailProps) {
  const { confirm } = useAlertDialog()

  const isCreateMode = !initialSoftware?.id

  const [software, setSoftware] = useState<Software>(
    () => initialSoftware || createEmptySoftware(defaultDesignId),
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    initialSoftware?.attributes ?? {},
  )

  useEffect(() => {
    if (initialSoftware) {
      setSoftware(initialSoftware)
      setAttributes(initialSoftware.attributes ?? {})
    }
  }, [initialSoftware])

  const current = software
  const { isReleasedFamily } = useReleasedFamily('Software', current.state)

  const updateField = (field: keyof Software, value: unknown) => {
    setSoftware((prev) => ({ ...prev, [field]: value }))
  }

  const handleSave = async () => {
    await onSave({ ...software, attributes })
    if (!isCreateMode) setIsEditing(false)
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      setSoftware(initialSoftware)
      setAttributes(initialSoftware.attributes ?? {})
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !current.id) return
    confirm({
      title: 'Delete Software',
      description: `Are you sure you want to delete ${current.itemNumber}? This action cannot be undone.`,
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

  const designOptions = designs.map((d) => ({
    value: d.id,
    label: d.name,
  }))

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/software">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              {isCreateMode ? 'Create Software Item' : current.itemNumber}
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {isCreateMode
                ? 'The configuration item behind a firmware or software BOM line'
                : current.name || 'Unnamed'}
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
                    ? 'Create Software'
                    : 'Save Changes'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setIsEditing(true)}>
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
            itemType="Software"
            state={current.state}
            className="text-sm"
          />
          <Badge variant="secondary" className="text-sm font-mono">
            Rev {current.revision}
          </Badge>
          {current.version && (
            <Badge variant="default" className="text-sm font-mono">
              v{current.version}
            </Badge>
          )}
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange?.(value as SoftwareDetailTab)}
        className="w-full"
      >
        <TabsList
          className={
            isCreateMode ? 'grid w-full grid-cols-1' : 'grid w-full grid-cols-3'
          }
        >
          <TabsTrigger value="details">Details</TabsTrigger>
          {!isCreateMode && <TabsTrigger value="source">Source</TabsTrigger>}
          {!isCreateMode && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>

        <TabsContent value="details" className="mt-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="Item Number"
                      value={
                        isEditing ? software.itemNumber : current.itemNumber
                      }
                      onChange={(v) => updateField('itemNumber', v)}
                      isEditing={isEditing && isCreateMode}
                      placeholder="Auto-assigned (SW-...)"
                    />
                    <ViewEditText
                      label="Name"
                      value={isEditing ? software.name : current.name}
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="e.g., TDJ-25 Motor Firmware"
                      required
                    />
                    {isCreateMode ? (
                      <ViewEditSelect
                        label="Design"
                        value={software.designId}
                        onChange={(v) => updateField('designId', v)}
                        isEditing={isEditing}
                        options={designOptions}
                      />
                    ) : (
                      <ViewEditStatic
                        label="Design"
                        value={
                          designs.find((d) => d.id === current.designId)
                            ?.name ?? current.designId
                        }
                      />
                    )}
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Software Information</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditSelect
                      label="Software Type"
                      value={
                        isEditing ? software.softwareType : current.softwareType
                      }
                      onChange={(v) => updateField('softwareType', v)}
                      isEditing={isEditing}
                      options={SOFTWARE_TYPE_OPTIONS}
                    />
                    <ViewEditSelect
                      label="Source Mode"
                      value={
                        isEditing ? software.sourceMode : current.sourceMode
                      }
                      onChange={(v) => updateField('sourceMode', v)}
                      isEditing={isEditing && isCreateMode}
                      options={SOURCE_MODE_OPTIONS}
                    />
                    <ViewEditText
                      label="Version"
                      value={isEditing ? software.version : current.version}
                      onChange={(v) => updateField('version', v)}
                      isEditing={isEditing}
                      placeholder="e.g., 2.3.0"
                    />
                    <ViewEditText
                      label="Target Hardware"
                      value={
                        isEditing
                          ? software.targetHardware
                          : current.targetHardware
                      }
                      onChange={(v) => updateField('targetHardware', v)}
                      isEditing={isEditing}
                      placeholder="e.g., STM32F407, board rev C"
                    />
                    <ViewEditText
                      label="Toolchain"
                      value={isEditing ? software.toolchain : current.toolchain}
                      onChange={(v) => updateField('toolchain', v)}
                      isEditing={isEditing}
                      placeholder="e.g., arm-none-eabi-gcc 13.2, CMake"
                    />
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Description</CardTitle>
                </CardHeader>
                <CardContent>
                  <ViewEditTextarea
                    label=""
                    value={
                      isEditing ? software.description : current.description
                    }
                    onChange={(v) => updateField('description', v)}
                    isEditing={isEditing}
                    placeholder="What this software does, its scope, and constraints..."
                  />
                </CardContent>
              </Card>
            </div>

            {/* Right sidebar */}
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Source</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <ViewEditStatic
                    label="Mode"
                    value={current.sourceMode ?? 'internal'}
                  />
                  <ViewEditStatic
                    label="Source snapshot"
                    value={
                      current.manifestId
                        ? 'Imported (see Source tab)'
                        : 'No source imported yet'
                    }
                  />
                  {current.draftManifestId && (
                    <ViewEditStatic
                      label="Draft"
                      value="Uncommitted changes (see Source tab)"
                    />
                  )}
                </CardContent>
              </Card>

              {!isCreateMode && current.id && (
                <BuildArtifactCard software={current} />
              )}

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
                      Object.keys(current.attributes ?? {}).length > 0
                    }
                  >
                    <CardHeader className="pb-3">
                      <CollapsibleTrigger className="hover:opacity-70">
                        <CardTitle>Custom Attributes</CardTitle>
                      </CollapsibleTrigger>
                    </CardHeader>
                    <CollapsibleContent>
                      <CardContent className="pt-0">
                        {Object.keys(current.attributes ?? {}).length > 0 ? (
                          <dl className="space-y-3">
                            {Object.entries(current.attributes ?? {}).map(
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

              {!isCreateMode && (
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
                          value={current.revision}
                        />
                        <ViewEditStatic
                          label="Created"
                          value={formatDate(current.createdAt)}
                        />
                        <ViewEditStatic
                          label="Modified"
                          value={formatDate(current.modifiedAt)}
                        />
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              )}
            </div>
          </div>
        </TabsContent>

        {!isCreateMode && current.id && (
          <TabsContent value="source" className="mt-6">
            <SourceViewer
              itemId={current.id}
              canImport={(current.sourceMode ?? 'internal') === 'internal'}
              canEdit={
                (current.sourceMode ?? 'internal') === 'internal' &&
                !isReleasedFamily
              }
            />
          </TabsContent>
        )}

        {!isCreateMode && current.id && (
          <TabsContent value="history" className="mt-6">
            <ItemHistoryTab
              itemId={current.id}
              designId={current.designId || null}
              versionContext={{ type: 'main' }}
              itemType="Software"
            />
          </TabsContent>
        )}
      </Tabs>
    </PageContainer>
  )
}
