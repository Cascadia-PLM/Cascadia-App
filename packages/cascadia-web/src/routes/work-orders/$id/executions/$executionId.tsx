// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ClipboardCheck } from 'lucide-react'
import type { InstructionExecution } from '@/lib/items/types/work-order'
import { PageContainer } from '@/components/layout'
import { ExecutionDetailView } from '@/components/work-instructions/ExecutionDetailView'
import { SignOffPanel } from '@/components/work-orders/SignOffPanel'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import {
  useInvalidateResources,
  workOrderExecutionQuery,
  workOrderInstructionQuery,
} from '@/lib/query'

export const Route = createFileRoute(
  '/work-orders/$id/executions/$executionId',
)({
  component: ExecutionDetailPage,
  // The traveler line is only addressable through the execution, so the
  // second fetch waits on the first rather than racing it.
  loader: async ({ context: { queryClient }, params }) => {
    const execution = await queryClient.ensureQueryData(
      workOrderExecutionQuery(params.id, params.executionId),
    )
    await queryClient.ensureQueryData(
      workOrderInstructionQuery(params.id, execution.workOrderInstructionId),
    )
  },
})

function ExecutionDetailPage() {
  const { id: workOrderId, executionId } = Route.useParams()
  const { data: execution } = useQuery(
    workOrderExecutionQuery(workOrderId, executionId),
  )

  if (!execution) return null

  return (
    <ExecutionDetailContent workOrderId={workOrderId} execution={execution} />
  )
}

function ExecutionDetailContent({
  workOrderId,
  execution,
}: {
  workOrderId: string
  execution: InstructionExecution
}) {
  const navigate = useNavigate()
  const invalidate = useInvalidateResources()
  const { data: instruction } = useQuery(
    workOrderInstructionQuery(workOrderId, execution.workOrderInstructionId),
  )

  const handleSignOff = async (
    decision: 'approved' | 'rejected',
    comments?: string,
  ) => {
    await apiFetch(
      `/api/v1/work-orders/${workOrderId}/executions/${execution.id}/sign-off`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, comments }),
      },
    )
    await invalidate('work-orders')
  }

  const handleResubmit = async () => {
    await apiFetch(
      `/api/v1/work-orders/${workOrderId}/executions/${execution.id}/resubmit`,
      { method: 'POST' },
    )
    await invalidate('work-orders')
  }

  if (!instruction) return null

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() =>
            navigate({
              to: '/work-orders/$id',
              params: { id: workOrderId },
              search: { tab: 'instructions' },
            })
          }
          className="shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-100 dark:bg-emerald-900 rounded-lg">
            <ClipboardCheck className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
              Execution Record
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {instruction.title}
              {execution.workOrder &&
                ` · ${execution.workOrder.workOrderNumber}`}
              {execution.unitLabel && ` · ${execution.unitLabel}`}
            </p>
          </div>
        </div>
      </div>

      {/* Sign-off panel (Pending Approval / Rejected) */}
      <SignOffPanel
        execution={execution}
        onSignOff={handleSignOff}
        onResubmit={handleResubmit}
        canResubmit
      />

      <Card>
        <CardHeader>
          <CardTitle>Captured Data</CardTitle>
          <CardDescription>
            Executed by{' '}
            {execution.executor?.name || execution.executor?.email || 'Unknown'}{' '}
            on {new Date(execution.startedAt).toLocaleDateString()} — against
            the snapshot frozen{' '}
            {new Date(instruction.snapshotAt).toLocaleDateString()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExecutionDetailView
            execution={execution}
            steps={instruction.snapshot.steps}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
