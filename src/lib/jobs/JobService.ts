import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { jobLogs, jobs } from '../db/schema/jobs'
import { NotFoundError, ValidationError } from '../errors'
import { JobTypeRegistry } from './registry'
import { RabbitMQClient } from './rabbitmq/client'
import { PRIORITY_MAP } from './types'
import type { JobPriority, JobStatus } from '../db/schema/jobs'

// Register all job type definitions when JobService is imported
import './definitions/register'

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
  createdBy: string
  createdAt: Date
  queuedAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  attempts: number
  maxAttempts: number
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
   */
  static async submit<TPayload>(
    type: string,
    payload: TPayload,
    userId: string,
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
    const [job] = await db
      .insert(jobs)
      .values({
        type,
        status: 'pending',
        priority,
        payload: payload as Record<string, unknown>,
        itemId: options.itemId ?? null,
        createdBy: userId,
        maxAttempts: config.maxAttempts,
      })
      .returning()

    // Publish to RabbitMQ
    try {
      await RabbitMQClient.publish(config.routingKey, {
        jobId: job.id,
        type,
        priority: PRIORITY_MAP[priority],
        attemptNumber: 1,
      })

      // Update status to queued
      await db
        .update(jobs)
        .set({ status: 'queued', queuedAt: new Date() })
        .where(eq(jobs.id, job.id))

      return this.mapToJob({ ...job, status: 'queued', queuedAt: new Date() })
    } catch (error) {
      // Mark as failed if queue publish fails
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      await db
        .update(jobs)
        .set({
          status: 'failed',
          error: `Failed to queue job: ${errorMessage}`,
        })
        .where(eq(jobs.id, job.id))
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

    return results.length > 0 ? this.mapToJob(results[0]) : null
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
   * Cancel a pending or queued job.
   */
  static async cancel(jobId: string): Promise<void> {
    const job = await this.getOrThrow(jobId)

    if (!['pending', 'queued'].includes(job.status)) {
      throw new ValidationError(
        `Cannot cancel job in status: ${job.status}`,
        undefined,
        {
          operation: 'cancel',
          jobId,
        },
      )
    }

    await db
      .update(jobs)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(eq(jobs.id, jobId))
  }

  /**
   * Manually retry a failed job.
   */
  static async retry(jobId: string, _userId: string): Promise<Job> {
    const job = await this.getOrThrow(jobId)

    if (job.status !== 'failed') {
      throw new ValidationError(
        `Cannot retry job in status: ${job.status}`,
        undefined,
        {
          operation: 'retry',
          jobId,
        },
      )
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
        nextRetryAt: null,
      })
      .where(eq(jobs.id, jobId))
      .returning()

    // Re-queue
    await RabbitMQClient.publish(config.routingKey, {
      jobId,
      type: job.type,
      priority: PRIORITY_MAP[job.priority],
      attemptNumber: 1,
    })

    await db
      .update(jobs)
      .set({ status: 'queued', queuedAt: new Date() })
      .where(eq(jobs.id, jobId))

    return this.mapToJob({ ...updated, status: 'queued', queuedAt: new Date() })
  }

  // ==========================================================================
  // Worker Methods
  // ==========================================================================

  /**
   * Update job progress (called by workers).
   */
  static async updateProgress(
    jobId: string,
    progress: number,
    message?: string,
  ): Promise<void> {
    await db
      .update(jobs)
      .set({
        progress: Math.min(100, Math.max(0, progress)),
        progressMessage: message ?? null,
      })
      .where(eq(jobs.id, jobId))
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
   * Mark job as started (called by workers).
   */
  static async markStarted(jobId: string): Promise<void> {
    await db
      .update(jobs)
      .set({
        status: 'running',
        startedAt: new Date(),
      })
      .where(eq(jobs.id, jobId))
  }

  /**
   * Mark job as completed (called by workers).
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
      .where(eq(jobs.id, jobId))
  }

  /**
   * Mark job as failed (called by workers).
   * Handles retry logic with exponential backoff.
   */
  static async markFailed(jobId: string, error: string): Promise<void> {
    const job = await this.get(jobId)
    if (!job) return

    const config = JobTypeRegistry.getType(job.type)
    const newAttempts = job.attempts + 1

    if (newAttempts < job.maxAttempts && config) {
      // Schedule retry with exponential backoff
      const delayIndex = Math.min(
        newAttempts - 1,
        config.retryDelays.length - 1,
      )
      const delay = config.retryDelays[delayIndex] ?? 30000
      const nextRetry = new Date(Date.now() + delay)

      await db
        .update(jobs)
        .set({
          status: 'pending',
          attempts: newAttempts,
          error,
          nextRetryAt: nextRetry,
        })
        .where(eq(jobs.id, jobId))
    } else {
      // Max retries exceeded
      await db
        .update(jobs)
        .set({
          status: 'failed',
          attempts: newAttempts,
          error,
          completedAt: new Date(),
        })
        .where(eq(jobs.id, jobId))
    }
  }

  /**
   * Get jobs ready for retry (pending with nextRetryAt in the past).
   */
  static async getJobsForRetry(): Promise<Array<Job>> {
    const results = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.nextRetryAt, new Date())))
      .limit(100)

    return results.map(this.mapToJob)
  }

  /**
   * Re-queue a job for retry (called by retry scheduler).
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
      .where(eq(jobs.id, jobId))
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

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
      nextRetryAt: row.nextRetryAt,
    }
  }
}
