import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ArrowLeft, Edit, Save, Trash2, X } from 'lucide-react'
import { CapabilitiesEditor } from './CapabilitiesEditor'
import type { KnownToolSubtype, Tool } from '@/lib/items/types/tool'
import type { SearchableSelectOption } from '@/components/ui/SearchableSelect'
import { TOOL_SUBTYPES, getSubtypeGroup } from '@/lib/items/types/tool'
import { PageContainer } from '@/components/layout'
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

// Tool state options match lifecycle: Draft -> Active -> Maintenance -> Retired
const STATE_OPTIONS = [
  { value: 'Draft', label: 'Draft' },
  { value: 'Active', label: 'Active' },
  { value: 'Maintenance', label: 'Maintenance' },
  { value: 'Retired', label: 'Retired' },
]

const TOOL_TYPE_OPTIONS = [
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'quality', label: 'Quality' },
  { value: 'utility', label: 'Utility' },
]

const TOOL_STATUS_OPTIONS = [
  { value: 'available', label: 'Available' },
  { value: 'in_use', label: 'In Use' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'retired', label: 'Retired' },
]

const stateVariant = (state: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Draft: 'secondary',
    Active: 'success',
    Maintenance: 'warning',
    Retired: 'destructive',
  }
  return variants[state] || 'default'
}

const statusVariant = (status: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    available: 'success',
    in_use: 'default',
    maintenance: 'warning',
    retired: 'destructive',
  }
  return variants[status] || 'default'
}

function subtypeLabel(subtype?: string): string {
  if (!subtype) return '-'
  const known = TOOL_SUBTYPES[subtype as KnownToolSubtype]
  return known?.label ?? subtype
}

const createEmptyTool = (): Tool => ({
  id: undefined,
  masterId: undefined,
  itemType: 'Tool',
  itemNumber: '',
  revision: 'A',
  name: '',
  state: 'Draft',
  isCurrent: true,
  toolType: 'manufacturing',
  toolSubtype: '',
  manufacturer: '',
  model: '',
  capabilities: {},
  toolStatus: 'available',
  location: '',
  notes: '',
})

interface ToolDetailProps {
  tool?: Tool
  onSave: (tool: Tool) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: 'details' | 'history'
  onTabChange?: (tab: string) => void
}

export function ToolDetail({
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
    (initialTool?.capabilities as Record<string, unknown>) ?? {},
  )

  useEffect(() => {
    if (initialTool) {
      setTool(initialTool)
      setCapabilities(
        (initialTool.capabilities as Record<string, unknown>) ?? {},
      )
    }
  }, [initialTool])

  const currentTool = tool

  const updateField = (field: keyof Tool, value: any) => {
    setTool((prev) => ({ ...prev, [field]: value }))
  }

  const handleEdit = () => {
    setIsEditing(true)
  }

  const handleSave = async () => {
    const toolToSave = {
      ...tool,
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
      setTool(initialTool || createEmptyTool())
      setCapabilities(
        (initialTool?.capabilities as Record<string, unknown>) ?? {},
      )
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
          <Badge
            variant={stateVariant(currentTool.state ?? 'Draft')}
            className="text-sm"
          >
            {currentTool.state ?? 'Draft'}
          </Badge>
          {currentTool.toolStatus && (
            <Badge
              variant={statusVariant(currentTool.toolStatus)}
              className="text-sm"
            >
              {currentTool.toolStatus}
            </Badge>
          )}
        </div>
      )}

      <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
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
                      placeholder="Auto-assigned"
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
                            onValueChange={(v) => updateField('toolSubtype', v)}
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
                        isEditing ? tool.manufacturer : currentTool.manufacturer
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
                      <pre className="text-sm font-mono bg-slate-100 dark:bg-slate-800 p-4 rounded-md overflow-x-auto">
                        {JSON.stringify(currentTool.capabilities, null, 2)}
                      </pre>
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
                  <ViewEditSelect
                    label="State"
                    value={isEditing ? tool.state : currentTool.state}
                    onChange={(v) => updateField('state', v)}
                    isEditing={isEditing}
                    options={STATE_OPTIONS}
                  />
                  <ViewEditSelect
                    label="Tool Status"
                    value={isEditing ? tool.toolStatus : currentTool.toolStatus}
                    onChange={(v) => updateField('toolStatus', v)}
                    isEditing={isEditing}
                    options={TOOL_STATUS_OPTIONS}
                  />
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
  )
}
