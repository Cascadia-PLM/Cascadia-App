import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ArrowLeft, Calendar, Package, Wrench } from 'lucide-react'
import type { WorkOrder, WorkOrderStatus } from '@/lib/items/types/work-order'
import type { WorkInstructionExecution } from '@/lib/items/types/work-instruction'
import { PageContainer } from '@/components/layout'
import { WorkOrderStatusBadge } from '@/components/work-orders/WorkOrderStatusBadge'
import { WorkOrderStatusActions } from '@/components/work-orders/WorkOrderStatusActions'
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

export const Route = createFileRoute('/work-orders/$id')({
  component: WorkOrderDetailPage,
  loader: async ({ params }) => {
    const response = await fetch(`/api/work-orders/${params.id}`)
    if (!response.ok) throw new Error('Work Order not found')
    const data = await response.json()
    return { workOrder: data.data.workOrder as WorkOrder }
  },
})

function WorkOrderDetailPage() {
  const navigate = useNavigate()
  const router = useRouter()
  const { workOrder: initialWorkOrder } = Route.useLoaderData()
  const [workOrder, setWorkOrder] = useState<WorkOrder>(initialWorkOrder)

  useEffect(() => {
    setWorkOrder(initialWorkOrder)
  }, [initialWorkOrder])

  const handleStatusChange = (newStatus: WorkOrderStatus) => {
    setWorkOrder((prev) => ({
      ...prev,
      status: newStatus,
      completedAt:
        newStatus === 'Complete' ? new Date().toISOString() : prev.completedAt,
    }))
    router.invalidate()
  }

  const priorityColors: Record<string, string> = {
    Low: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
    Normal: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300',
    High: 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300',
    Urgent: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-300',
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate({ to: '/work-orders' })}
            className="shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-orange-100 dark:bg-orange-900 rounded-lg">
              <Wrench className="h-6 w-6 text-orange-600 dark:text-orange-400" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                  {workOrder.workOrderNumber}
                </h1>
                <WorkOrderStatusBadge status={workOrder.status} />
                <Badge
                  variant="secondary"
                  className={priorityColors[workOrder.priority] || ''}
                >
                  {workOrder.priority}
                </Badge>
                {workOrder.requiresSignOff && (
                  <Badge
                    variant="secondary"
                    className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                  >
                    Sign-off Required
                  </Badge>
                )}
              </div>
              {workOrder.part && (
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  Part: {workOrder.part.itemNumber}{' '}
                  {workOrder.part.name && `- ${workOrder.part.name}`}
                </p>
              )}
            </div>
          </div>
        </div>
        <WorkOrderStatusActions
          workOrderId={workOrder.id}
          status={workOrder.status}
          onStatusChange={handleStatusChange}
        />
      </div>

      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="executions">Executions</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Quantity</CardDescription>
                <CardTitle className="text-2xl">
                  {workOrder.quantityCompleted} / {workOrder.quantity}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Due Date</CardDescription>
                <CardTitle className="text-2xl flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-slate-400" />
                  {workOrder.dueDate
                    ? new Date(workOrder.dueDate).toLocaleDateString()
                    : 'Not set'}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Customer Order</CardDescription>
                <CardTitle className="text-2xl">
                  {workOrder.customerOrder || '—'}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Part</CardDescription>
                <CardTitle className="text-2xl flex items-center gap-2">
                  <Package className="h-5 w-5 text-slate-400" />
                  {workOrder.part?.itemNumber || '—'}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          {/* Notes */}
          {workOrder.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                  {workOrder.notes}
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="executions">
          <WOExecutionsTab workOrderId={workOrder.id} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  )
}

function WOExecutionsTab({ workOrderId }: { workOrderId: string }) {
  const [executions, setExecutions] = useState<Array<WorkInstructionExecution>>(
    [],
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/work-orders/${workOrderId}/executions`)
      .then((r) => r.json())
      .then((data) => {
        setExecutions(data.data?.executions || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [workOrderId])

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
          {executions.length === 1 ? 'execution' : 'executions'} for this work
          order
        </CardDescription>
      </CardHeader>
      <CardContent>
        {executions.length > 0 ? (
          <ExecutionHistoryTable executions={executions} showWorkInstruction />
        ) : (
          <p className="text-slate-500 text-center py-8">
            No executions yet. Execute a work instruction to see records here.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
