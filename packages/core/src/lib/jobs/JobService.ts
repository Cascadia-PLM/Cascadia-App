// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { jobLogs, jobs } from '../db/schema/jobs'
import { NotFoundError, ValidationError } from '../errors'
import { JobTypeRegistry } from './registry'
import { RabbitMQClient } from './rabbitmq/client'
import { PRIORITY_MAP } from './types'
import type { JobPriority, JobStatus } from '../db/schema/jobs'
import { takeFirst } from '@/lib/db/take-first'

// Register all job type definitions when JobService is imported
import './definitions/register'

/**
 * How long a 'pending' row with no nextRetryAt may sit before the retry sweep
 * treats it as a crashed submit rather than one still in flight. A healthy
 * submit publishes within milliseconds; two minutes is comfortably past any
 * broker timeout it could be stuck behind.
 */
const SUBMIT_CRASH_GRACE_MS = 2 * 60 * 1000

/**
 * How long a 'queued' row may sit before the retry sweep concludes its
 * message is gone and re-publishes it. Default for env `JOB_QUEUED_STALE_MS`.
 *
 * A job reaches 'queued' with its message live on the broker, and from there
 * the delivery is the only thing that will ever move it: the claim is the
 * sole writer of 'running', and a delivery consumed without a claim — a
 * worker whose claim raised a transient database error and acked anyway, a
 * broker that lost an unconsumed message — takes the row's only wake-up with
 * it. This grace is the lease on that message.
 *
 * The cost of being wrong is bounded at **one duplicate delivery per row per
 * grace window**, because `requeueForRetry` restamps `queued_at` as it
 * re-publishes: a backlog legitimately deeper than the grace pays one extra
 * message per job per window, and the atomic claim discards every duplicate
 * but the first, exactly as the scheduler's header describes. The restamp
 * also keeps such a backlog from monopolising the sweep's 100-row budget:
 * each pass takes its rows out of the predicate, so parked retries behind
 * them wait ticks, not forever. Ten minutes sits far above any healthy queue
 * latency, which is what makes that cost negligible; a deployment whose
 * queues legitimately run deeper raises it.
 */
const QUEUED_STALE_GRACE_MS = 10 * 60 * 1000

function queuedStaleGraceMs(): number {
  return Number(process.env.JOB_QUEUED_STALE_MS ?? QUEUED_STALE_GRACE_MS)
}

// ============================================================================
// Types
// ============================================================================

export interface SubmitJobOptions {
  priority?: JobPriority
  itemId?: string
}

export interface JobFilter {
  status?: JobStatus | Array<JobStatus>
  type?: string | Array<string>
  itemId?: string
  createdBy?: string
  limit?: number
  offset?: number
}

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
  /** Null when the system submitted the job (scheduler maintenance sweep). */
  createdBy: string | null
  createdAt: Date
  queuedAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  attempts: number
  maxAttempts: number
  /**
   * Backoff schedule in milliseconds, snapshotted from the type's config at
   * submit time. Null on rows submitted before the column existed; the
   * executor falls back to the registered config then.
   */
  retryDelays: Array<number> | null
  nextRetryAt: Date | null
}

export interface JobLog {
  id: string
  jobId: string
  level: string
  message: string
  data: Record<string, unknown> | null
  createdAt: Date
}

// ============================================================================
// JobService
// ============================================================================

/**
 * Service for managing background jobs.
 * All methods are static following Cascadia service patterns.
 */
export class JobService {
  /**
   * Submit a new job for processing.
   *
   * `userId: null` is the system-submission path (the scheduler's
   * maintenance sweep) — there is no seeded system user on released
   * installs, so `created_by` is simply NULL.
   */
  static async submit<TPayload>(
    type: string,
    payload: TPayload,
    userId: string | null,
    options: SubmitJobOptions = {},
  ): Promise<Job> {
    const config = JobTypeRegistry.getType(type)
    if (!config) {
      throw new NotFoundError('Job type', type, { operation: 'submit' })
    }

    // Validate payload
    try {
      config.payloadSchema.parse(payload)
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw ValidationError.fromZodError(error, {
          operation: 'submit',
          jobType: type,
        })
      }
      throw error
    }

    const priority = options.priority ?? config.priority

