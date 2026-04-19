import { RabbitMQClient } from '../rabbitmq/client'
import { JobTypeRegistry } from '../registry'
import { JobService } from '../JobService'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { JobContext, JobMessage } from '../types'
import { workerLogger } from '@/lib/logging/logger'

// ============================================================================
// Types
// ============================================================================

export interface WorkerOptions {
  /** Queue name for this worker */
  queueName: string

  /** RabbitMQ routing patterns to bind (e.g., 'jobs.notification.workflow') */
  routingPatterns: Array<string>

  /** Number of concurrent jobs */
  concurrency: number

  /** Timeout in milliseconds */
  timeout: number
}

// ============================================================================
// JobWorker
// ============================================================================

/**
 * Job worker process that consumes messages and executes handlers.
 */
export class JobWorker {
  private options: WorkerOptions
  private channel: Channel | null = null
  private isShuttingDown = false
  private activeJobs = new Map<string, AbortController>()

  constructor(options: WorkerOptions) {
    this.options = options
  }

  /**
   * Start the worker.
   */
  async start(): Promise<void> {
    workerLogger.info(
      { patterns: this.options.routingPatterns },
      'Starting worker',
    )

    this.channel = await RabbitMQClient.createQueue(
      this.options.queueName,
      this.options.routingPatterns,
      {
        maxPriority: 10,
        prefetch: this.options.concurrency,
      },
    )

    // Start consuming
    await this.channel.consume(
      this.options.queueName,
      (msg) => this.handleMessage(msg),
      { noAck: false },
    )

    workerLogger.info({ queue: this.options.queueName }, 'Listening on queue')

    // Set up graceful shutdown
    this.setupShutdownHandlers()
  }

  /**
   * Handle incoming message.
   */
  private async handleMessage(msg: ConsumeMessage | null): Promise<void> {
    if (!msg || !this.channel) return

    let message: JobMessage
    try {
      message = JSON.parse(msg.content.toString()) as JobMessage
    } catch (error) {
      workerLogger.error({ err: error }, 'Failed to parse message')
      RabbitMQClient.nack(msg, false) // Send to DLQ
      return
    }

    const { jobId, type } = message

    // Check if handler exists in this worker
    const handler = JobTypeRegistry.getHandler(type)
    if (!handler) {
      workerLogger.warn(
        { type },
        'No handler for job type in this worker, acknowledging',
      )
      RabbitMQClient.ack(msg) // Don't DLQ — another worker may handle this type
      return
    }

    // Get job details
    const job = await JobService.get(jobId)
    if (!job) {
      workerLogger.error({ jobId }, 'Job not found')
      RabbitMQClient.ack(msg)
      return
    }

    if (job.status === 'cancelled') {
      workerLogger.info({ jobId }, 'Job cancelled, skipping')
      RabbitMQClient.ack(msg)
      return
    }

    // Create abort controller for cancellation
    const abortController = new AbortController()
    this.activeJobs.set(jobId, abortController)

    try {
      await JobService.markStarted(jobId)
      workerLogger.info({ jobId, type }, 'Starting job')

      // Create context
      const context = this.createContext(
        jobId,
        message.attemptNumber,
        abortController.signal,
      )

      // Execute with timeout
      const result = await this.executeWithTimeout(
        handler.execute(job.payload, context),
        this.options.timeout,
        abortController.signal,
      )

      await JobService.markCompleted(jobId, result as Record<string, unknown>)
      workerLogger.info({ jobId }, 'Completed job')
      RabbitMQClient.ack(msg)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      workerLogger.error({ jobId, err: error }, 'Job failed')

      await JobService.addLog(jobId, 'error', errorMessage, {
        stack: error instanceof Error ? error.stack : undefined,
      })

      await JobService.markFailed(jobId, errorMessage)
      RabbitMQClient.ack(msg) // Ack because we handle retries in the database
    } finally {
      this.activeJobs.delete(jobId)
    }
  }

  /**
   * Create job context for handler.
   */
  private createContext(
    jobId: string,
    attempt: number,
    signal: AbortSignal,
  ): JobContext {
    return {
      jobId,
      attempt,
      signal,

      updateProgress: async (percent: number, message?: string) => {
        await JobService.updateProgress(jobId, percent, message)
      },

      log: {
        debug: (message, data) =>
          JobService.addLog(jobId, 'debug', message, data),
        info: (message, data) =>
          JobService.addLog(jobId, 'info', message, data),
        warn: (message, data) =>
          JobService.addLog(jobId, 'warn', message, data),
        error: (message, data) =>
          JobService.addLog(jobId, 'error', message, data),
      },
    }
  }

  /**
   * Execute with timeout.
   */
  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeout: number,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Job timed out after ${timeout}ms`))
      }, timeout)

      const abortHandler = () => {
        clearTimeout(timer)
        reject(new Error('Job was cancelled'))
      }
      signal.addEventListener('abort', abortHandler)

      promise
        .then((result) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abortHandler)
          resolve(result)
        })
        .catch((error) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abortHandler)
          reject(error)
        })
    })
  }

  /**
   * Set up graceful shutdown handlers.
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return
      this.isShuttingDown = true

      workerLogger.info({ signal }, 'Received signal, shutting down gracefully')

      // Cancel all active jobs
      for (const [jobId, controller] of this.activeJobs) {
        workerLogger.info({ jobId }, 'Cancelling job')
        controller.abort()
      }

      // Wait for active jobs to complete (with timeout)
      const shutdownTimeout = 30000
      const start = Date.now()
      while (this.activeJobs.size > 0 && Date.now() - start < shutdownTimeout) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      // Close connection
      await RabbitMQClient.close()
      workerLogger.info('Shutdown complete')
      process.exit(0)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  }

  /**
   * Get number of active jobs.
   */
  getActiveJobCount(): number {
    return this.activeJobs.size
  }

  /**
   * Check if worker is shutting down.
   */
  isShuttingDownNow(): boolean {
    return this.isShuttingDown
  }

  /**
   * Stop the worker.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true
    for (const controller of this.activeJobs.values()) {
      controller.abort()
    }
    await RabbitMQClient.close()
  }
}
