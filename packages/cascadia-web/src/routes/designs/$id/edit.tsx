// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { CreateDesignInput } from '@/lib/types/design'
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
import {
  designDetailQuery,
  programListQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/designs/$id/edit')({
  component: EditDesignPage,
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(designDetailQuery(params.id)),
      queryClient.ensureQueryData(programListQuery()),
    ])
  },
})

function EditDesignPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: design } = useQuery(designDetailQuery(id))
  const { data: programs = [] } = useQuery(programListQuery())
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleUpdateDesign = async (data: CreateDesignInput) => {
    setIsSubmitting(true)
    try {
      await apiFetch(`/api/v1/designs/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })

      showSuccess(
        'Design updated',
        `${data.code} has been updated successfully`,
      )

      await invalidate('designs')

      // Navigate back to the design detail page
      navigate({ to: '/designs/$id', params: { id } })
    } catch (error) {
      handleError(error, { title: 'Failed to update design' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/designs/$id', params: { id } })
  }

  if (!design) return null

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/designs/$id" params={{ id }}>
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
