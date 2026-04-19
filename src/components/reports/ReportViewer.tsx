import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpDown,
  Clock,
  Columns3,
  Download,
  Filter,
  RefreshCw,
  Rows3,
} from 'lucide-react'
import type {
  Report,
  ReportColumn,
  ReportExecutionResult,
} from '@/lib/reports/types'
import {
  Badge,
  Button,
  Card,
  LoadingSpinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'

interface ReportViewerProps {
  report: Report
}

export function ReportViewer({ report }: ReportViewerProps) {
  const [result, setResult] = useState<ReportExecutionResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const executeReport = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/reports/${report.id}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 100, offset: 0 }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(
          errorData.details || errorData.error || 'Failed to execute report',
        )
      }

      const data = await response.json()
      setResult(data.result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
  }, [report.id])

  useEffect(() => {
    executeReport()
  }, [executeReport])

  const handleExport = async () => {
    try {
      const response = await fetch(`/api/reports/${report.id}/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 1000 }),
      })

      if (!response.ok) {
        throw new Error('Failed to export report')
      }

      // Get the filename from the Content-Disposition header
      const contentDisposition = response.headers.get('Content-Disposition')
      let filename = `report-${report.id}.csv`
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/)
        if (match) {
          filename = match[1]
        }
      }

      // Download the file
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch {
      setError('Failed to export report')
    }
  }

  const formatValue = (value: unknown, column: ReportColumn): string => {
    if (value === null || value === undefined) {
      return '-'
    }

    const formatType = column.formatType

    switch (formatType) {
      case 'date':
        if (typeof value === 'string' || value instanceof Date) {
          return new Date(value).toLocaleDateString()
        }
        return String(value)

      case 'datetime':
        if (typeof value === 'string' || value instanceof Date) {
          return new Date(value).toLocaleString()
        }
        return String(value)

      case 'currency':
        if (typeof value === 'number' || !isNaN(Number(value))) {
          return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
          }).format(Number(value))
        }
        return String(value)

      case 'number':
        if (typeof value === 'number' || !isNaN(Number(value))) {
          return new Intl.NumberFormat().format(Number(value))
        }
        return String(value)

      case 'percentage':
        if (typeof value === 'number' || !isNaN(Number(value))) {
          return `${(Number(value) * 100).toFixed(1)}%`
        }
        return String(value)

      case 'boolean': {
        const boolValue = value as boolean
        return boolValue ? 'Yes' : 'No'
      }

      case 'email':
        return String(value)

      case 'url':
        return String(value)

      default:
        return String(value)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">{report.name}</h2>
          {report.description && (
            <p className="text-gray-500 mt-1">{report.description}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={executeReport}
            disabled={isLoading}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={isLoading || !result}
          >
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {result && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <Rows3 className="w-5 h-5 text-cyan-500" />
              <div>
                <p className="text-sm text-gray-500">Total Rows</p>
                <p className="text-xl font-semibold">{result.totalRows}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <Columns3 className="w-5 h-5 text-cyan-500" />
              <div>
                <p className="text-sm text-gray-500">Columns</p>
                <p className="text-xl font-semibold">{result.columns.length}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <Clock className="w-5 h-5 text-cyan-500" />
              <div>
                <p className="text-sm text-gray-500">Execution Time</p>
                <p className="text-xl font-semibold">{result.durationMs}ms</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <Filter className="w-5 h-5 text-cyan-500" />
              <div>
                <p className="text-sm text-gray-500">Active Filters</p>
                <p className="text-xl font-semibold">
                  {report.filters?.length || 0}
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <Card className="p-12">
          <div className="flex flex-col items-center justify-center">
            <LoadingSpinner size="lg" />
            <p className="mt-4 text-gray-500">Executing report...</p>
          </div>
        </Card>
      )}

      {/* Error State */}
      {error && !isLoading && (
        <Card className="p-6 border-red-200 bg-red-50 dark:bg-red-900/20">
          <p className="text-red-600 dark:text-red-400">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={executeReport}
            className="mt-4"
          >
            Try Again
          </Button>
        </Card>
      )}

      {/* Results Table */}
      {result && !isLoading && !error && (
        <Card className="overflow-hidden">
          {result.rows.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-gray-500">
                No data found matching the report criteria.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {result.columns
                      .filter((col) => col.isVisible !== false)
                      .map((column) => (
                        <TableHead key={column.fieldPath}>
                          {column.label}
                        </TableHead>
                      ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, rowIndex) => (
                    <TableRow key={rowIndex}>
                      {result.columns
                        .filter((col) => col.isVisible !== false)
                        .map((column) => (
                          <TableCell key={column.fieldPath}>
                            {formatValue(row[column.fieldPath], column)}
                          </TableCell>
                        ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination info */}
          {result.pagination && (
            <div className="px-4 py-3 border-t bg-gray-50 dark:bg-gray-800 text-sm text-gray-500">
              Showing {result.rows.length} of {result.totalRows} results
              {result.pagination.hasMore && ' (more results available)'}
            </div>
          )}
        </Card>
      )}

      {/* Report Details */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Report Details</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-gray-500">Item Type</p>
            <Badge variant="secondary" className="mt-1">
              {report.itemType}
            </Badge>
          </div>
          <div>
            <p className="text-sm text-gray-500">Visibility</p>
            <Badge
              variant={report.isPublic ? 'default' : 'outline'}
              className="mt-1"
            >
              {report.isPublic ? 'Public' : 'Private'}
            </Badge>
          </div>
          <div>
            <p className="text-sm text-gray-500">Filters</p>
            <p className="font-medium">
              {report.filters?.length || 0} configured
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Sort Order</p>
            <p className="font-medium">
              {report.sorts?.length || 0} configured
            </p>
          </div>
        </div>

        {/* Filter Summary */}
        {report.filters && report.filters.length > 0 && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-sm text-gray-500 mb-2">Active Filters:</p>
            <div className="flex flex-wrap gap-2">
              {report.filters.map((filter, index) => (
                <Badge key={index} variant="outline">
                  {filter.fieldPath} {filter.operator}{' '}
                  {filter.value || '(empty)'}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Sort Summary */}
        {report.sorts && report.sorts.length > 0 && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-sm text-gray-500 mb-2">Sort Order:</p>
            <div className="flex flex-wrap gap-2">
              {report.sorts.map((sort, index) => (
                <Badge key={index} variant="outline">
                  <ArrowUpDown className="w-3 h-3 mr-1" />
                  {sort.fieldPath} ({sort.direction})
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
