// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { ArrowLeft, Calendar, Package, Wrench } from 'lucide-react'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { WorkOrderStatusBadge } from '@/components/work-orders/WorkOrderStatusBadge'
import { WorkOrderStatusActions } from '@/components/work-orders/WorkOrderStatusActions'
import { WorkOrderMaterialsSection } from '@/components/work-orders/WorkOrderMaterialsSection'
import { WorkOrderQualificationSection } from '@/components/work-orders/WorkOrderQualificationSection'
import { WorkOrderTravelerSection } from '@/components/work-orders/WorkOrderTravelerSection'
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
import { workOrderDetailQuery } from '@/lib/query'

const searchSchema = z.object({
  tab: z
    .enum(['details', 'instructions', 'materials', 'qualification', 'thread'])
    .optional(),
})

export const Route = createFileRoute('/work-orders/$id/')({
  component: WorkOrderDetailPage,
  validateSearch: searchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(workOrderDetailQuery(params.id)),
})

function WorkOrderDetailPage() {
  const navigate = useNavigate()
  const { id } = Route.useParams()
  const { tab } = Route.useSearch()
  const { data: workOrder } = useQuery(workOrderDetailQuery(id))

  if (!workOrder) return null

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
        />
      </div>

      <Tabs
        value={tab ?? 'details'}
        onValueChange={(value) =>
          navigate({
            to: '/work-orders/$id',
            params: { id: workOrder.id },
            search: { tab: value as NonNullable<typeof tab> },
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="instructions">Instructions</TabsTrigger>
          <TabsTrigger value="materials">Materials</TabsTrigger>
          <TabsTrigger value="qualification">Qualification</TabsTrigger>
          <TabsTrigger value="thread">Thread</TabsTrigger>
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

        <TabsContent value="instructions">
          <WorkOrderTravelerSection
            workOrderId={workOrder.id}
            readOnly={
              workOrder.status === 'Complete' ||
              workOrder.status === 'Cancelled'
            }
          />
        </TabsContent>

        <TabsContent value="materials">
          <WorkOrderMaterialsSection
            workOrderId={workOrder.id}
            readOnly={
              workOrder.status === 'Complete' ||
              workOrder.status === 'Cancelled'
            }
          />
        </TabsContent>

        <TabsContent value="qualification">
          <WorkOrderQualificationSection workOrderId={workOrder.id} />
        </TabsContent>

        <TabsContent value="thread">
          <DigitalThreadNavigator
            itemId={workOrder.id}
            itemNumber={workOrder.workOrderNumber}
            defaultExpanded
          />
        </TabsContent>
      </Tabs>
    </PageContainer>
  )
}
