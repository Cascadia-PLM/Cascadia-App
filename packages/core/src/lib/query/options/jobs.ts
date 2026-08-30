// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { JobPriority, JobStatus } from '@/lib/db/schema/jobs'
import { apiFetch } from '@/lib/api/client'

export interface Job {
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

export interface JobLog {
  id: string
  jobId: string
  level: string
  message: string
  data: Record<string, unknown> | null
  createdAt: string
}

export interface JobDetail {
  job: Job
  logs: Array<JobLog>
}

/**
 * The background job queue.
 *
 * Job state advances on the worker rather than in response to a user action,
 * so the admin page layers a `refetchInterval` on top of this when
 * auto-refresh is on — the React Query equivalent of a polling timer, and one
 * that stops on unmount.
 */
export function jobListQuery(limit = 100) {
  return queryOptions({
    queryKey: qk.list('jobs', { limit }),
    queryFn: async (): Promise<Array<Job>> => {
      const result = await apiFetch<{ data: { jobs: Array<Job> } }>(
        `/api/v1/admin/jobs?limit=${limit}`,
      )
      return result.data.jobs
    },
  })
}

/** One job with the log lines its handler recorded. */
export function jobDetailQuery(id: string, enabled = true) {
  return queryOptions({
    queryKey: qk.detail('jobs', id),
    queryFn: async (): Promise<JobDetail> => {
      const result = await apiFetch<{ data: JobDetail }>(
        `/api/v1/admin/jobs/${id}`,
      )
      return result.data
    },
    enabled,
  })
}

/** A job's live progress, as the non-admin `/api/v1/jobs/:id` reports it. */
export interface JobStatusSnapshot<TResult> {
  id: string
  status: JobStatus
  progress: number
  progressMessage: string | null
  result: TResult | null
  error: string | null
}

/**
 * One job's own status, from the endpoint any user may read for a job they
 * started — as opposed to `jobDetailQuery`, which reads the admin endpoint
 * and carries the handler's log lines.
 *
 * Callers watching work in flight layer a `refetchInterval` on this and let
 * it return `false` once the job reaches a terminal status; that replaces a
 * hand-rolled `setInterval` and stops on unmount without a cleanup to forget.
 */
export function jobStatusQuery<TResult = Record<string, unknown>>(
  id: string | null,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.detail('jobs', `status:${id ?? ''}`),
    queryFn: async (): Promise<JobStatusSnapshot<TResult>> => {
      const result = await apiFetch<{ data: JobStatusSnapshot<TResult> }>(
        `/api/v1/jobs/${id}`,
      )
      return result.data
    },
    enabled: enabled && Boolean(id),
  })
}
