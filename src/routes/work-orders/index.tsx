import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Plus, Wrench } from 'lucide-react'
import type { WorkOrder } from '@/lib/items/types/work-order'
import { PageContainer } from '@/components/layout'
import { WorkOrderTable } from '@/components/work-orders/WorkOrderTable'
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

export const Route = createFileRoute('/work-orders/')({
  component: WorkOrdersListPage,
  loader: async () => {
    try {
      const response = await fetch('/api/v1/work-orders')
      if (!response.ok) return { workOrders: [], total: 0 }
      const data = await response.json()
      return {
        workOrders: (data.data?.workOrders || []) as Array<WorkOrder>,
        total: data.data?.total || 0,
      }
    } catch {
      return { workOrders: [] as Array<WorkOrder>, total: 0 }
    }
  },
})

function WorkOrdersListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { workOrders: initialWorkOrders } = Route.useLoaderData()
  const [workOrders, setWorkOrders] =
    useState<Array<WorkOrder>>(initialWorkOrders)

  useEffect(() => {
    setWorkOrders(initialWorkOrders)
  }, [initialWorkOrders])

  const statusCounts = {
    notStarted: workOrders.filter((wo) => wo.status === 'Not Started').length,
    inProgress: workOrders.filter((wo) => wo.status === 'In Progress').length,
    complete: workOrders.filter((wo) => wo.status === 'Complete').length,
  }

  const handleView = (workOrder: WorkOrder) => {
    navigate({ to: '/work-orders/$id', params: { id: workOrder.id } })
  }

  const handleEdit = (workOrder: WorkOrder) => {
    navigate({ to: '/work-orders/$id', params: { id: workOrder.id } })
  }

  const handleDelete = (workOrder: WorkOrder) => {
    confirm({
      title: 'Delete Work Order',
      description: `Are you sure you want to delete ${workOrder.workOrderNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          const response = await fetch(`/api/v1/work-orders/${workOrder.id}`, {
            method: 'DELETE',
          })
          if (!response.ok) throw new Error('Failed to delete')

          setWorkOrders(workOrders.filter((wo) => wo.id !== workOrder.id))
          showSuccess(
            'Work Order deleted',
            `${workOrder.workOrderNumber} has been deleted`,
          )
        } catch (error) {
          handleError(error, { title: 'Failed to delete work order' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-orange-100 dark:bg-orange-900 rounded-lg">
            <Wrench className="h-6 w-6 text-orange-600 dark:text-orange-400" />
          </div>
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              Work Orders
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              Manufacturing execution and tracking
            </p>
          </div>
        </div>
        <Link to="/work-orders/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Work Order
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total</CardDescription>
            <CardTitle className="text-3xl">{workOrders.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Not Started</CardDescription>
            <CardTitle className="text-3xl">
              {statusCounts.notStarted}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Progress</CardDescription>
            <CardTitle className="text-3xl">
              {statusCounts.inProgress}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Complete</CardDescription>
            <CardTitle className="text-3xl">{statusCounts.complete}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Work Orders</CardTitle>
          <CardDescription>
            {workOrders.length}{' '}
            {workOrders.length === 1 ? 'work order' : 'work orders'} in the
            system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkOrderTable
            items={workOrders}
            onView={handleView}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
