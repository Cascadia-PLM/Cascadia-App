import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft, ClipboardCheck } from 'lucide-react'
import type { WorkInstruction } from '@/lib/items/types/work-instruction'
import { PageContainer } from '@/components/layout'
import { WorkInstructionForm } from '@/components/work-instructions/WorkInstructionForm'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/work-instructions/new')({
  component: NewWorkInstructionPage,
})

function NewWorkInstructionPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (data: WorkInstruction) => {
    setIsSubmitting(true)
    try {
      const payload = { ...data, itemType: 'WorkInstruction' }
      const result = await apiFetch<{ data: { item: WorkInstruction } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      showSuccess(
        'Work Instruction created',
        `${result.data.item.itemNumber} has been created successfully`,
      )
      navigate({
        to: '/work-instructions/$id',
        params: { id: result.data.item.id! },
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create work instruction' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/work-instructions' })
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
          <div className="p-2 bg-sky-100 dark:bg-sky-900 rounded-lg">
            <ClipboardCheck className="h-6 w-6 text-sky-600 dark:text-sky-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
              New Work Instruction
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Create a new step-by-step manufacturing procedure
            </p>
          </div>
        </div>
      </div>

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle>Work Instruction Details</CardTitle>
          <CardDescription>
            Enter the basic information for this work instruction. You can add
            steps after creating it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkInstructionForm
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            isSubmitting={isSubmitting}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
