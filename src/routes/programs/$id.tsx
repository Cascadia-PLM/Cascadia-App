import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ArrowLeft,
  Box,
  Edit,
  GitBranch,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import type { CreateProgramInput, Program } from '@/lib/types/program'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { ProgramHistoryGraphView } from '@/components/programs/ProgramHistoryGraphView'
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
} from '@/components/ui'
import {
  ViewEditBadge,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui/view-edit-field'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/programs/$id')({
  component: ProgramDetailPage,
  loader: async ({ params }) => {
    const [programResult, designsResult] = await Promise.all([
      apiFetch<{ data: { program: Program } }>(`/api/programs/${params.id}`),
      apiFetch<{ data: { designs: Array<Design> } }>(
        `/api/designs?programId=${params.id}`,
      ).catch(() => ({ data: { designs: [] as Array<Design> } })),
    ])
    return {
      program: programResult.data.program,
      designs: designsResult.data.designs,
    }
  },
})

const statusOptions = [
  { value: 'Active', label: 'Active' },
  { value: 'On Hold', label: 'On Hold' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Cancelled', label: 'Cancelled' },
]

function statusVariant(
  value: string,
): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline' {
  const map: Record<
    string,
    'success' | 'warning' | 'secondary' | 'destructive'
  > = {
    Active: 'success',
    'On Hold': 'warning',
    Completed: 'secondary',
    Cancelled: 'destructive',
  }
  return map[value] ?? 'default'
}

function toDateInputValue(value: string | null | undefined): string {
  if (!value) return ''
  return new Date(value).toISOString().split('T')[0]
}

