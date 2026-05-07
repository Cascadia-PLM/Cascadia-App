import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Eye,
  MoreVertical,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import type { DataGridColumn, Row } from '@/components/ui'
import type { JobPriority, JobStatus } from '@/lib/db/schema/jobs'
import { Badge, Button, DataGrid } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'

export const Route = createFileRoute('/admin/jobs')({
  component: JobsPage,
})

interface Job {
  id: string
  type: string
  status: JobStatus
  priority: JobPriority
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  progress: number
  progressMessage: string | null
  itemId: string | null
  createdBy: string
  createdAt: string
  queuedAt: string | null
  startedAt: string | null
  completedAt: string | null
  attempts: number
  maxAttempts: number
  nextRetryAt: string | null
}

interface JobLog {
  id: string
  jobId: string
  level: string
  message: string
  data: Record<string, unknown> | null
  createdAt: string
}

const statusVariants: Record<
  JobStatus,
  'default' | 'secondary' | 'success' | 'destructive' | 'warning' | 'outline'
> = {
  pending: 'secondary',
  queued: 'outline',
  running: 'warning',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
}

const priorityVariants: Record<
  JobPriority,
  'default' | 'secondary' | 'success' | 'destructive' | 'warning' | 'outline'
> = {
  low: 'secondary',
  normal: 'outline',
  high: 'warning',
  critical: 'destructive',
}

const logLevelColors: Record<string, string> = {
  debug: 'text-slate-400',
  info: 'text-blue-500',
  warn: 'text-amber-500',
  error: 'text-red-500',
}

