import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { BarChart3, Plus } from 'lucide-react'
import type { Report } from '@/lib/reports/types'
import { PageContainer } from '@/components/layout'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import { ReportTable } from '@/components/reports/ReportTable'

export const Route = createFileRoute('/reports/')({
  component: ReportsListPage,
  loader: async () => {
    try {
      const result = await apiFetch<{
        data: { reports: Array<Report>; total: number }
      }>('/api/reports')
      return { reports: result.data.reports }
    } catch (error) {
      console.error('Error loading reports:', error)
      return { reports: [] as Array<Report> }
    }
  },
})

function ReportsListPage() {
  const router = useRouter()
  const { confirm, alert } = useAlertDialog()
  const { reports: initialReports } = Route.useLoaderData()
  const [reports, setReports] = useState<Array<Report>>(initialReports)

  useEffect(() => {
    setReports(initialReports)
  }, [initialReports])

  const handleDeleteReport = (report: Report) => {
    if (!report.id) return

    confirm({
      title: 'Delete Report',
      description: `Are you sure you want to delete "${report.name}"? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          const response = await fetch(`/api/reports/${report.id}`, {
            method: 'DELETE',
          })

          if (!response.ok) {
            throw new Error('Failed to delete report')
          }

          setReports(reports.filter((r) => r.id !== report.id))
          router.invalidate()
        } catch (error) {
          console.error('Error deleting report:', error)
          alert({
            title: 'Error',
            description: 'Failed to delete report',
            variant: 'destructive',
          })
        }
      },
    })
  }

  // Group reports by item type
  const reportsByType = reports.reduce<Record<string, Array<Report>>>(
    (acc, report) => {
      const type = report.itemType
      if (!(type in acc)) {
        acc[type] = []
      }
      acc[type].push(report)
      return acc
    },
    {},
  )

  const itemTypeLabels: Record<string, string> = {
    Part: 'Parts',
    Document: 'Documents',
    ChangeOrder: 'Change Orders',
    Project: 'Projects',
    Requirement: 'Requirements',
    Task: 'Tasks',
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Reports
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Create and manage custom reports
          </p>
        </div>
        <Link to="/reports/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Report
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Reports</CardDescription>
            <CardTitle className="text-3xl">{reports.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Public Reports</CardDescription>
            <CardTitle className="text-3xl">
              {reports.filter((r) => r.isPublic).length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Private Reports</CardDescription>
            <CardTitle className="text-3xl">
              {reports.filter((r) => !r.isPublic).length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Item Types</CardDescription>
            <CardTitle className="text-3xl">
              {Object.keys(reportsByType).length}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Reports by Item Type */}
      {reports.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center">
              <BarChart3 className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-4 text-lg font-medium text-gray-900 dark:text-white">
                No reports yet
              </h3>
              <p className="mt-2 text-sm text-gray-500">
                Get started by creating your first report.
              </p>
              <div className="mt-6">
                <Link to="/reports/new">
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Report
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        Object.entries(reportsByType).map(([itemType, typeReports]) => (
          <Card key={itemType}>
            <CardHeader>
              <CardTitle>
                {itemTypeLabels[itemType] || itemType} Reports
              </CardTitle>
              <CardDescription>
                {typeReports.length}{' '}
                {typeReports.length === 1 ? 'report' : 'reports'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ReportTable
                reports={typeReports}
                onDelete={handleDeleteReport}
              />
            </CardContent>
          </Card>
        ))
      )}
    </PageContainer>
  )
}
