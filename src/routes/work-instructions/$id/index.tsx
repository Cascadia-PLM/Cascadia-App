import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import {
  ArrowLeft,
  ClipboardCheck,
  Edit,
  PlayCircle,
  Trash2,
  Zap,
} from 'lucide-react'
import type {
  WorkInstruction,
  WorkInstructionExecution,
  WorkInstructionOperation,
  WorkInstructionStep,
  WorkInstructionWithSteps,
} from '@/lib/items/types/work-instruction'
import { PageContainer } from '@/components/layout'
import { PartAttachmentPanel } from '@/components/work-instructions/PartAttachmentPanel'
import { OperationEditor } from '@/components/work-instructions/OperationEditor'
import { StepEditor } from '@/components/work-instructions/StepEditor'
import { WorkInstructionForm } from '@/components/work-instructions/WorkInstructionForm'
import { ChangeAlertBanner } from '@/components/work-instructions/ChangeAlertBanner'
import { ChangeAlertPanel } from '@/components/work-instructions/ChangeAlertPanel'
import { ExecutionHistoryTable } from '@/components/work-instructions/ExecutionHistoryTable'

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const searchSchema = z.object({
  tab: z.enum(['details', 'steps', 'parts', 'alerts', 'executions']).optional(),
  edit: z.boolean().optional(),
})

export const Route = createFileRoute('/work-instructions/$id/')({
  component: WorkInstructionDetailPage,
  validateSearch: searchSchema,
  loader: async ({ params }) => {
    try {
      const [wiResult, opsResult] = await Promise.all([
        apiFetch<{ data: { workInstruction: WorkInstructionWithSteps } }>(
          `/api/work-instructions/${params.id}`,
        ),
        apiFetch<{ data: { operations: Array<WorkInstructionOperation> } }>(
          `/api/work-instructions/${params.id}/operations`,
        ),
      ])
      return {
        workInstruction: {
          ...wiResult.data.workInstruction,
          operations: opsResult.data.operations,
        } as WorkInstructionWithSteps,
      }
    } catch (error) {
      console.error('Error loading work instruction:', error)
      throw error
    }
  },
})

const stateColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  Draft: 'secondary',
  InReview: 'warning',
  Approved: 'default',
  Released: 'success',
  Obsolete: 'destructive',
}

function WorkInstructionDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { workInstruction } = Route.useLoaderData()
  const search = Route.useSearch()

  const [isEditing, setIsEditing] = useState(search.edit ?? false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [steps, setSteps] = useState<Array<WorkInstructionStep>>(
    workInstruction.steps || [],
  )
  const [operations, setOperations] = useState<Array<WorkInstructionOperation>>(
    workInstruction.operations || [],
  )
  const [pendingAlertCount, setPendingAlertCount] = useState(0)

  const hasOperations = operations.length > 0

  // Fetch pending alert count
  useEffect(() => {
    if (!workInstruction.id) return
    fetch(`/api/work-instructions/${workInstruction.id}/alerts`)
      .then((r) => r.json())
      .then((data) => {
        setPendingAlertCount(data.data?.counts?.pending ?? 0)
      })
      .catch(() => {})
  }, [workInstruction.id])

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/work-instructions/$id',
      params: { id: workInstruction.id ?? '' },
      search: {
        tab: tab as 'details' | 'steps' | 'parts' | 'alerts',
        edit: isEditing,
      },
      replace: true,
    })
  }

  const handleSave = async (data: WorkInstruction) => {
    if (!workInstruction.id) return
    setIsSubmitting(true)
    try {
      await apiFetch(`/api/work-instructions/${workInstruction.id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })

      showSuccess(
        'Work Instruction updated',
        `${data.itemNumber || workInstruction.itemNumber} has been updated`,
      )
      setIsEditing(false)
      router.invalidate()
    } catch (error) {
      handleError(error, { title: 'Failed to update work instruction' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = () => {
    if (!workInstruction.id) return

    confirm({
      title: 'Delete Work Instruction',
      description: `Are you sure you want to delete ${workInstruction.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/work-instructions/${workInstruction.id}`, {
            method: 'DELETE',
          })

          showSuccess(
            'Work Instruction deleted',
            `${workInstruction.itemNumber} has been deleted`,
          )
          navigate({ to: '/work-instructions' })
        } catch (error) {
          handleError(error, { title: 'Failed to delete work instruction' })
        }
      },
    })
  }

  // Step management handlers
  const handleAddStep = useCallback(
    async (stepData: Partial<WorkInstructionStep>) => {
      try {
        const result = await apiFetch<{ data: { step: WorkInstructionStep } }>(
          `/api/work-instructions/${workInstruction.id}/steps`,
          {
            method: 'POST',
            body: JSON.stringify(stepData),
          },
        )
        setSteps((prev) => [...prev, result.data.step])
      } catch (error) {
        handleError(error, { title: 'Failed to add step' })
      }
    },
    [workInstruction.id, handleError],
  )

  const handleUpdateStep = useCallback(
    async (stepId: string, data: Partial<WorkInstructionStep>) => {
      try {
        const result = await apiFetch<{ data: { step: WorkInstructionStep } }>(
          `/api/work-instructions/${workInstruction.id}/steps/${stepId}`,
          {
            method: 'PUT',
            body: JSON.stringify(data),
          },
        )
        setSteps((prev) =>
          prev.map((s) => (s.id === stepId ? result.data.step : s)),
        )
      } catch (error) {
        handleError(error, { title: 'Failed to update step' })
      }
    },
    [workInstruction.id, handleError],
  )

  const handleDeleteStep = useCallback(
    (stepId: string) => {
      confirm({
        title: 'Delete Step',
        description: 'Are you sure you want to delete this step?',
        actionLabel: 'Delete',
        cancelLabel: 'Cancel',
        variant: 'destructive',
        onConfirm: async () => {
          try {
            await apiFetch(
              `/api/work-instructions/${workInstruction.id}/steps/${stepId}`,
              { method: 'DELETE' },
            )
            setSteps((prev) => prev.filter((s) => s.id !== stepId))
            showSuccess('Step deleted', 'The step has been removed')
          } catch (error) {
            handleError(error, { title: 'Failed to delete step' })
          }
        },
      })
    },
    [workInstruction.id, handleError, showSuccess, confirm],
  )

  const handleReorderSteps = useCallback(
    async (reorderedSteps: Array<{ id: string; orderIndex: number }>) => {
      try {
        const result = await apiFetch<{
          data: { steps: Array<WorkInstructionStep> }
        }>(`/api/work-instructions/${workInstruction.id}/steps`, {
          method: 'PUT',
          body: JSON.stringify({ steps: reorderedSteps }),
        })
        setSteps(result.data.steps)
      } catch (error) {
        handleError(error, { title: 'Failed to reorder steps' })
      }
    },
    [workInstruction.id, handleError],
  )

  const formatTime = (minutes?: number) => {
    if (!minutes) return '-'
    if (minutes < 60) return `${minutes} min`
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate({ to: '/work-instructions' })}
            className="shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-sky-100 dark:bg-sky-900 rounded-lg">
              <ClipboardCheck className="h-6 w-6 text-sky-600 dark:text-sky-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                  {workInstruction.itemNumber}
                </h1>
                <Badge variant={stateColors[workInstruction.state || 'Draft']}>
                  {workInstruction.state === 'InReview'
                    ? 'In Review'
                    : workInstruction.state}
                </Badge>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {workInstruction.name || 'Untitled Work Instruction'}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/work-instructions/$id/present"
            params={{ id: workInstruction.id ?? '' }}
          >
            <Button variant="outline">
              <PlayCircle className="h-4 w-4 mr-2" />
              Present
            </Button>
          </Link>
          <Link
            to="/work-instructions/$id/execute"
            params={{ id: workInstruction.id ?? '' }}
          >
            <Button
              variant="outline"
              className="text-emerald-600 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-700 dark:hover:bg-emerald-900/20"
            >
              <Zap className="h-4 w-4 mr-2" />
              Execute
            </Button>
          </Link>
          {!isEditing && (
            <Button variant="outline" onClick={() => setIsEditing(true)}>
              <Edit className="h-4 w-4 mr-2" />
              Edit
            </Button>
          )}
          <Button variant="destructive" size="icon" onClick={handleDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Alert Banner */}
      <ChangeAlertBanner
        pendingCount={pendingAlertCount}
        onViewAlerts={() => handleTabChange('alerts')}
      />

      {/* Tabs */}
      <Tabs value={search.tab ?? 'steps'} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="steps">Steps ({steps.length})</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="parts">Attached Parts</TabsTrigger>
          <TabsTrigger value="alerts" className="relative">
            Alerts
            {pendingAlertCount > 0 && (
              <Badge
                variant="warning"
                className="ml-1.5 h-5 min-w-[20px] px-1 text-xs"
              >
                {pendingAlertCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="executions">Executions</TabsTrigger>
        </TabsList>

        <TabsContent value="steps" className="mt-6">
          {hasOperations ? (
            <OperationEditor
              operations={operations}
              steps={steps}
              workInstructionId={workInstruction.id ?? ''}
              onOperationsChange={setOperations}
              onStepsChange={setSteps}
              onAddStep={handleAddStep}
              onUpdateStep={handleUpdateStep}
              onDeleteStep={handleDeleteStep}
              onReorderSteps={handleReorderSteps}
              onError={(error) =>
                handleError(error, { title: 'Operation error' })
              }
              onSuccess={(message) => showSuccess('Success', message)}
              isLoading={isSubmitting}
            />
          ) : (
            <StepEditor
              steps={steps}
              workInstructionId={workInstruction.id ?? ''}
              onAddStep={handleAddStep}
              onUpdateStep={handleUpdateStep}
              onDeleteStep={handleDeleteStep}
              onReorderSteps={handleReorderSteps}
              onError={(error) => handleError(error, { title: 'Step error' })}
            />
          )}
          {/* Show "Add Operation" hint when no operations exist but steps do */}
          {!hasOperations && steps.length > 0 && (
            <div className="mt-4 text-center">
              <p className="text-sm text-slate-500">
                Want to organize steps into operations?{' '}
                <button
                  className="text-sky-600 hover:underline"
                  onClick={async () => {
                    try {
                      const result = await apiFetch<{
                        data: { operation: WorkInstructionOperation }
                      }>(
                        `/api/work-instructions/${workInstruction.id}/operations`,
                        {
                          method: 'POST',
                          body: JSON.stringify({
                            title: 'New Operation',
                          }),
                        },
                      )
                      setOperations([result.data.operation])
                    } catch (error) {
                      handleError(error, {
                        title: 'Failed to add operation',
                      })
                    }
                  }}
                >
                  Add an operation
                </button>
              </p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="details" className="mt-6">
          {isEditing ? (
            <Card>
              <CardHeader>
                <CardTitle>Edit Work Instruction</CardTitle>
                <CardDescription>
                  Update the work instruction details
                </CardDescription>
              </CardHeader>
              <CardContent>
                <WorkInstructionForm
                  workInstruction={workInstruction}
                  onSubmit={handleSave}
                  onCancel={() => setIsEditing(false)}
                  isSubmitting={isSubmitting}
                />
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Basic Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <dt className="text-sm font-medium text-slate-500">
                      Work Instruction Number
                    </dt>
                    <dd className="mt-1 text-slate-900 dark:text-white">
                      {workInstruction.itemNumber}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-slate-500">Name</dt>
                    <dd className="mt-1 text-slate-900 dark:text-white">
                      {workInstruction.name || '-'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-slate-500">
                      Revision
                    </dt>
                    <dd className="mt-1 text-slate-900 dark:text-white">
                      {workInstruction.revision}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-slate-500">
                      State
                    </dt>
                    <dd className="mt-1">
                      <Badge
                        variant={stateColors[workInstruction.state || 'Draft']}
                      >
                        {workInstruction.state === 'InReview'
                          ? 'In Review'
                          : workInstruction.state}
                      </Badge>
                    </dd>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Procedure Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <dt className="text-sm font-medium text-slate-500">
                      Estimated Time
                    </dt>
                    <dd className="mt-1 text-slate-900 dark:text-white">
                      {formatTime(workInstruction.estimatedTime)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-slate-500">
                      Difficulty
                    </dt>
                    <dd className="mt-1 text-slate-900 dark:text-white">
                      {workInstruction.difficulty || '-'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-slate-500">
                      Required Tools
                    </dt>
                    <dd className="mt-1 text-slate-900 dark:text-white">
                      {workInstruction.requiredTools || '-'}
                    </dd>
                  </div>
                </CardContent>
              </Card>

              {workInstruction.description && (
                <Card className="md:col-span-2">
                  <CardHeader>
                    <CardTitle>Description</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                      {workInstruction.description}
                    </p>
                  </CardContent>
                </Card>
              )}

              {workInstruction.safetyNotes && (
                <Card className="md:col-span-2">
                  <CardHeader>
                    <CardTitle className="text-amber-600">
                      Safety Notes
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                      {workInstruction.safetyNotes}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="parts" className="mt-6">
          <PartAttachmentPanel
            workInstructionId={workInstruction.id ?? ''}
            onError={(error) =>
              handleError(error, { title: 'Part attachment error' })
            }
            onSuccess={(message) => showSuccess('Success', message)}
          />
        </TabsContent>

        <TabsContent value="alerts" className="mt-6">
          <ChangeAlertPanel
            workInstructionId={workInstruction.id ?? ''}
            onError={(error) => handleError(error, { title: 'Alert error' })}
            onSuccess={(message) => showSuccess('Success', message)}
            onCountsChange={(counts) => setPendingAlertCount(counts.pending)}
          />
        </TabsContent>

        <TabsContent value="executions" className="mt-6">
          <ExecutionsTab workInstructionId={workInstruction.id ?? ''} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  )
}

function ExecutionsTab({ workInstructionId }: { workInstructionId: string }) {
  const [executions, setExecutions] = useState<Array<WorkInstructionExecution>>(
    [],
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/work-instructions/${workInstructionId}/executions`)
      .then((r) => r.json())
      .then((data) => {
        setExecutions(data.data?.executions || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [workInstructionId])

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-slate-500">Loading executions...</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution History</CardTitle>
        <CardDescription>
          {executions.length}{' '}
          {executions.length === 1 ? 'execution' : 'executions'} recorded
        </CardDescription>
      </CardHeader>
      <CardContent>
        {executions.length > 0 ? (
          <ExecutionHistoryTable executions={executions} />
        ) : (
          <p className="text-slate-500 text-center py-8">
            No executions yet. Click "Execute" to start recording.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
