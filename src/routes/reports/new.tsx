import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { ReportCreateInput } from '@/lib/reports/types'
import { PageContainer } from '@/components/layout'
import { ReportBuilder } from '@/components/reports/ReportBuilder'
import { Button } from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

export const Route = createFileRoute('/reports/new')({
  component: NewReportPage,
})

function NewReportPage() {
  const navigate = useNavigate()
  const { alert } = useAlertDialog()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (data: ReportCreateInput) => {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.details || 'Failed to create report')
      }

      const { report } = await response.json()
      navigate({ to: '/reports/$id/view', params: { id: report.id } })
    } catch (error) {
      console.error('Error creating report:', error)
      alert({
        title: 'Error',
        description: `Failed to create report: ${(error as Error).message}`,
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
          onClick={() => navigate({ to: '/reports' })}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Create New Report
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            Configure your report settings, columns, filters, and sorting
          </p>
        </div>
      </div>

      {/* Report Builder */}
      <ReportBuilder
        onSubmit={handleSubmit}
        onCancel={() => navigate({ to: '/reports' })}
        isSubmitting={isSubmitting}
      />
    </PageContainer>
  )
}
