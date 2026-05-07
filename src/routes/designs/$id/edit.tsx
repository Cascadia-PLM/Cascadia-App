import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
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

async function fetchDesign(
  id: string,
): Promise<{ design: Design; programs: Array<Program> }> {
  const [designResponse, programsResponse] = await Promise.all([
    fetch(`/api/v1/designs/${id}`, {
      headers: { 'Content-Type': 'application/json' },
    }),
    fetch('/api/v1/programs', {
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => null),
  ])

  if (!designResponse.ok) {
    throw new Error('Design not found')
  }

  const designResult = await designResponse.json()
  const programsResult = programsResponse?.ok
    ? await programsResponse.json()
    : { data: { programs: [] } }

  return {
    design: designResult.data.design as Design,
    programs: (programsResult.data?.programs || []) as Array<Program>,
  }
}

export const Route = createFileRoute('/designs/$id/edit')({
  component: EditDesignPage,
  loader: async ({ params }) => {
    return fetchDesign(params.id)
  },
})

function EditDesignPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const { design, programs } = Route.useLoaderData()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleUpdateDesign = async (data: CreateDesignInput) => {
    setIsSubmitting(true)
    try {
      await apiFetch(`/api/v1/designs/${design.id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })

      showSuccess(
        'Design updated',
        `${data.code} has been updated successfully`,
      )

      // Navigate back to the design detail page
      navigate({ to: '/designs/$id', params: { id: design.id } })
    } catch (error) {
      handleError(error, { title: 'Failed to update design' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/designs/$id', params: { id: design.id } })
  }

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/designs/$id" params={{ id: design.id }}>
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Edit Design
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            Update details for {design.code}
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
            design={design}
            programs={programs}
            onSubmit={handleUpdateDesign}
            onCancel={handleCancel}
            isSubmitting={isSubmitting}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