function ProgramDetailPage() {
  const router = useRouter()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { program, designs } = Route.useLoaderData()

  const [isEditing, setIsEditing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [editProgram, setEditProgram] = useState<Program>(program)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    (program.attributes ?? {}) as Record<string, string>,
  )

  const updateField = <TKey extends keyof Program>(
    field: TKey,
    value: Program[TKey],
  ) => {
    setEditProgram((prev) => ({ ...prev, [field]: value }))
  }

  const handleEdit = () => {
    setEditProgram(program)
    setAttributes((program.attributes ?? {}) as Record<string, string>)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setEditProgram(program)
    setAttributes((program.attributes ?? {}) as Record<string, string>)
    setIsEditing(false)
  }

  const handleSave = async () => {
    setIsSubmitting(true)
    try {
      const data: CreateProgramInput = {
        code: editProgram.code,
        name: editProgram.name,
        description: editProgram.description || '',
        status: editProgram.status,
        customer: editProgram.customer || '',
        contractNumber: editProgram.contractNumber || '',
        startDate: editProgram.startDate || '',
        targetEndDate: editProgram.targetEndDate || '',
        attributes,
      }
      await apiFetch(`/api/programs/${program.id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })

      setIsEditing(false)
      showSuccess(
        'Program updated',
        `${data.code} has been updated successfully`,
      )
      router.invalidate()
    } catch (error) {
      handleError(error, { title: 'Failed to update program' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = () => {
    confirm({
      title: 'Delete Program',
      description: `Are you sure you want to delete ${program.code}? This will also delete all associated designs. This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/programs/${program.id}`, {
            method: 'DELETE',
          })

          showSuccess('Program deleted', `${program.code} has been deleted`)
          router.navigate({ to: '/programs' })
        } catch (error) {
          handleError(error, { title: 'Failed to delete program' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/programs">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {program.code}
              </h1>
              <Badge
                className="text-base"
                variant={statusVariant(program.status)}
              >
                {program.status}
              </Badge>
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {program.name}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          {isEditing ? (
            <>
              <Button variant="outline" onClick={handleCancelEdit}>
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSubmitting}>
                <Save className="h-4 w-4 mr-2" />
                {isSubmitting ? 'Saving...' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleEdit}>
                <Edit className="h-4 w-4 mr-2" />
                Edit
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main Layout with Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content - Left 2 columns */}
        <div className="lg:col-span-2 space-y-6">
          {/* Overview */}
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
              <CardDescription>Program details and metadata</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ViewEditText
                  label="Program Code"
                  value={isEditing ? editProgram.code : program.code}
                  onChange={(v) => updateField('code', v)}
                  isEditing={isEditing}
                  required
                />

                <ViewEditText
                  label="Name"
                  value={isEditing ? editProgram.name : program.name}
                  onChange={(v) => updateField('name', v)}
                  isEditing={isEditing}
                  required
                />

                <ViewEditBadge
                  label="Status"
                  value={isEditing ? editProgram.status : program.status}
                  onChange={(v) => updateField('status', v)}
                  isEditing={isEditing}
                  options={statusOptions}
                  variant={statusVariant}
                />

                <ViewEditText
                  label="Customer"
                  value={isEditing ? editProgram.customer : program.customer}
                  onChange={(v) => updateField('customer', v)}
                  isEditing={isEditing}
                />

                <ViewEditText
                  label="Contract Number"
                  value={
                    isEditing
                      ? editProgram.contractNumber
                      : program.contractNumber
                  }
                  onChange={(v) => updateField('contractNumber', v)}
                  isEditing={isEditing}
                />

                <ViewEditText
                  label="Start Date"
                  value={
                    isEditing
                      ? toDateInputValue(editProgram.startDate)
                      : program.startDate
                        ? new Date(program.startDate).toLocaleDateString()
                        : null
                  }
                  onChange={(v) => updateField('startDate', v)}
                  isEditing={isEditing}
                  inputType="date"
                />

                <ViewEditText
                  label="Target End Date"
                  value={
                    isEditing
                      ? toDateInputValue(editProgram.targetEndDate)
                      : program.targetEndDate
                        ? new Date(program.targetEndDate).toLocaleDateString()
                        : null
                  }
                  onChange={(v) => updateField('targetEndDate', v)}
                  isEditing={isEditing}
                  inputType="date"
                />

                <ViewEditTextarea
                  label="Description"
                  value={
                    isEditing ? editProgram.description : program.description
                  }
                  onChange={(v) => updateField('description', v)}
                  isEditing={isEditing}
                  className="md:col-span-2"
                />
              </dl>
            </CardContent>
          </Card>

          {/* Change History */}
          {designs.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <GitBranch className="h-5 w-5 text-slate-400" />
                  <CardTitle>Change History</CardTitle>
                </div>
                <CardDescription>
                  Timeline of changes across all designs in this program
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ProgramHistoryGraphView programId={program.id} />
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar - Right column */}
        <div className="space-y-6">
          {/* Designs */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Designs</CardTitle>
                <CardDescription>
                  {designs.length} {designs.length === 1 ? 'design' : 'designs'}{' '}
                  in this program
                </CardDescription>
              </div>
              <Link to="/designs" search={{ programId: program.id }}>
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Design
                </Button>
              </Link>
            </CardHeader>
            <CardContent>
              {designs.length > 0 ? (
                <div className="space-y-3">
                  {designs.map((design) => (
                    <Link
                      key={design.id}
                      to="/designs/$id"
                      params={{ id: design.id }}
                      className="flex items-center justify-between p-4 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <Box className="h-5 w-5 text-slate-400" />
                        <div>
                          <p className="font-medium text-slate-900 dark:text-white">
                            {design.code}
                          </p>
                          <p className="text-sm text-slate-500 dark:text-slate-400">
                            {design.name}
                          </p>
                        </div>
                      </div>
                      <Badge
                        variant={
                          design.designType === 'Library'
                            ? 'secondary'
                            : 'default'
                        }
                      >
                        {design.designType}
                      </Badge>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                  No designs in this program yet. Click "Add Design" to create
                  one.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Custom Attributes */}
          {isEditing ? (
            <Card>
              <AttributesEditor
                value={attributes}
                onChange={setAttributes}
                className="border-0 rounded-none"
              />
            </Card>
          ) : (
            <Card>
              <Collapsible
                defaultOpen={Object.keys(program.attributes || {}).length > 0}
              >
                <CardHeader className="pb-3">
                  <CollapsibleTrigger className="flex items-center justify-between w-full hover:opacity-70">
                    <CardTitle>Custom Attributes</CardTitle>
                  </CollapsibleTrigger>
                </CardHeader>
                <CollapsibleContent>
                  <CardContent className="pt-0">
                    {Object.keys(program.attributes || {}).length > 0 ? (
                      <dl className="space-y-3">
                        {Object.entries(program.attributes || {}).map(
                          ([key, value]) => (
                            <div key={key} className="space-y-1">
                              <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                                {key}
                              </dt>
                              <dd className="text-slate-900 dark:text-white">
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
                  <div className="space-y-1">
                    <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                      Created
                    </dt>
                    <dd className="text-slate-900 dark:text-white">
                      {new Date(program.createdAt).toLocaleDateString()}
                    </dd>
                  </div>

                  <div className="space-y-1">
                    <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                      Last Modified
                    </dt>
                    <dd className="text-slate-900 dark:text-white">
                      {new Date(program.updatedAt).toLocaleDateString()}
                    </dd>
                  </div>

                  <div className="space-y-1">
                    <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                      Program ID
                    </dt>
                    <dd className="text-sm font-mono text-slate-600 dark:text-slate-400">
                      {program.id}
                    </dd>
                  </div>

                  {program.userRole && (
                    <div className="space-y-1">
                      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                        Your Role
                      </dt>
                      <dd>
                        <Badge variant="outline">{program.userRole}</Badge>
                      </dd>
                    </div>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </div>
      </div>
    </PageContainer>
  )
}
