// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Pencil } from 'lucide-react'
import { ReportViewer } from '@/components/reports/ReportViewer'
import { Button } from '@/components/ui'
import { reportDetailQuery } from '@/lib/query'

export const Route = createFileRoute('/reports/$id/view')({
  component: ViewReportPage,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(reportDetailQuery(params.id)),
})

function ViewReportPage() {
  const navigate = useNavigate()
  const { id } = Route.useParams()
  const { data: report } = useQuery(reportDetailQuery(id))

  if (!report) return null

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
          <Link to="/reports/$id/edit" params={{ id }}>
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
