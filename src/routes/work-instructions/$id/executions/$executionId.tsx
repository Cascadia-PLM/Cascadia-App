import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft, ClipboardCheck } from 'lucide-react'
import type {
  WorkInstructionExecution,
  WorkInstructionWithSteps,
} from '@/lib/items/types/work-instruction'
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

export const Route = createFileRoute(
  '/work-instructions/$id/executions/$executionId',
)({
  component: ExecutionDetailPage,
  loader: async ({ params }) => {
    const [wiResult, opsResult, execResult] = await Promise.all([
      apiFetch<{ data: { workInstruction: WorkInstructionWithSteps } }>(
        `/api/work-instructions/${params.id}`,
      ),
      apiFetch<{ data: { operations: Array<any> } }>(
        `/api/work-instructions/${params.id}/operations`,
      ),
      apiFetch<{ data: { execution: WorkInstructionExecution } }>(
        `/api/work-instructions/${params.id}/executions/${params.executionId}`,
      ),
    ])

    return {
      workInstruction: {
        ...wiResult.data.workInstruction,
        operations: opsResult.data.operations,
      },
      execution: execResult.data.execution,
    }
  },
})

function ExecutionDetailPage() {
  const navigate = useNavigate()
  const router = useRouter()
  const loaderData = Route.useLoaderData()
  const workInstruction = loaderData.workInstruction as WorkInstructionWithSteps
  const [execution, setExecution] = useState<WorkInstructionExecution>(
    loaderData.execution as WorkInstructionExecution,
  )

  const handleSignOff = async (
    decision: 'approved' | 'rejected',
    comments?: string,
  ) => {
    const response = await fetch(
      `/api/work-instructions/${workInstruction.id}/executions/${execution.id}/sign-off`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, comments }),
      },
    )

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to submit sign-off')
    }

    const data = await response.json()
    setExecution((prev) => ({
      ...prev,
      status: data.data.execution.status,
    }))
    router.invalidate()
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() =>
            navigate({
              to: '/work-instructions/$id',
              params: { id: workInstruction.id ?? '' },
              search: {
                tab: 'executions' as
                  | 'details'
                  | 'steps'
                  | 'parts'
                  | 'alerts'
                  | 'executions',
              },
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
              {workInstruction.itemNumber} - {workInstruction.name}
            </p>
          </div>
        </div>
      </div>

      {/* Sign-off panel (only for Pending Approval) */}
      <SignOffPanel execution={execution} onSignOff={handleSignOff} />

      <Card>
        <CardHeader>
          <CardTitle>Captured Data</CardTitle>
          <CardDescription>
            Executed by{' '}
            {execution.executor?.name || execution.executor?.email || 'Unknown'}{' '}
            on {new Date(execution.startedAt).toLocaleDateString()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExecutionDetailView
            execution={execution}
            steps={workInstruction.steps}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
