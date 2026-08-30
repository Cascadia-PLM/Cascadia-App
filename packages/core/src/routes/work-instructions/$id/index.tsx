// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import {
  ArrowLeft,
  Check,
  ClipboardCheck,
  Edit,
  GitBranch,
  Lock,
  PlayCircle,
  Trash2,
} from 'lucide-react'
import type {
  WorkInstruction,
  WorkInstructionOperation,
  WorkInstructionStep,
  WorkInstructionWithSteps,
} from '@/lib/items/types/work-instruction'
import type { WorkOrderInstructionStatus } from '@/lib/items/types/work-order'
import type { StepContentBlock } from '@/lib/db/schema/items'
import { PageContainer } from '@/components/layout'
import { PartAttachmentPanel } from '@/components/work-instructions/PartAttachmentPanel'
import { OperationEditor } from '@/components/work-instructions/OperationEditor'
import { StepEditor } from '@/components/work-instructions/StepEditor'
import { WorkInstructionForm } from '@/components/work-instructions/WorkInstructionForm'
import { ChangeAlertBanner } from '@/components/work-instructions/ChangeAlertBanner'
import { ChangeAlertPanel } from '@/components/work-instructions/ChangeAlertPanel'
import { CheckoutDialog } from '@/components/items/CheckoutDialog'

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  authSessionQuery,
  itemEditContextQuery,
  useInvalidateResources,
  useResourceMutation,
  workInstructionAlertCountQuery,
  workInstructionDetailQuery,
  workInstructionOperationsQuery,
  workInstructionUsageQuery,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import { StateBadge } from '@/components/items/StateBadge'

/** The tabs the work-instruction page renders; the search schema derives from this list. */
const WORK_INSTRUCTION_DETAIL_TABS = [
  'details',
  'steps',
  'parts',
  'alerts',
  'usage',
] as const
type WorkInstructionDetailTab = (typeof WORK_INSTRUCTION_DETAIL_TABS)[number]

const searchSchema = z.object({
  tab: z.enum(WORK_INSTRUCTION_DETAIL_TABS).optional(),
  edit: z.boolean().optional(),
})

export const Route = createFileRoute('/work-instructions/$id/')({
  component: WorkInstructionDetailPage,
  validateSearch: searchSchema,
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(workInstructionDetailQuery(params.id)),
      queryClient.ensureQueryData(workInstructionOperationsQuery(params.id)),
    ])
  },
})

interface WiEditContext {
  lockBranchId: string | null
  branchType: string | null
  isBranchLocked: boolean
  isMainProtected: boolean
  checkedOutBy: { id: string; name: string | null; email: string } | null
  state: string | null
  designId: string | null
}

function WorkInstructionDetailPage() {
  const { id } = Route.useParams()
  const { data: instruction } = useQuery(workInstructionDetailQuery(id))
  const { data: operations } = useQuery(workInstructionOperationsQuery(id))

  const workInstruction = useMemo(
    () =>
      instruction
        ? { ...instruction, operations: operations ?? [] }
        : undefined,
    [instruction, operations],
  )

  if (!workInstruction) return null

  return <WorkInstructionDetailView workInstruction={workInstruction} />
}

