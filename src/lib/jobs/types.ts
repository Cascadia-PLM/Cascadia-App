import type { z } from 'zod'

export type JobPriority = 'low' | 'normal' | 'high' | 'critical'
export type JobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * Priority mapping for RabbitMQ (1-9 scale)
 * Higher number = higher priority
 */
export const PRIORITY_MAP: Record<JobPriority, number> = {
  critical: 9,
  high: 6,
  normal: 3,
  low: 1,
}

/**
 * Configuration for a job type
 * Mirrors the ItemTypeConfig pattern from src/lib/items/types/base.ts
 */
export interface JobTypeConfig<TPayload = unknown, TResult = unknown> {
  /** Unique job type identifier (e.g., 'notification.workflow.transition') */
  type: string

  /** Human-readable label */
  label: string

  /** RabbitMQ routing key (e.g., 'jobs.notification.workflow') */
  routingKey: string

  /** Zod schema for payload validation */
  payloadSchema: z.ZodSchema<TPayload>

  /** Zod schema for result validation */
  resultSchema: z.ZodSchema<TResult>

  /** Timeout in milliseconds before job is considered stuck */
  timeout: number

  /** Maximum retry attempts */
  maxAttempts: number

  /** Retry delays in milliseconds (e.g., [30000, 120000, 600000]) */
  retryDelays: Array<number>

  /** Default priority for this job type */
  priority: JobPriority

  /** Global concurrency limit for this job type (optional) */
  maxConcurrent?: number

  /** Rate limit per minute for external API calls (optional) */
  rateLimitPerMinute?: number
}

/**
 * Runtime configuration loaded from database (future extensibility)
 */
export interface RuntimeJobTypeConfig {
  enabled?: boolean
  priority?: JobPriority
  maxConcurrent?: number
  rateLimitPerMinute?: number
}

/**
 * Context provided to job handlers during execution
 */
export interface JobContext {
  /** Job ID */
  jobId: string

  /** Current attempt number (1-based) */
  attempt: number

  /** Report progress (0-100) with optional message */
  updateProgress: (percent: number, message?: string) => Promise<void>

  /** Structured logging attached to job record */
  log: {
    debug: (message: string, data?: Record<string, unknown>) => Promise<void>
    info: (message: string, data?: Record<string, unknown>) => Promise<void>
    warn: (message: string, data?: Record<string, unknown>) => Promise<void>
    error: (message: string, data?: Record<string, unknown>) => Promise<void>
  }

  /** Cancellation signal - check signal.aborted or add listener */
  signal: AbortSignal
}

/**
 * Handler interface implemented by each job type
 */
export interface JobHandler<TPayload = unknown, TResult = unknown> {
  /** Job type this handler processes */
  type: string

  /** Execute the job with payload and context */
  execute: (payload: TPayload, context: JobContext) => Promise<TResult>
}

/**
 * Message published to RabbitMQ (lightweight reference to DB record)
 */
export interface JobMessage {
  jobId: string
  type: string
  priority: number
  attemptNumber: number
}