function JobsPage() {
  const [jobs, setJobs] = useState<Array<Job>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [jobLogs, setJobLogs] = useState<Array<JobLog>>([])
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  const fetchJobs = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/v1/admin/jobs?limit=500')
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || 'Failed to fetch jobs')
      }
      const data = await response.json()
      setJobs(data.data.jobs)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  const fetchJobDetails = async (jobId: string) => {
    setLoadingLogs(true)
    try {
      const response = await fetch(`/api/v1/admin/jobs/${jobId}`)
      if (!response.ok) {
        throw new Error('Failed to fetch job details')
      }
      const data = await response.json()
      setJobLogs(data.data.logs || [])
    } catch (err) {
      console.error('Failed to fetch job details:', err)
      setJobLogs([])
    } finally {
      setLoadingLogs(false)
    }
  }

  const handleViewDetails = (job: Job) => {
    setSelectedJob(job)
    fetchJobDetails(job.id)
  }

  const handleRetry = async (job: Job) => {
    setActionLoading(job.id)
    try {
      const response = await fetch(`/api/v1/admin/jobs/${job.id}/retry`, {
        method: 'POST',
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || 'Failed to retry job')
      }
      await fetchJobs(false)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to retry job')
    } finally {
      setActionLoading(null)
    }
  }

  const handleCancel = async (job: Job) => {
    if (!confirm('Are you sure you want to cancel this job?')) return

    setActionLoading(job.id)
    try {
      const response = await fetch(`/api/v1/admin/jobs/${job.id}/cancel`, {
        method: 'POST',
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || 'Failed to cancel job')
      }
      await fetchJobs(false)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to cancel job')
    } finally {
      setActionLoading(null)
    }
  }

  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  // Auto-refresh effect
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        fetchJobs(false)
      }, 5000) // Refresh every 5 seconds
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [autoRefresh, fetchJobs])

  const columns: Array<DataGridColumn<Job>> = [
    {
      id: 'type',
      header: 'Type',
      accessorKey: 'type',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter by type...',
      cell: ({ getValue }) => (
        <span className="font-mono text-sm text-slate-700 dark:text-slate-200">
          {getValue() as string}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Pending', value: 'pending' },
        { label: 'Queued', value: 'queued' },
        { label: 'Running', value: 'running' },
        { label: 'Completed', value: 'completed' },
        { label: 'Failed', value: 'failed' },
        { label: 'Cancelled', value: 'cancelled' },
      ],
      cell: ({ getValue }) => {
        const status = getValue() as JobStatus
        return <Badge variant={statusVariants[status]}>{status}</Badge>
      },
    },
    {
      id: 'priority',
      header: 'Priority',
      accessorKey: 'priority',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Low', value: 'low' },
        { label: 'Normal', value: 'normal' },
        { label: 'High', value: 'high' },
        { label: 'Critical', value: 'critical' },
      ],
      cell: ({ getValue }) => {
        const priority = getValue() as JobPriority
        return <Badge variant={priorityVariants[priority]}>{priority}</Badge>
      },
    },
    {
      id: 'progress',
      header: 'Progress',
      accessorKey: 'progress',
      cell: ({ row }) => {
        const progress = row.original.progress
        const message = row.original.progressMessage
        const status = row.original.status

        if (status === 'completed') {
          return (
            <span className="text-green-600 dark:text-green-400">100%</span>
          )
        }
        if (status === 'failed' || status === 'cancelled') {
          return <span className="text-slate-400">-</span>
        }

        return (
          <div className="flex items-center gap-2">
            <div className="w-20 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-slate-500">{progress}%</span>
            {message && (
              <span
                className="text-xs text-slate-400 truncate max-w-[100px]"
                title={message}
              >
                {message}
              </span>
            )}
          </div>
        )
      },
    },
    {
      id: 'attempts',
      header: 'Attempts',
      accessorFn: (row) => `${row.attempts}/${row.maxAttempts}`,
      cell: ({ row }) => (
        <span className="text-sm text-slate-600 dark:text-slate-400">
          {row.original.attempts}/{row.original.maxAttempts}
        </span>
      ),
    },
    {
      id: 'createdAt',
      header: 'Created',
      accessorKey: 'createdAt',
      enableSorting: true,
      cell: ({ getValue }) => {
        const date = getValue() as string
        return (
          <span className="text-sm text-slate-600 dark:text-slate-400">
            {new Date(date).toLocaleString()}
          </span>
        )
      },
    },
    {
      id: 'error',
      header: 'Error',
      accessorKey: 'error',
      cell: ({ getValue }) => {
        const errorValue = getValue() as string | null
        if (!errorValue) return <span className="text-slate-400">-</span>
        return (
          <span
            className="text-xs text-red-600 dark:text-red-400 truncate max-w-[200px] block"
            title={errorValue}
          >
            {errorValue}
          </span>
        )
      },
    },
  ]

  const renderRowActions = useCallback(
    (row: Row<Job>) => {
      const job = row.original
      const canRetry = job.status === 'failed'
      const canCancel = job.status === 'pending' || job.status === 'queued'
      const isLoading = actionLoading === job.id

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              disabled={isLoading}
            >
              {isLoading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <MoreVertical className="h-4 w-4" />
              )}
              <span className="sr-only">Open menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleViewDetails(job)}>
              <Eye className="mr-2 h-4 w-4" />
              View Details
            </DropdownMenuItem>
            {canRetry && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleRetry(job)}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Retry Job
                </DropdownMenuItem>
              </>
            )}
            {canCancel && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => handleCancel(job)}
                  className="text-red-600 focus:text-red-600"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  Cancel Job
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    },
    [actionLoading],
  )

  // Calculate stats
  const stats = {
    total: jobs.length,
    pending: jobs.filter((j) => j.status === 'pending').length,
    queued: jobs.filter((j) => j.status === 'queued').length,
    running: jobs.filter((j) => j.status === 'running').length,
    completed: jobs.filter((j) => j.status === 'completed').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Activity size={32} className="text-cyan-600" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Background Jobs
          </h1>
        </div>
        <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Activity size={32} className="text-cyan-600" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Background Jobs
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setAutoRefresh(!autoRefresh)}
            variant={autoRefresh ? 'default' : 'outline'}
            size="sm"
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${autoRefresh ? 'animate-spin' : ''}`}
            />
            {autoRefresh ? 'Auto-refresh On' : 'Auto-refresh Off'}
          </Button>
          <Button
            onClick={() => fetchJobs()}
            disabled={loading}
            variant="outline"
            size="sm"
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-4 border border-slate-300 dark:border-slate-700">
          <div className="text-2xl font-bold text-slate-700 dark:text-slate-100">
            {stats.total}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Total Jobs
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-4 border border-slate-300 dark:border-slate-700">
          <div className="text-2xl font-bold text-slate-500 dark:text-slate-400">
            {stats.pending}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Pending
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-4 border border-slate-300 dark:border-slate-700">
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {stats.queued}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Queued
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-4 border border-slate-300 dark:border-slate-700">
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
            {stats.running}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Running
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-4 border border-slate-300 dark:border-slate-700">
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
            {stats.completed}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Completed
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-4 border border-slate-300 dark:border-slate-700">
          <div className="text-2xl font-bold text-red-600 dark:text-red-400">
            {stats.failed}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Failed
          </div>
        </div>
      </div>

      {/* DataGrid */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-300 dark:border-slate-700">
        <DataGrid
          data={jobs}
          columns={columns}
          getRowId={(row) => row.id}
          enableRowActions
          renderRowActions={renderRowActions}
          emptyMessage={loading ? 'Loading jobs...' : 'No jobs found'}
          emptyDescription={
            loading ? '' : 'Background jobs will appear here when submitted'
          }
          exportFilename="jobs"
        />
      </div>

      {/* Job Detail Dialog */}
      <Dialog open={!!selectedJob} onOpenChange={() => setSelectedJob(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Job Details
            </DialogTitle>
          </DialogHeader>

          {selectedJob && (
            <div className="flex-1 overflow-y-auto space-y-6">
              {/* Job Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    Type
                  </div>
                  <div className="font-mono text-sm text-slate-900 dark:text-slate-100">
                    {selectedJob.type}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    Status
                  </div>
                  <Badge variant={statusVariants[selectedJob.status]}>
                    {selectedJob.status}
                  </Badge>
                </div>
                <div>
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    Priority
                  </div>
                  <Badge variant={priorityVariants[selectedJob.priority]}>
                    {selectedJob.priority}
                  </Badge>
                </div>
                <div>
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    Attempts
                  </div>
                  <div className="text-slate-900 dark:text-slate-100">
                    {selectedJob.attempts} / {selectedJob.maxAttempts}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    Created
                  </div>
                  <div className="text-slate-900 dark:text-slate-100">
                    {new Date(selectedJob.createdAt).toLocaleString()}
                  </div>
                </div>
                {selectedJob.completedAt && (
                  <div>
                    <div className="text-sm text-slate-500 dark:text-slate-400">
                      Completed
                    </div>
                    <div className="text-slate-900 dark:text-slate-100">
                      {new Date(selectedJob.completedAt).toLocaleString()}
                    </div>
                  </div>
                )}
              </div>

              {/* Error */}
              {selectedJob.error && (
                <div>
                  <div className="text-sm font-medium text-red-600 dark:text-red-400 mb-1">
                    Error
                  </div>
                  <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded p-3 text-sm text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap">
                    {selectedJob.error}
                  </div>
                </div>
              )}

              {/* Payload */}
              <div>
                <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Payload
                </div>
                <pre className="bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded p-3 text-xs text-slate-700 dark:text-slate-300 overflow-x-auto max-h-48">
                  {JSON.stringify(selectedJob.payload, null, 2)}
                </pre>
              </div>

              {/* Result */}
              {selectedJob.result && (
                <div>
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Result
                  </div>
                  <pre className="bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded p-3 text-xs text-slate-700 dark:text-slate-300 overflow-x-auto max-h-48">
                    {JSON.stringify(selectedJob.result, null, 2)}
                  </pre>
                </div>
              )}

              {/* Logs */}
              <div>
                <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Logs
                </div>
                {loadingLogs ? (
                  <div className="text-sm text-slate-500">Loading logs...</div>
                ) : jobLogs.length === 0 ? (
                  <div className="text-sm text-slate-500">No logs recorded</div>
                ) : (
                  <div className="bg-slate-900 dark:bg-slate-950 rounded p-3 text-xs font-mono max-h-48 overflow-y-auto space-y-1">
                    {jobLogs.map((log) => (
                      <div key={log.id} className="flex gap-2">
                        <span className="text-slate-500 shrink-0">
                          {new Date(log.createdAt).toLocaleTimeString()}
                        </span>
                        <span
                          className={`shrink-0 uppercase ${logLevelColors[log.level] || 'text-slate-400'}`}
                        >
                          [{log.level}]
                        </span>
                        <span className="text-slate-300">{log.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