function WorkInstructionDetailView({
  workInstruction,
}: {
  workInstruction: WorkInstructionWithSteps
}) {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const search = Route.useSearch()

  // Editing is gated on holding the server-side checkout lock — the Edit
  // button acquires it, Done releases it. Content mutations without the lock
  // are rejected by the server, so the page never starts in edit mode.
  const [isEditing, setIsEditing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [checkoutDialogOpen, setCheckoutDialogOpen] = useState(false)
  const [autoEditAttempted, setAutoEditAttempted] = useState(false)

  // Steps and operations are read straight off the query-backed prop the
  // parent composed from `workInstructionDetailQuery` +
  // `workInstructionOperationsQuery`. They were mirrored into `useState` and
  // patched by hand after every write, which meant a concurrent edit — or any
  // write whose response shape differed from the row the server stored —
  // showed one thing here and another after a reload. Every write below
  // invalidates `work-instructions` instead, so the refetch is the only thing
  // that moves what is on screen.
  const steps = workInstruction.steps
  const operations = workInstruction.operations ?? []

  const hasOperations = operations.length > 0

  const { data: pendingAlertCount = 0 } = useQuery(
    workInstructionAlertCountQuery(workInstruction.id ?? ''),
  )

  // Who am I (for "checked out by you") — read from the session the root
  // route already primed, not a per-page probe.
  const { data: session } = useQuery(authSessionQuery())
  const currentUserId = session?.user?.id

  // Where the edit lock for this version lives (branch working copy, or
  // unprotected main); null lockBranchId + isMainProtected means "revise
  // through an ECO/workspace branch" (CheckoutDialog).
  const { data: editContext = null, refetch: refetchEditContext } = useQuery(
    itemEditContextQuery<WiEditContext>(workInstruction.id ?? ''),
  )
  const loadEditContext =
    useCallback(async (): Promise<WiEditContext | null> => {
      const { data } = await refetchEditContext()
      return data ?? null
    }, [refetchEditContext])

  const heldByMe = !!(
    editContext?.checkedOutBy &&
    currentUserId &&
    editContext.checkedOutBy.id === currentUserId
  )
  const lockedByOther = !!(editContext?.checkedOutBy && !heldByMe)
  const lockHolderLabel =
    editContext?.checkedOutBy?.name ||
    editContext?.checkedOutBy?.email ||
    'another user'

  const handleStartEditing = useCallback(async () => {
    if (!workInstruction.id) return

    const ctx = editContext ?? (await loadEditContext())
    if (!ctx) {
      handleError(
        new Error(
          'Could not determine where this work instruction can be edited. Reload the page and try again.',
        ),
        { title: 'Cannot edit' },
      )
      return
    }

    if (!ctx.lockBranchId) {
      if (ctx.isMainProtected) {
        // Released baseline — revise onto an ECO/workspace branch
        setCheckoutDialogOpen(true)
        return
      }
      // A work instruction takes its design from its output part, so it always
      // has somewhere to be edited — unless it predates that rule or its design
      // has no main branch. Say which, rather than "not in this context".
      handleError(
        new Error(
          ctx.designId
            ? "This work instruction's design has no main branch, so there is nowhere to hold the edit lock."
            : 'This work instruction has no output part, so it does not belong to a design yet. Attach the part it builds and set it as the output part.',
        ),
        { title: 'Cannot edit' },
      )
      return
    }

    try {
      await apiFetch(`/api/v1/items/${workInstruction.id}/checkout`, {
        method: 'POST',
        body: JSON.stringify({ branchId: ctx.lockBranchId }),
      })
    } catch (error) {
      handleError(error, { title: 'Cannot edit work instruction' })
      void loadEditContext()
      return
    }
    void loadEditContext()
    setIsEditing(true)
  }, [editContext, loadEditContext, workInstruction.id, handleError])

  const handleStopEditing = useCallback(async () => {
    const ctx = editContext
    if (ctx?.lockBranchId && workInstruction.id) {
      try {
        // cancel-checkout clears the lock; if nothing was changed it also
        // removes the empty branch row (content edits are already saved)
        await apiFetch(`/api/v1/items/${workInstruction.id}/cancel-checkout`, {
          method: 'POST',
          body: JSON.stringify({ branchId: ctx.lockBranchId }),
        })
      } catch {
        // Lock release is best-effort; the user can re-enter edit mode
      }
    }
    void loadEditContext()
    setIsEditing(false)
    // Cancelling the checkout is not a local change: it clears the lock, and
    // when nothing was edited it also deletes the branch row and the
    // working-copy item that the checkout created. A bare `router.invalidate()`
    // only re-runs the loaders, and those read through `ensureQueryData` — so
    // inside `staleTime` nothing refetched at all, and branch pickers on other
    // pages kept offering a branch that no longer exists. Name all three
    // resources so the caches that hold them go stale together.
    await invalidate('work-instructions', 'branches', 'items')
  }, [editContext, loadEditContext, workInstruction.id, invalidate])

  // After a CheckoutDialog revise-checkout, the working copy lives on the
  // chosen branch — navigate to it in edit mode.
  const handleCheckoutComplete = async (branchId: string) => {
    try {
      const res = await apiFetch<{
        data: { resolvedItemId?: string }
      }>(`/api/v1/items/${workInstruction.id}/at-context?branchId=${branchId}`)
      const targetId = res.data.resolvedItemId
      if (targetId && targetId !== workInstruction.id) {
        navigate({
          to: '/work-instructions/$id',
          params: { id: targetId },
          search: { tab: search.tab, edit: true },
        })
        return
      }
    } catch {
      // Fall through to editing in place
    }
    void loadEditContext()
    setIsEditing(true)
  }

  // ?edit=true (e.g. right after creating) starts an edit session through
  // the same lock acquisition as the Edit button — once.
  useEffect(() => {
    if (!search.edit || isEditing || autoEditAttempted || !editContext) return
    setAutoEditAttempted(true)
    void handleStartEditing()
  }, [
    search.edit,
    isEditing,
    autoEditAttempted,
    editContext,
    handleStartEditing,
  ])

  const handleTabChange = (tab: WorkInstructionDetailTab) => {
    router.navigate({
      to: '/work-instructions/$id',
      params: { id: workInstruction.id ?? '' },
      search: {
        tab,
        edit: isEditing,
      },
      replace: true,
    })
  }

  const handleSave = async (data: WorkInstruction) => {
    if (!workInstruction.id) return
    setIsSubmitting(true)
    try {
      await apiFetch(`/api/v1/work-instructions/${workInstruction.id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })

      showSuccess(
        'Work Instruction updated',
        `${data.itemNumber || workInstruction.itemNumber} has been updated`,
      )
      // Leaving edit mode releases the checkout lock
      await handleStopEditing()
      await invalidate('work-instructions')
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
          await apiFetch(`/api/v1/work-instructions/${workInstruction.id}`, {
            method: 'DELETE',
          })

          showSuccess(
            'Work Instruction deleted',
            `${workInstruction.itemNumber} has been deleted`,
          )
          await invalidate('work-instructions')
          navigate({ to: '/work-instructions' })
        } catch (error) {
          handleError(error, { title: 'Failed to delete work instruction' })
        }
      },
    })
  }

  // Step management. The four writes are `useResourceMutation`s so the
  // invalidation is registered by the hook rather than remembered at each call
  // site; the thin wrappers below exist because the editors call these props
  // un-awaited (StepEditor debounces content edits behind a timer), and a
  // rejecting promise there would be an unhandled rejection. Each wrapper
  // therefore reports the failure and resolves.
  const addStep = useResourceMutation({
    mutationFn: (stepData: Partial<WorkInstructionStep>) =>
      apiFetch(`/api/v1/work-instructions/${workInstruction.id}/steps`, {
        method: 'POST',
        body: JSON.stringify(stepData),
      }),
    invalidates: ['work-instructions'],
  })

  const updateStep = useResourceMutation({
    mutationFn: ({
      stepId,
      data,
    }: {
      stepId: string
      data: Partial<WorkInstructionStep>
    }) =>
      apiFetch(
        `/api/v1/work-instructions/${workInstruction.id}/steps/${stepId}`,
        {
          method: 'PUT',
          body: JSON.stringify(data),
        },
      ),
    invalidates: ['work-instructions'],
  })

  const deleteStep = useResourceMutation({
    mutationFn: (stepId: string) =>
      apiFetch(
        `/api/v1/work-instructions/${workInstruction.id}/steps/${stepId}`,
        { method: 'DELETE' },
      ),
    invalidates: ['work-instructions'],
    onSuccess: () => showSuccess('Step deleted', 'The step has been removed'),
  })

  const reorderSteps = useResourceMutation({
    mutationFn: (reordered: Array<{ id: string; orderIndex: number }>) =>
      apiFetch(`/api/v1/work-instructions/${workInstruction.id}/steps`, {
        method: 'PUT',
        body: JSON.stringify({ steps: reordered }),
      }),
    invalidates: ['work-instructions'],
  })

  const handleAddStep = useCallback(
    async (stepData: Partial<WorkInstructionStep>) => {
      try {
        await addStep.mutateAsync(stepData)
      } catch (error) {
        handleError(error, { title: 'Failed to add step' })
      }
    },
    [addStep.mutateAsync, handleError],
  )

  const handleUpdateStep = useCallback(
    async (stepId: string, data: Partial<WorkInstructionStep>) => {
      try {
        await updateStep.mutateAsync({ stepId, data })
      } catch (error) {
        handleError(error, { title: 'Failed to update step' })
      }
    },
    [updateStep.mutateAsync, handleError],
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
            await deleteStep.mutateAsync(stepId)
          } catch (error) {
            handleError(error, { title: 'Failed to delete step' })
          }
        },
      })
    },
    [deleteStep.mutateAsync, handleError, confirm],
  )

  const handleReorderSteps = useCallback(
    async (reorderedSteps: Array<{ id: string; orderIndex: number }>) => {
      try {
        await reorderSteps.mutateAsync(reorderedSteps)
      } catch (error) {
        handleError(error, { title: 'Failed to reorder steps' })
      }
    },
    [reorderSteps.mutateAsync, handleError],
  )

  // The "organize steps into operations" hint below creates the first
  // operation; OperationEditor owns every operation write once one exists.
  const addFirstOperation = useResourceMutation({
    mutationFn: () =>
      apiFetch(`/api/v1/work-instructions/${workInstruction.id}/operations`, {
        method: 'POST',
        body: JSON.stringify({ title: 'New Operation' }),
      }),
    invalidates: ['work-instructions'],
    onError: (error) =>
      handleError(error, { title: 'Failed to add operation' }),
  })

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
                <StateBadge
                  itemType="WorkInstruction"
                  state={workInstruction.state}
                />
                {editContext?.branchType &&
                  editContext.branchType !== 'main' && (
                    <Badge variant="secondary" className="text-xs">
                      <GitBranch className="h-3 w-3 mr-1" />
                      Working copy
                    </Badge>
                  )}
                {editContext?.checkedOutBy && (
                  <Badge
                    variant="outline"
                    className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700"
                  >
                    <Lock className="h-3 w-3 mr-1" />
                    {heldByMe
                      ? 'Checked out by you'
                      : `Checked out by ${lockHolderLabel}`}
                  </Badge>
                )}
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
          {isEditing ? (
            <Button variant="outline" onClick={() => void handleStopEditing()}>
              <Check className="h-4 w-4 mr-2" />
              Done Editing
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => void handleStartEditing()}
              disabled={lockedByOther || editContext?.isBranchLocked}
              title={
                lockedByOther
                  ? `Checked out by ${lockHolderLabel}`
                  : editContext?.isBranchLocked
                    ? 'Branch is locked (ECO submitted for approval)'
                    : undefined
              }
            >
              {editContext?.isMainProtected && !editContext.lockBranchId ? (
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
      <Tabs
        value={search.tab ?? 'steps'}
        onValueChange={(value) =>
          handleTabChange(value as WorkInstructionDetailTab)
        }
      >
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
          <TabsTrigger value="usage">Used By</TabsTrigger>
        </TabsList>

        <TabsContent value="steps" className="mt-6">
          {/* Step authoring follows the click-Edit policy: the editors only
              mount inside an edit session (checkout lock held) — otherwise a
              read-only view. The server rejects unlocked mutations anyway. */}
          {isEditing ? (
            <>
              {hasOperations ? (
                <OperationEditor
                  operations={operations}
                  steps={steps}
                  workInstructionId={workInstruction.id ?? ''}
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
                  onError={(error) =>
                    handleError(error, { title: 'Step error' })
                  }
                />
              )}
              {/* Show "Add Operation" hint when no operations exist but steps do */}
              {!hasOperations && steps.length > 0 && (
                <div className="mt-4 text-center">
                  <p className="text-sm text-slate-500">
                    Want to organize steps into operations?{' '}
                    <button
                      className="text-sky-600 dark:text-sky-400 hover:underline"
                      disabled={addFirstOperation.isPending}
                      onClick={() => addFirstOperation.mutate()}
                    >
                      Add an operation
                    </button>
                  </p>
                </div>
              )}
            </>
          ) : (
            <ReadOnlyStepsView operations={operations} steps={steps} />
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
                  onCancel={() => void handleStopEditing()}
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
                      <StateBadge
                        itemType="WorkInstruction"
                        state={workInstruction.state}
                      />
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
                    <CardTitle className="text-amber-600 dark:text-amber-400">
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
            readOnly={!isEditing}
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
          />
        </TabsContent>

        <TabsContent value="usage" className="mt-6">
          <UsageTab workInstructionId={workInstruction.id ?? ''} />
        </TabsContent>
      </Tabs>

      {workInstruction.id && workInstruction.designId && (
        <CheckoutDialog
          open={checkoutDialogOpen}
          onOpenChange={setCheckoutDialogOpen}
          itemId={workInstruction.id}
          itemNumber={workInstruction.itemNumber ?? ''}
          designId={workInstruction.designId}
          onCheckoutComplete={handleCheckoutComplete}
        />
      )}
    </PageContainer>
  )
}

function ReadOnlyStepBlock({ block }: { block: StepContentBlock }) {
  if (block.type === 'text') {
    return (
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-700 dark:text-slate-300">
        {block.content}
      </p>
    )
  }
  if (block.type === 'image') {
    return block.fileId ? (
      <div>
        <img
          src={`/api/v1/files/${block.fileId}`}
          alt={block.alt || 'Step image'}
          className="max-w-md max-h-64 rounded-md border border-slate-200 dark:border-slate-700"
        />
        {block.caption && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {block.caption}
          </p>
        )}
      </div>
    ) : null
  }
  if (block.type === 'parametric') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-700 rounded">
        {block.label && <span className="font-medium">{block.label}:</span>}
        <span>{block.fallbackValue || '—'}</span>
        {block.unit && <span>{block.unit}</span>}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 rounded">
      {block.fieldLabel || 'Data Field'}
      {block.fieldRequired && <span className="text-red-500">*</span>}
    </span>
  )
}

/**
 * Read-only rendering of the step structure shown outside an edit session.
 * Authoring (add/edit/reorder/delete) requires clicking Edit, which acquires
 * the server-side checkout lock.
 */
function ReadOnlyStepsView({
  operations,
  steps,
}: {
  operations: Array<WorkInstructionOperation>
  steps: Array<WorkInstructionStep>
}) {
  if (steps.length === 0 && operations.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-slate-500">
            No steps yet. Click Edit to start authoring this work instruction.
          </p>
        </CardContent>
      </Card>
    )
  }

  const sortedOps = [...operations].sort((a, b) => a.orderIndex - b.orderIndex)
  const sortedSteps = [...steps].sort((a, b) => a.orderIndex - b.orderIndex)
  const stepsByOperation = new Map<string | null, Array<WorkInstructionStep>>()
  for (const step of sortedSteps) {
    const key = step.operationId ?? null
    const bucket = stepsByOperation.get(key) ?? []
    bucket.push(step)
    stepsByOperation.set(key, bucket)
  }

  const renderStep = (step: WorkInstructionStep, index: number) => (
    <div
      key={step.id}
      className="flex gap-3 py-3 border-b border-slate-100 dark:border-slate-800 last:border-b-0"
    >
      <div className="shrink-0 w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-sm font-medium text-slate-600 dark:text-slate-300">
        {index + 1}
      </div>
      <div className="space-y-2 min-w-0">
        {step.title && (
          <p className="font-medium text-slate-900 dark:text-white">
            {step.title}
          </p>
        )}
        {step.content.blocks.map((block) => (
          <ReadOnlyStepBlock key={block.id} block={block} />
        ))}
      </div>
    </div>
  )

  const ungrouped = stepsByOperation.get(null) ?? []

  return (
    <div className="space-y-6">
      {sortedOps.map((op) => (
        <Card key={op.id}>
          <CardHeader>
            <CardTitle className="text-base">{op.title}</CardTitle>
            {op.description && (
              <CardDescription>{op.description}</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {(stepsByOperation.get(op.id) ?? []).length > 0 ? (
              (stepsByOperation.get(op.id) ?? []).map(renderStep)
            ) : (
              <p className="text-sm text-slate-500">No steps</p>
            )}
          </CardContent>
        </Card>
      ))}
      {ungrouped.length > 0 && (
        <Card>
          {sortedOps.length > 0 && (
            <CardHeader>
              <CardTitle className="text-base">Other Steps</CardTitle>
            </CardHeader>
          )}
          <CardContent className={sortedOps.length > 0 ? '' : 'pt-6'}>
            {ungrouped.map(renderStep)}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

interface TemplateUsageRow {
  id: string
  workOrderId: string
  workOrderNumber: string
  workOrderState: string
  title: string
  snapshotAt: string
  requiredCount: number
  status: WorkOrderInstructionStatus
  completedCount: number
  executionCount: number
  createdAt: string
}

const usageStatusStyles: Record<WorkOrderInstructionStatus, string> = {
  'Not Started':
    'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  'In Progress':
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  Complete:
    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  Skipped: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
}

/**
 * This template never executes directly — work orders instantiate it into
 * their travelers. This tab shows where.
 */
function UsageTab({ workInstructionId }: { workInstructionId: string }) {
  const { data: usage = [], isPending: loading } = useQuery(
    workInstructionUsageQuery<TemplateUsageRow>(workInstructionId),
  )

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-slate-500">Loading usage...</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Used By Work Orders</CardTitle>
        <CardDescription>
          Work orders carry frozen copies of this template on their travelers —
          executions are recorded there, not on the template
        </CardDescription>
      </CardHeader>
      <CardContent>
        {usage.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Work Order</TableHead>
                <TableHead>Snapshot Taken</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      to="/work-orders/$id"
                      params={{ id: row.workOrderId }}
                      search={{ tab: 'instructions' }}
                      className="text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 font-medium"
                    >
                      {row.workOrderNumber}
                    </Link>
                    <span className="text-xs text-slate-500 ml-2">
                      {row.workOrderState}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {new Date(row.snapshotAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">
                    {row.completedCount} / {row.requiredCount}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn(
                        'font-medium',
                        usageStatusStyles[row.status],
                      )}
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-slate-500 text-center py-8">
            Not used by any work order yet. Attach this template to parts, and
            work orders building those parts will pick it up when populating
            their travelers.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
