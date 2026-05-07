import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { CreateProgramInput, Program } from '@/lib/types/program'
import { PageContainer } from '@/components/layout'
import { ProgramForm } from '@/components/programs/ProgramForm'
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

export const Route = createFileRoute('/programs/new')({
  component: NewProgramPage,
})

function NewProgramPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleCreateProgram = async (data: CreateProgramInput) => {
    setIsSubmitting(true)
    try {
      const result = await apiFetch<{ data: { program: Program } }>(
        '/api/v1/programs',
        {
          method: 'POST',
          body: JSON.stringify(data),
        },
      )

      showSuccess(
        'Program created',
        `${data.code} has been created successfully`,
      )

      // Navigate to the new program's detail page
      navigate({ to: '/programs/$id', params: { id: result.data.program.id } })
    } catch (error) {
      handleError(error, { title: 'Failed to create program' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/programs' })
  }

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/programs">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Create New Program
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            Enter the details for the new program
          </p>
        </div>
      </div>

      {/* Form Card */}
      <Card>
        <CardHeader>
          <CardTitle>Program Details</CardTitle>
          <CardDescription>
            All fields marked with * are required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProgramForm
            onSubmit={handleCreateProgram}
            onCancel={handleCancel}
            isSubmitting={isSubmitting}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
