import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import type { CreateDesignInput, Design } from '@/lib/types/design'
import type { Program } from '@/lib/types/program'
import { PageContainer } from '@/components/layout'
import { DesignForm } from '@/components/designs/DesignForm'
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

// Search schema to accept default programId
const newDesignSearchSchema = z.object({
  programId: z.string().uuid().optional(),
})

async function fetchPrograms(): Promise<Array<Program>> {
  try {
    const response = await fetch('/api/programs', {
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok) return []
    const result = await response.json()
    return (result.data?.programs || []) as Array<Program>
  } catch {
    return []
  }
}

export const Route = createFileRoute('/designs/new')({
  validateSearch: newDesignSearchSchema,
  component: NewDesignPage,
  loader: async () => {
    const programs = await fetchPrograms()
    return { programs }
  },
})

function NewDesignPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const { programs } = Route.useLoaderData()
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleCreateDesign = async (data: CreateDesignInput) => {
    setIsSubmitting(true)
    try {
      const result = await apiFetch<{ data: { design: Design } }>(
        '/api/designs',
        {
          method: 'POST',
          body: JSON.stringify(data),
        },
      )

      showSuccess(
        'Design created',
        `${data.code} has been created successfully`,
      )

      // Navigate to the new design's detail page
      navigate({ to: '/designs/$id', params: { id: result.data.design.id } })
    } catch (error) {
      handleError(error, { title: 'Failed to create design' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/designs' })
  }

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/designs">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Create New Design
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            Enter the details for the new design
          </p>
        </div>
      </div>

      {/* Form Card */}
      <Card>
        <CardHeader>
          <CardTitle>Design Details</CardTitle>
          <CardDescription>
            All fields marked with * are required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DesignForm
            programs={programs}
            defaultProgramId={searchParams.programId}
            onSubmit={handleCreateDesign}
            onCancel={handleCancel}
            isSubmitting={isSubmitting}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
