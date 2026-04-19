import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { Report, ReportCreateInput } from '@/lib/reports/types'
import { PageContainer } from '@/components/layout'
import { ReportBuilder } from '@/components/reports/ReportBuilder'
import { Button } from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/reports/$id/edit')({
  component: EditReportPage,
  loader: async ({ params }) => {
    try {
      const result = await apiFetch<{ data: { report: Report } }>(
        `/api/reports/${params.id}`,
      )
      return { report: result.data.report }
    } catch (error) {
      console.error('Error loading report:', error)
      throw error
    }
  },
})

function EditReportPage() {
  const navigate = useNavigate()
  const { alert } = useAlertDialog()
  const { report } = Route.useLoaderData()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (data: ReportCreateInput) => {
    setIsSubmitting(true)
    try {
      const response = await fetch(`/api/reports/${report.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.details || 'Failed to update report')
      }

      navigate({ to: '/reports/$id/view', params: { id: report.id! } })
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
          onClick={() =>
            navigate({ to: '/reports/$id/view', params: { id: report.id! } })
          }
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
        onCancel={() =>
          navigate({ to: '/reports/$id/view', params: { id: report.id! } })
        }
        isSubmitting={isSubmitting}
      />
    </PageContainer>
  )
}
