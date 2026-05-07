import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Pencil } from 'lucide-react'
import type { Report } from '@/lib/reports/types'
import { ReportViewer } from '@/components/reports/ReportViewer'
import { Button } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/reports/$id/view')({
  component: ViewReportPage,
  loader: async ({ params }) => {
    try {
      const result = await apiFetch<{ data: { report: Report } }>(
        `/api/v1/reports/${params.id}`,
      )
      return { report: result.data.report }
    } catch (error) {
      console.error('Error loading report:', error)
      throw error
    }
  },
})

function ViewReportPage() {
  const navigate = useNavigate()
  const { report } = Route.useLoaderData()

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate({ to: '/reports' })}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </div>
          <Link to="/reports/$id/edit" params={{ id: report.id! }}>
            <Button variant="outline">
              <Pencil className="h-4 w-4 mr-2" />
              Edit Report
            </Button>
          </Link>
        </div>

        {/* Report Viewer */}
        <ReportViewer report={report} />
      </div>
    </div>
  )
}
