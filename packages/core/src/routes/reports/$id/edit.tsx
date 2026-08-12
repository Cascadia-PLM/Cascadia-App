// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { ReportCreateInput } from '@/lib/reports/types'
import { PageContainer } from '@/components/layout'
import { ReportBuilder } from '@/components/reports/ReportBuilder'
import { Button } from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { reportDetailQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/reports/$id/edit')({
  component: EditReportPage,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(reportDetailQuery(params.id)),
})

function EditReportPage() {
  const navigate = useNavigate()
  const { alert } = useAlertDialog()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: report } = useQuery(reportDetailQuery(id))
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!report) return null

  const handleSubmit = async (data: ReportCreateInput) => {
    setIsSubmitting(true)
    try {
      await apiFetch(`/api/v1/reports/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })

      await invalidate('reports')

      navigate({ to: '/reports/$id/view', params: { id } })
    } catch (error) {
      console.error('Error updating report:', error)
      alert({
        title: 'Error',
        description: `Failed to update report: ${(error as Error).message}`,
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate({ to: '/reports/$id/view', params: { id } })}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Edit Report
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            Modify your report configuration
          </p>
        </div>
      </div>

      {/* Report Builder */}
      <ReportBuilder
        initialData={report}
        onSubmit={handleSubmit}
        onCancel={() => navigate({ to: '/reports/$id/view', params: { id } })}
        isSubmitting={isSubmitting}
      />
    </PageContainer>
  )
}
