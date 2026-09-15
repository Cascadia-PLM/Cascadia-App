// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
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
import { useInvalidateResources, workOrderListQuery } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/work-orders/')({
  component: WorkOrdersListPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(workOrderListQuery()),
})

function WorkOrdersListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data } = useQuery(workOrderListQuery())
  const workOrders = data?.workOrders ?? []

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
          await apiFetch(`/api/v1/work-orders/${workOrder.id}`, {
            method: 'DELETE',
          })

          showSuccess(
            'Work Order deleted',
            `${workOrder.workOrderNumber} has been deleted`,
          )
          await invalidate('work-orders')
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
