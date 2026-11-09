// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { JobService } from './JobService'
import { RabbitMQClient } from './rabbitmq/client'
import type { Job, SubmitJobOptions } from './JobService'
import { ExternalServiceUnavailableError } from '@/errors'

/**
 * Submit a job on behalf of a request that answers with it.
 *
 * The difference from `JobService.submit` is only in how an unreachable
 * broker reads to the caller. `submit` hands back the connection error
 * itself, which `handleApiError` can only call "An unexpected error
 * occurred" — a 500 that says nothing about what is down. A route whose whole
 * answer is "your work is queued" is better served by a 503 that says the
 * queue is not there, so the client can say so too.
 *
 * Only the connection is translated. Everything after it — the payload
 * check, the insert, a publish that fails once connected — reaches the
 * caller exactly as `submit` raises it.
 */
export async function submitForRequest<TPayload>(
  type: string,
  payload: TPayload,
  userId: string,
  options: SubmitJobOptions = {},
): Promise<Job> {
  try {
    await RabbitMQClient.connect()
  } catch (error) {
    throw new ExternalServiceUnavailableError(
      'job queue',
      { operation: 'submit', jobType: type },
      error instanceof Error ? error : undefined,
    )
  }
  return JobService.submit(type, payload, userId, options)
}

/** The body of a 202 from a route that queued its work as a job. */
export const jobAcceptedSchema = z.object({
  jobId: z.string().uuid(),
})

/**
 * 202 Accepted for a queued job: the job id in the standard envelope, and a
 * `Location` naming where to watch it. `GET /api/v1/jobs/:id` answers the
 * submitter with its status, progress and — once completed — its result.
 */
export function jobAccepted(job: Pick<Job, 'id'>): Response {
  return new Response(JSON.stringify({ data: { jobId: job.id } }), {
    status: 202,
    headers: {
      'Content-Type': 'application/json',
      Location: `/api/v1/jobs/${job.id}`,
    },
  })
}
