import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ArrowLeft, Edit, Save, Trash2, X } from 'lucide-react'
import type { Issue } from '@/lib/items/types/issue'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { DesignMultiSelector } from '@/components/versioning/DesignMultiSelector'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { apiFetch } from '@/lib/api/client'
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
  ViewEditBadge,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

const STATE_OPTIONS = [
  { value: 'Open', label: 'Open' },
  { value: 'InProgress', label: 'In Progress' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Resolved', label: 'Resolved' },
  { value: 'Verified', label: 'Verified' },
  { value: 'Closed', label: 'Closed' },
  { value: 'Cancelled', label: 'Cancelled' },
]

const SEVERITY_OPTIONS = [
  { value: 'Critical', label: 'Critical' },
  { value: 'High', label: 'High' },
  { value: 'Medium', label: 'Medium' },
  { value: 'Low', label: 'Low' },
]

const PRIORITY_OPTIONS = [
  { value: 'Critical', label: 'Critical' },
  { value: 'High', label: 'High' },
  { value: 'Medium', label: 'Medium' },
  { value: 'Low', label: 'Low' },
]

const CATEGORY_OPTIONS = [
  { value: 'Design', label: 'Design' },
  { value: 'Manufacturing', label: 'Manufacturing' },
  { value: 'Quality', label: 'Quality' },
  { value: 'Customer', label: 'Customer' },
  { value: 'Safety', label: 'Safety' },
  { value: 'Other', label: 'Other' },
]

const stateVariant = (state: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Open: 'default',
    InProgress: 'warning',
    Pending: 'secondary',
    Resolved: 'success',
    Verified: 'success',
    Closed: 'secondary',
    Cancelled: 'destructive',
  }
  return variants[state] || 'default'
}

const severityVariant = (severity: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Critical: 'destructive',
    High: 'warning',
    Medium: 'default',
    Low: 'secondary',
  }
  return variants[severity] || 'default'
}

const priorityVariant = (priority: string) => {
  const variants: Record<
    string,
    'default' | 'secondary' | 'success' | 'warning' | 'destructive'
  > = {
    Critical: 'destructive',
    High: 'warning',
    Medium: 'default',
    Low: 'secondary',
  }
  return variants[priority] || 'default'
}

const createEmptyIssue = (): Issue => ({
  id: undefined,
  masterId: undefined,
  itemType: 'Issue',
  itemNumber: '',
  revision: 'A',
  name: '',
  description: '',
  state: 'Open',
  isCurrent: true,
  severity: 'Medium',
  priority: 'Medium',
  category: undefined,
  reportedBy: undefined,
  reportedDate: undefined,
  assignedTo: undefined,
  resolution: '',
  resolvedDate: undefined,
  rootCause: '',
  affectedItemIds: [],
  programId: undefined,
  designId: undefined,
  designIds: [],
  createdAt: undefined,
  modifiedAt: undefined,
})

interface IssueDetailProps {
  issue?: Issue
  /** Available designs for the design selector */
  designs?: Array<Design>
  /** Default design IDs (for create mode from a design context) */
  defaultDesignIds?: Array<string>
  /** Callback when issue is saved */
  onSave: (issue: Issue) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: 'details' | 'history'
  onTabChange?: (tab: string) => void
}

