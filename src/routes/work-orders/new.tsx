import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft, Wrench } from 'lucide-react'
import type { WorkOrderCreateInput } from '@/lib/items/types/work-order'
import { PageContainer } from '@/components/layout'
import { WorkOrderForm } from '@/components/work-orders/WorkOrderForm'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

export const Route = createFileRoute('/work-orders/new')({
  component: NewWorkOrderPage,
})

function NewWorkOrderPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (data: WorkOrderCreateInput) => {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/v1/work-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create work order')
      }

      const result = await response.json()
      const workOrder = result.data?.workOrder

      showSuccess(
        'Work Order created',
        `${workOrder.workOrderNumber} has been created successfully`,
      )
      navigate({
        to: '/work-orders/$id',
        params: { id: workOrder.id },
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create work order' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/work-orders' })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleCancel}
          className="shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-orange-100 dark:bg-orange-900 rounded-lg">
            <Wrench className="h-6 w-6 text-orange-600 dark:text-orange-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
              New Work Order
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Create a manufacturing work order
            </p>
          </div>
        </div>
      </div>

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle>Work Order Details</CardTitle>
          <CardDescription>
            Enter the details for this work order.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkOrderForm
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            isSubmitting={isSubmitting}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
