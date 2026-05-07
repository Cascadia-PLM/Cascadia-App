import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ClipboardCheck, Plus } from 'lucide-react'
import type { WorkInstruction } from '@/lib/items/types/work-instruction'
import { PageContainer } from '@/components/layout'
import { WorkInstructionTable } from '@/components/work-instructions/WorkInstructionTable'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/work-instructions/')({
  component: WorkInstructionsListPage,
  loader: async () => {
    try {
      const countParams = new URLSearchParams({
        itemType: 'WorkInstruction',
        limit: '1',
      })

      const [result, draftCount, inReviewCount, releasedCount] =
        await Promise.all([
          apiFetch<{ data: { items: Array<WorkInstruction>; total: number } }>(
            '/api/v1/items?itemType=WorkInstruction&limit=50',
          ),
          apiFetch<{ data: { total: number } }>(
            `/api/v1/items?${countParams}&state=Draft`,
          ).catch(() => ({ data: { total: 0 } })),
          apiFetch<{ data: { total: number } }>(
            `/api/v1/items?${countParams}&state=InReview`,
          ).catch(() => ({ data: { total: 0 } })),
          apiFetch<{ data: { total: number } }>(
            `/api/v1/items?${countParams}&state=Released`,
          ).catch(() => ({ data: { total: 0 } })),
        ])

      return {
        workInstructions: result.data.items,
        total: result.data.total,
        counts: {
          draft: draftCount.data.total,
          inReview: inReviewCount.data.total,
          released: releasedCount.data.total,
        },
      }
    } catch (error) {
      console.error('Error loading work instructions:', error)
      return {
        workInstructions: [] as Array<WorkInstruction>,
        total: 0,
        counts: { draft: 0, inReview: 0, released: 0 },
      }
    }
  },
})

function WorkInstructionsListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const {
    workInstructions: initialWorkInstructions,
    total,
    counts,
  } = Route.useLoaderData()
  const [workInstructions, setWorkInstructions] = useState<
    Array<WorkInstruction>
  >(initialWorkInstructions)

  // Sync local state with loader data when it changes
  useEffect(() => {
    setWorkInstructions(initialWorkInstructions)
  }, [initialWorkInstructions])

  const handleEdit = (workInstruction: WorkInstruction) => {
    if (workInstruction.id) {
      navigate({
        to: '/work-instructions/$id',
        params: { id: workInstruction.id },
      })
    }
  }

  const handlePresent = (workInstruction: WorkInstruction) => {
    if (workInstruction.id) {
      navigate({
        to: '/work-instructions/$id/present',
        params: { id: workInstruction.id },
      })
    }
  }

  const handleDelete = (workInstruction: WorkInstruction) => {
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

          setWorkInstructions(
            workInstructions.filter((wi) => wi.id !== workInstruction.id),
          )
          showSuccess(
            'Work Instruction deleted',
            `${workInstruction.itemNumber} has been deleted`,
          )

          // Reload to get fresh data from server
          router.invalidate()
        } catch (error) {
          handleError(error, { title: 'Failed to delete work instruction' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-sky-100 dark:bg-sky-900 rounded-lg">
            <ClipboardCheck className="h-6 w-6 text-sky-600 dark:text-sky-400" />
          </div>
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              Work Instructions
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              Step-by-step manufacturing procedures
            </p>
          </div>
        </div>
        <Link to="/work-instructions/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Work Instruction
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total</CardDescription>
            <CardTitle className="text-3xl">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Draft</CardDescription>
            <CardTitle className="text-3xl">{counts.draft}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">{counts.inReview}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Released</CardDescription>
            <CardTitle className="text-3xl">{counts.released}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Work Instructions Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Work Instructions</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'work instruction' : 'work instructions'} in
            the system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkInstructionTable
            items={workInstructions}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onPresent={handlePresent}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