    // Insert job record
    const job = takeFirst(
      await db
        .insert(jobs)
        .values({
          type,
          status: 'pending',
          priority,
          payload: payload as Record<string, unknown>,
          itemId: options.itemId ?? null,
          createdBy: userId,
          maxAttempts: config.maxAttempts,
          // Snapshot the schedule alongside the attempt cap so the Python
          // executors park on the type's own delays instead of a constant
          // of their own (JOBS2-10).
          retryDelays: config.retryDelays,
        })
        .returning(),
    )

    // Publish to RabbitMQ
    try {
      await RabbitMQClient.publish(config.routingKey, {
        jobId: job.id,
        type,
        priority: PRIORITY_MAP[priority],
        attemptNumber: 1,
      })

      // Flip to 'queued' only while the row is still the 'pending' one this
      // method inserted. The message is live the moment `publish` returns, so
      // a worker can claim the job — or an operator cancel it — before this
      // write lands, and an unguarded flip would demote that 'running' row
      // back to 'queued': the message is already consumed, every worker-side
      // mark is guarded to 'running', and the job wedges there forever.
      const queued = await db
        .update(jobs)
        .set({ status: 'queued', queuedAt: new Date() })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'pending')))
        .returning()

      // Losing that race is not an error — the job is further along than
      // 'queued', not behind it — so report what the row actually says
      // instead of the 'queued' this used to fabricate.
      const flipped = queued.at(0)
      return flipped ? this.mapToJob(flipped) : await this.readBack(job)
    } catch (error) {
      // Mark as failed if queue publish fails — again only from 'pending'. A
      // publish that throws may still have reached the broker (a lost ack is
      // indistinguishable from a lost message), so the job may already be
      // running or cancelled by now; the guard keeps this from resurrecting
      // a row that has moved on.
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      await db
        .update(jobs)
        .set({
          status: 'failed',
          error: `Failed to queue job: ${errorMessage}`,
        })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'pending')))
      throw error
    }
  }

  /**
   * Get a job by ID.
   */
  static async get(jobId: string): Promise<Job | null> {
    const results = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)

    const row = results[0]
    return row ? this.mapToJob(row) : null
  }

  /**
   * Get a job by ID, throwing NotFoundError if not found.
   */
  static async getOrThrow(jobId: string): Promise<Job> {
    const job = await this.get(jobId)
    if (!job) {
      throw new NotFoundError('Job', jobId, { operation: 'get' })
    }
    return job
  }

  /**
   * List jobs with filtering.
   */
  static async list(
    filter: JobFilter = {},
  ): Promise<{ jobs: Array<Job>; total: number }> {
    const conditions = []

    if (filter.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
      conditions.push(inArray(jobs.status, statuses))
    }

    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type]
      conditions.push(inArray(jobs.type, types))
    }

    if (filter.itemId) {
      conditions.push(eq(jobs.itemId, filter.itemId))
    }

    if (filter.createdBy) {
      conditions.push(eq(jobs.createdBy, filter.createdBy))
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(whereClause)

    const results = await db
      .select()
      .from(jobs)
      .where(whereClause)
      .orderBy(desc(jobs.createdAt))
      .limit(filter.limit ?? 50)
      .offset(filter.offset ?? 0)

    return {
      jobs: results.map(this.mapToJob),
      total: countResult?.count ?? 0,
    }
  }

  /**
   * Get jobs for a specific item.
   */
  static async getForItem(itemId: string): Promise<Array<Job>> {
    const results = await db
      .select()
      .from(jobs)
      .where(eq(jobs.itemId, itemId))
      .orderBy(desc(jobs.createdAt))

    return results.map(this.mapToJob)
  }

  /**
   * Cancel a job. Pending and queued jobs cancel outright. A running job's
   * row flips to 'cancelled' immediately — the terminal state then wins every
   * subsequent write (the worker-side marks are guarded to 'running' rows) —
   * and the executing worker notices at its next progress checkpoint and
   * aborts its handler. A handler that never reports progress is only stopped
   * by its timeout.
   *
   * The guarded UPDATE is the whole check: a job that settles between a read
   * and a write here can never be un-settled by this method.
   */
  static async cancel(jobId: string): Promise<void> {
    const cancelled = await db
      .update(jobs)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(
        and(
          eq(jobs.id, jobId),
          inArray(jobs.status, ['pending', 'queued', 'running']),
        ),
      )
      .returning({ id: jobs.id })

    if (cancelled.length === 0) {
      const job = await this.getOrThrow(jobId)
      throw new ValidationError(
        `Cannot cancel job in status: ${job.status}`,
        undefined,
        {
          operation: 'cancel',
          jobId,
        },
      )
    }
  }

  /**
   * Manually retry a failed job.
   *
   * The reset is guarded to 'failed' rows, so the status check below is a
   * fast, well-worded refusal rather than the decision: a job that stops
   * being 'failed' between the read and the write — a second operator
   * clicking Retry, a sweep re-parking it — loses the race at the UPDATE and
   * is refused with the same error, never reset twice.
   */
  static async retry(jobId: string, _userId: string): Promise<Job> {
    const job = await this.getOrThrow(jobId)

    if (job.status !== 'failed') {
      throw this.cannotRetry(jobId, job.status)
    }

    const config = JobTypeRegistry.getType(job.type)
    if (!config) {
      throw new NotFoundError('Job type', job.type)
    }

    // Reset job for retry
    const [updated] = await db
      .update(jobs)
      .set({
        status: 'pending',
        error: null,
        attempts: 0,
        result: null,
        startedAt: null,
        completedAt: null,
        // Re-snapshot: an explicit operator retry re-reads the config, so
        // editing a type's delays and hitting Retry takes effect.
        retryDelays: config.retryDelays,
        nextRetryAt: null,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'failed')))
      .returning()

    if (!updated) {
      // Zero rows now means either shape, so read the row to tell them
      // apart: gone entirely, or no longer 'failed'.
      const current = await this.get(jobId)
      if (!current) {
        throw new NotFoundError('Job', jobId, { operation: 'retry' })
      }
      throw this.cannotRetry(jobId, current.status)
    }

    // Re-queue
    await RabbitMQClient.publish(config.routingKey, {
      jobId,
      type: job.type,
      priority: PRIORITY_MAP[job.priority],
      attemptNumber: 1,
    })

    // Same publish-window race as `submit`, and the same guard: the reset
    // above left the row 'pending', so anything that has moved it since owns
    // the job now.
    const queued = await db
      .update(jobs)
      .set({ status: 'queued', queuedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'pending')))
      .returning()

    const flipped = queued.at(0)
    return flipped ? this.mapToJob(flipped) : await this.readBack(updated)
  }

  // ==========================================================================
  // Worker Methods
  // ==========================================================================

  /**
   * Update job progress (called by workers). Returns the job's current
   * status so worker checkpoints double as cancellation polls: the write is
   * guarded to 'running' rows, so a job cancelled mid-run keeps its terminal
   * row untouched and the caller learns 'cancelled' instead — one round trip
   * in the normal case, a second read only when the write matched nothing.
   */
  static async updateProgress(
    jobId: string,
    progress: number,
    message?: string,
  ): Promise<JobStatus | null> {
    const updated = await db
      .update(jobs)
      .set({
        progress: Math.min(100, Math.max(0, progress)),
        progressMessage: message ?? null,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
      .returning({ status: jobs.status })

    const row = updated.at(0)
    if (row) return row.status

    const current = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
    return current.at(0)?.status ?? null
  }

  /**
   * Add log entry for a job.
   */
  static async addLog(
    jobId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(jobLogs).values({
      jobId,
      level,
      message,
      data: data ?? null,
    })
  }

  /**
   * Get logs for a job.
   */
  static async getLogs(jobId: string): Promise<Array<JobLog>> {
    const results = await db
      .select()
      .from(jobLogs)
      .where(eq(jobLogs.jobId, jobId))
      .orderBy(jobLogs.createdAt)

    return results.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      level: row.level,
      message: row.message,
      data: row.data,
      createdAt: row.createdAt,
    }))
  }

  /**
   * Atomically claim a job for execution (called by workers).
   *
   * One UPDATE flips a claimable row to 'running' and counts the attempt, so
   * every way a delivery can be stale refuses in the same place: a duplicate
   * delivery (RabbitMQ redelivers after a connection drop, and the retry
   * sweep may re-publish a job another worker already took), a job cancelled
   * while queued, and a job already settled. `null` means "someone else owns
   * this execution — ack and walk away", which is a legitimate answer, not an
   * error (hence no takeFirst).
   *
   * Attempts count at claim time — an execution that starts is an attempt,
   * however it ends — matching the Python workers; `markFailed` therefore
   * compares `attempts` as already counted and never increments.
   */
  static async claimJob(jobId: string): Promise<Job | null> {
    const rows = await db
      .update(jobs)
      .set({
        status: 'running',
        startedAt: new Date(),
        attempts: sql`COALESCE(${jobs.attempts}, 0) + 1`,
      })
      .where(
        and(eq(jobs.id, jobId), inArray(jobs.status, ['pending', 'queued'])),
      )
      .returning()

    const row = rows.at(0)
    return row ? this.mapToJob(row) : null
  }

  /**
   * Mark job as completed (called by workers).
   *
   * Guarded to 'running' rows: a handler that outlives its timeout or a
   * cross-process cancel completes into the void — the terminal state the
   * row already reached is never overwritten by a late finisher.
   */
  static async markCompleted(
    jobId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await db
      .update(jobs)
      .set({
        status: 'completed',
        result,
        progress: 100,
        completedAt: new Date(),
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
  }

  /**
   * Mark job as failed (called by workers).
   * Handles retry logic with exponential backoff.
   *
   * `attempts` was already counted when `claimJob` took the execution, so
   * this only compares — incrementing here double-counted every failure once
   * the claim started counting (and the Python workers had counted at start
   * all along, so the two halves of the system disagreed on what the column
   * meant).
   *
   * Both writes are guarded to 'running' rows for the same reason as
   * `markCompleted`: a job cancelled mid-run is terminal, and neither a
   * retry-park nor a final failure may resurrect it.
   */
  static async markFailed(jobId: string, error: string): Promise<void> {
    const job = await this.get(jobId)
    if (!job) return

    const config = JobTypeRegistry.getType(job.type)

    if (job.attempts < job.maxAttempts && config) {
      // Park for retry with exponential backoff; the sweep re-publishes it.
      // The row's snapshot wins over the registry so this and the Python
      // workers' mark_job_failed read one schedule; the config is the
      // fallback for rows submitted before the column existed. An empty
      // schedule (a type that declares `retryDelays: []`) falls through to
      // the 30s default rather than indexing nothing.
      const schedule =
        job.retryDelays && job.retryDelays.length > 0
          ? job.retryDelays
          : config.retryDelays
      const delayIndex = Math.min(job.attempts - 1, schedule.length - 1)
      const delay = schedule[Math.max(delayIndex, 0)] ?? 30000
      const nextRetry = new Date(Date.now() + delay)

      await db
        .update(jobs)
        .set({
          status: 'pending',
          error,
          nextRetryAt: nextRetry,
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
    } else {
      // Max retries exceeded
      await db
        .update(jobs)
        .set({
          status: 'failed',
          error,
          completedAt: new Date(),
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
    }
  }

  /**
   * Whether a job of `type` is active (pending/queued/running) or was
   * created within the window ending now. The maintenance sweep's guard:
   * true means "do not submit another one".
   */
  static async hasActiveOrRecentJob(
    type: string,
    since: Date,
  ): Promise<boolean> {
    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          or(
            inArray(jobs.status, ['pending', 'queued', 'running']),
            gte(jobs.createdAt, since),
          ),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  /**
   * Jobs the retry sweep should re-publish. Three shapes qualify:
   *
   *  - Parked retries: `markFailed` left them 'pending' with a `nextRetryAt`
   *    that has now elapsed.
   *  - Submit-crash orphans: `submit` inserts 'pending', publishes, then
   *    flips to 'queued' — a crash between insert and publish leaves a
   *    'pending' row with no `nextRetryAt` that nothing would ever look at
   *    again. Swept only once older than a grace window, so a healthy submit
   *    still in flight is never stolen. (No outbox exists in this tree; this
   *    is the minimal honest fix for that dual-write hole.)
   *  - Stale 'queued' rows: the message was published and then consumed
   *    without a claim, so the row is waiting on a delivery that will never
   *    come again — a worker whose claim raised a transient database error
   *    and acked the delivery anyway, or a broker that lost the message.
   *    Nothing else in the system looks at a 'queued' row but the claim, so
   *    until this clause existed the job was stuck until an admin cancelled
   *    it. Swept once `queued_at` is older than the queued-stale grace (see
   *    {@link QUEUED_STALE_GRACE_MS}), which is also what bounds the
   *    duplicate deliveries a legitimately deep backlog costs.
   *
   * Every writer of 'queued' stamps `queued_at` in the same UPDATE, so the
   * predicate below is total over that status — there is no null to fall
   * back on the way the submit-crash clause falls back on `created_at`.
   */
  static async getJobsForRetry(): Promise<Array<Job>> {
    const now = new Date()
    const submitCrashCutoff = new Date(now.getTime() - SUBMIT_CRASH_GRACE_MS)
    const staleQueuedCutoff = new Date(now.getTime() - queuedStaleGraceMs())
    const results = await db
      .select()
      .from(jobs)
      .where(
        or(
          and(
            eq(jobs.status, 'pending'),
            or(
              lte(jobs.nextRetryAt, now),
              and(
                isNull(jobs.nextRetryAt),
                lt(jobs.createdAt, submitCrashCutoff),
              ),
            ),
          ),
          and(eq(jobs.status, 'queued'), lt(jobs.queuedAt, staleQueuedCutoff)),
        ),
      )
      .limit(100)

    return results.map(this.mapToJob)
  }

  /**
   * 'running' rows whose execution started before `cutoff` — the candidate
   * set for the stale-running sweep.
   *
   * A row only ever leaves 'running' because the worker executing it says
   * so, and nothing else in the system looks at running rows at all: the
   * claim refuses a redelivery of one and acks, `getJobsForRetry` never
   * looks at 'running', and admin retry requires 'failed'. So a worker
   * that dies mid-execution (OOM kill, pod eviction, power loss) wedges its
   * job at 'running' forever. `started_at` plus the type's own timeout is
   * the lease this recovers on; the caller owns the per-type deadline,
   * because only it knows the registry.
   *
   * Bounded at 100 like `getJobsForRetry`, and covered by `idx_jobs_status`;
   * the running set is small by construction.
   */
  static async getRunningJobsOlderThan(cutoff: Date): Promise<Array<Job>> {
    const results = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'running'), lt(jobs.startedAt, cutoff)))
      .limit(100)

    return results.map(this.mapToJob)
  }

  /**
   * Re-queue a job for retry (called by retry scheduler).
   *
   * The flip is guarded to the statuses a re-publish may legitimately move:
   * 'pending' (the parked row this sweep picked up) and 'queued' (a row this
   * or another sweeper is re-publishing concurrently — the sweep is
   * deliberately unguarded against itself, so writing 'queued' over 'queued'
   * is the normal duplicate, not a race lost). Everything else is somebody
   * else's: a worker claimed the delivery within the publish window and the
   * row is 'running', or it settled. Neither may be resurrected — a demoted
   * 'running' row would wedge with its message already consumed.
   */
  static async requeueForRetry(jobId: string): Promise<void> {
    const job = await this.getOrThrow(jobId)

    const config = JobTypeRegistry.getType(job.type)
    if (!config) {
      throw new NotFoundError('Job type', job.type)
    }

    await RabbitMQClient.publish(config.routingKey, {
      jobId,
      type: job.type,
      priority: PRIORITY_MAP[job.priority],
      attemptNumber: job.attempts + 1,
    })

    await db
      .update(jobs)
      .set({
        status: 'queued',
        queuedAt: new Date(),
        nextRetryAt: null,
      })
      .where(
        and(eq(jobs.id, jobId), inArray(jobs.status, ['pending', 'queued'])),
      )
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * The job as the database now has it, for a guarded status flip that
   * matched nothing. `row` — the job as the caller last read it — is the
   * fallback for the only way this re-read comes back empty: a row deleted
   * outright, which nothing in this system does.
   */
  private static async readBack(row: typeof jobs.$inferSelect): Promise<Job> {
    const current = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, row.id))
      .limit(1)

    return this.mapToJob(current.at(0) ?? row)
  }

  /** One wording for retry's refusal, whichever check catches it. */
  private static cannotRetry(
    jobId: string,
    status: JobStatus,
  ): ValidationError {
    return new ValidationError(
      `Cannot retry job in status: ${status}`,
      undefined,
      {
        operation: 'retry',
        jobId,
      },
    )
  }

  private static mapToJob(row: typeof jobs.$inferSelect): Job {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      priority: row.priority,
      payload: row.payload,
      result: row.result,
      error: row.error,
      progress: row.progress ?? 0,
      progressMessage: row.progressMessage,
      itemId: row.itemId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      queuedAt: row.queuedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      attempts: row.attempts ?? 0,
      maxAttempts: row.maxAttempts ?? 3,
      retryDelays: row.retryDelays,
      nextRetryAt: row.nextRetryAt,
    }
  }
}