export function IssueDetail({
  issue: initialIssue,
  designs = [],
  defaultDesignIds = [],
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: IssueDetailProps) {
  const { confirm } = useAlertDialog()

  const isCreateMode = !initialIssue?.id

  const [issue, setIssue] = useState<Issue>(
    () =>
      initialIssue || {
        ...createEmptyIssue(),
        designIds: defaultDesignIds,
      },
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(initialIssue?.attributes ?? {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(', ') : String(value),
      ]),
    ),
  )

  const [displayedIssue, setDisplayedIssue] = useState<Issue>(issue)

  const { context, setContext } = useVersionContext(
    isCreateMode ? undefined : issue.designId,
  )

  useEffect(() => {
    if (initialIssue) {
      setIssue(initialIssue)
      setDisplayedIssue(initialIssue)
      setAttributes(
        Object.fromEntries(
          Object.entries(initialIssue.attributes ?? {}).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(', ') : String(value),
          ]),
        ),
      )
    }
  }, [initialIssue])

  useEffect(() => {
    async function fetchVersionAtContext() {
      if (isCreateMode || !issue.designId || context.type === 'main') {
        setDisplayedIssue(issue)
        return
      }

      try {
        const params = new URLSearchParams()
        if (context.type === 'commit' && context.commitId)
          params.set('commitId', context.commitId)
        else if (context.type === 'tag' && context.tagId)
          params.set('tagId', context.tagId)
        else if (context.type === 'branch' && context.branchId)
          params.set('branchId', context.branchId)

        const queryString = params.toString()
        if (!queryString) {
          setDisplayedIssue(issue)
          return
        }

        const response = await apiFetch<{ data: { item: Issue | null } }>(
          `/api/v1/items/${issue.id}/at-context?${queryString}`,
        )
        setDisplayedIssue(response.data.item || issue)
      } catch {
        setDisplayedIssue(issue)
      }
    }
    fetchVersionAtContext()
  }, [issue, context, isCreateMode])

  const currentIssue = isCreateMode ? issue : displayedIssue

  // Get selected designs for display
  const selectedDesigns = (issue.designIds || [])
    .map((id) => designs.find((d) => d.id === id))
    .filter((d): d is Design => d !== undefined)

  const updateField = (field: keyof Issue, value: unknown) => {
    setIssue((prev) => ({ ...prev, [field]: value }))
  }

  const handleEdit = () => {
    setIssue(currentIssue)
    setIsEditing(true)
  }

  const handleSave = async () => {
    const issueWithAttributes = {
      ...issue,
      attributes,
    }
    await onSave(issueWithAttributes)
    if (!isCreateMode) setIsEditing(false)
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      setIssue(currentIssue)
      setAttributes(
        Object.fromEntries(
          Object.entries(currentIssue.attributes ?? {}).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(', ') : String(value),
          ]),
        ),
      )
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !currentIssue.id) return
    confirm({
      title: 'Delete Issue',
      description: `Are you sure you want to delete ${currentIssue.itemNumber}? This action cannot be undone.`,
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

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/issues">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              {isCreateMode ? 'Create New Issue' : currentIssue.itemNumber}
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {isCreateMode
                ? 'Enter the details for the new issue'
                : currentIssue.name || 'Unnamed'}
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
                    ? 'Create Issue'
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
        <div className="flex gap-2 flex-wrap">
          <Badge
            variant={stateVariant(currentIssue.state ?? 'Open')}
            className="text-sm"
          >
            {currentIssue.state ?? 'Open'}
          </Badge>
          {currentIssue.severity && (
            <Badge
              variant={severityVariant(currentIssue.severity)}
              className="text-sm"
            >
              {currentIssue.severity} Severity
            </Badge>
          )}
          {currentIssue.priority && (
            <Badge
              variant={priorityVariant(currentIssue.priority)}
              className="text-sm"
            >
              {currentIssue.priority} Priority
            </Badge>
          )}
          {currentIssue.category && (
            <Badge variant="secondary" className="text-sm">
              {currentIssue.category}
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
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="Issue Number"
                      value={
                        isEditing ? issue.itemNumber : currentIssue.itemNumber
                      }
                      onChange={(v) => updateField('itemNumber', v)}
                      isEditing={isEditing && isCreateMode}
                      placeholder="ISS-000001"
                      required
                    />
                    <ViewEditText
                      label="Title"
                      value={isEditing ? issue.name : currentIssue.name}
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="Issue title"
                      required
                    />
                    <ViewEditBadge
                      label="State"
                      value={isEditing ? issue.state : currentIssue.state}
                      onChange={(v) => updateField('state', v)}
                      isEditing={isEditing}
                      options={STATE_OPTIONS}
                      variant={stateVariant}
                    />
                    <ViewEditBadge
                      label="Category"
                      value={isEditing ? issue.category : currentIssue.category}
                      onChange={(v) => updateField('category', v)}
                      isEditing={isEditing}
                      options={CATEGORY_OPTIONS}
                    />
                    <ViewEditBadge
                      label="Severity"
                      value={isEditing ? issue.severity : currentIssue.severity}
                      onChange={(v) => updateField('severity', v)}
                      isEditing={isEditing}
                      options={SEVERITY_OPTIONS}
                      variant={severityVariant}
                    />
                    <ViewEditBadge
                      label="Priority"
                      value={isEditing ? issue.priority : currentIssue.priority}
                      onChange={(v) => updateField('priority', v)}
                      isEditing={isEditing}
                      options={PRIORITY_OPTIONS}
                      variant={priorityVariant}
                    />
                    <ViewEditTextarea
                      label="Description"
                      value={
                        isEditing ? issue.description : currentIssue.description
                      }
                      onChange={(v) => updateField('description', v)}
                      isEditing={isEditing}
                      placeholder="Detailed description of the issue"
                      className="md:col-span-2"
                    />
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Root Cause & Resolution</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-6">
                    <ViewEditTextarea
                      label="Root Cause"
                      value={
                        isEditing ? issue.rootCause : currentIssue.rootCause
                      }
                      onChange={(v) => updateField('rootCause', v)}
                      isEditing={isEditing}
                      placeholder="Root cause analysis"
                    />
                    <ViewEditTextarea
                      label="Resolution"
                      value={
                        isEditing ? issue.resolution : currentIssue.resolution
                      }
                      onChange={(v) => updateField('resolution', v)}
                      isEditing={isEditing}
                      placeholder="How the issue was resolved"
                    />
                  </dl>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Assignment</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ViewEditText
                    label="Assigned To"
                    value={
                      isEditing ? issue.assignedTo : currentIssue.assignedTo
                    }
                    onChange={(v) => updateField('assignedTo', v)}
                    isEditing={isEditing}
                    placeholder="user@example.com"
                  />
                  <ViewEditStatic
                    label="Reported Date"
                    value={formatDate(currentIssue.reportedDate)}
                  />
                  <ViewEditStatic
                    label="Resolved Date"
                    value={formatDate(currentIssue.resolvedDate)}
                  />
                </CardContent>
              </Card>

              {/* Associated Designs - Multi-select, no branch control */}
              {designs.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Associated Designs</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isEditing ? (
                      <div className="space-y-2">
                        <DesignMultiSelector
                          designs={designs}
                          value={issue.designIds || []}
                          onChange={(value) => updateField('designIds', value)}
                          placeholder="Select designs..."
                        />
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                          Optional: Associate with one or more designs
                        </p>
                      </div>
                    ) : selectedDesigns.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {selectedDesigns.map((design) => (
                          <Badge key={design.id} variant="secondary">
                            {design.code}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        No designs associated
                      </p>
                    )}
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
                      Object.keys(currentIssue.attributes || {}).length > 0
                    }
                  >
                    <CardHeader className="pb-3">
                      <CollapsibleTrigger className="hover:opacity-70">
                        <CardTitle>Custom Attributes</CardTitle>
                      </CollapsibleTrigger>
                    </CardHeader>
                    <CollapsibleContent>
                      <CardContent className="pt-0">
                        {Object.keys(currentIssue.attributes || {}).length >
                        0 ? (
                          <dl className="space-y-3">
                            {Object.entries(currentIssue.attributes || {}).map(
                              ([key, value]) => (
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
                        value={currentIssue.revision}
                      />
                      <ViewEditStatic
                        label="Created"
                        value={formatDate(currentIssue.createdAt)}
                      />
                      <ViewEditStatic
                        label="Last Modified"
                        value={formatDate(currentIssue.modifiedAt)}
                      />
                      {!isCreateMode && (
                        <ViewEditStatic
                          label="Issue ID"
                          value={currentIssue.id}
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
          {currentIssue.id ? (
            <ItemHistoryTab
              itemId={currentIssue.id}
              designId={currentIssue.designId ?? null}
              versionContext={context}
              onViewHistoricalState={setContext}
            />
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-slate-500">
                  Save the issue first to view history
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </PageContainer>
  )
}
