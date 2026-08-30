// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { RabbitMQClient } from '../rabbitmq/client'
import { JobTypeRegistry } from '../registry'
import { JobService } from '../JobService'
import { jobMessageSchema } from '../types'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { Job } from '../JobService'
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
// Context and timeout plumbing
// ============================================================================

/**
 * Build the context a handler executes with. Progress checkpoints double as
 * cancellation polls: `JobService.updateProgress` reports the row's current
 * status, and 'cancelled' — an admin cancelled the job from another process —
 * aborts this worker's controller, which both signals the handler (the
 * documented `context.signal` checks) and rejects the in-flight
 * `executeWithTimeout` immediately. A handler that never reports progress is
 * only stopped by its timeout.
 */
export function createJobContext(
  jobId: string,
  attempt: number,
  controller: AbortController,
): JobContext {
  return {
    jobId,
    attempt,
    signal: controller.signal,

    updateProgress: async (percent: number, message?: string) => {
      const status = await JobService.updateProgress(jobId, percent, message)
      if (status === 'cancelled' && !controller.signal.aborted) {
        workerLogger.info(
          { jobId },
          'Job cancelled in another process; aborting the handler',
        )
        controller.abort(new Error('Job was cancelled'))
      }
    },

    log: {
      debug: (message, data) =>
        JobService.addLog(jobId, 'debug', message, data),
      info: (message, data) => JobService.addLog(jobId, 'info', message, data),
      warn: (message, data) => JobService.addLog(jobId, 'warn', message, data),
      error: (message, data) =>
        JobService.addLog(jobId, 'error', message, data),
    },
  }
}

/**
 * Run a handler's promise under a timeout, aborting the controller when the
 * timeout fires. The abort is the load-bearing half: rejecting alone let the
 * handler keep running after the worker had already marked the job failed,
 * and its eventual completion raced the failure mark (now also closed off by
 * the status guard on `markCompleted`). An abort from elsewhere — the cancel
 * checkpoint, worker shutdown — rejects promptly through the same listener.
 */
export function executeWithTimeout<T>(
  promise: Promise<T>,
  timeout: number,
  controller: AbortController,
): Promise<T> {
  const { signal } = controller
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abortHandler)
      controller.abort(new Error(`Job timed out after ${timeout}ms`))
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
      .catch((error: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abortHandler)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
  })
}

/**
 * How long a delivery whose claim could not even be attempted waits before it
 * is handed back to the broker (env `WORKER_CLAIM_RETRY_DELAY_MS`, default
 * 5s). Named for consistency with `WORKER_RECONNECT_DEADLINE_MS`, the other
 * knob on this class.
 *
 * The pause is the point, not an afterthought: requeueing immediately would
 * spin the queue at full speed for as long as the database is unreachable,
 * with every redelivery failing the same way. With it, each prefetch slot
 * bounces its message roughly once every five seconds — the cadence the
 * Python workers use for the same decision.
 *
 * Keep it short. The slot is held for the duration, so at the default
 * concurrency of 5 a delay in the minutes would turn an outage into a
 * deadlock rather than into slow bouncing.
 */
function claimRetryDelayMs(): number {
  return Number(process.env.WORKER_CLAIM_RETRY_DELAY_MS ?? 5000)
}

// ============================================================================
// JobWorker
// ============================================================================

/**
 * Job worker process that consumes messages and executes handlers.
 */
export class JobWorker {
  private options: WorkerOptions
  private isShuttingDown = false
  private reconnecting = false
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

    // Reconnect supervision is wired here, in worker context only — the API
    // server shares RabbitMQClient for publishing and keeps its lazy
    // reconnect-on-publish behavior (see setOnConnectionLost).
    RabbitMQClient.setOnConnectionLost(() => {
      void this.reconnectUntilDeadline()
    })

    await this.startConsuming()

    workerLogger.info({ queue: this.options.queueName }, 'Listening on queue')

    // Set up graceful shutdown
    this.setupShutdownHandlers()
  }

  /**
   * Establish (or re-establish) the queue and consumer. The channel every
   * message arrives on is captured into its handler call, because delivery
   * tags are channel-scoped — an ack for a message from a previous channel
   * must never land on this one (see ack()).
   */
  private async startConsuming(): Promise<void> {
    const channel = await RabbitMQClient.createQueue(
      this.options.queueName,
      this.options.routingPatterns,
      {
        maxPriority: 10,
        prefetch: this.options.concurrency,
      },
    )

    await channel.consume(
      this.options.queueName,
      (msg) => {
        // `handleMessage` contains every failure it can name, but this
        // callback is the boundary between our code and amqplib's: nothing
        // above it awaits the promise, so a rejection escaping it is an
        // unhandled rejection, which Node terminates the process for by
        // default. This catch is the last line of that defence rather than
        // the first — if it ever fires, something inside lost its own
        // containment.
        void this.handleMessage(msg, channel).catch((error: unknown) => {
          workerLogger.error(
            { err: error },
            'Message handling threw past its own containment; the delivery is left unsettled for redelivery',
          )
        })
      },
      { noAck: false },
    )
  }

  /**
   * Re-establish the consumer after a connection loss, with capped
   * exponential backoff (1s → 30s). After WORKER_RECONNECT_DEADLINE_MS
   * (default 5 minutes) of consecutive failures the process exits 1 so the
   * container restart policy takes over — the same outer-loop shape the
   * Python workers already have. Without this, a dropped broker connection
   * left the worker idling forever on a dead channel while /health said 200.
   */
  private async reconnectUntilDeadline(): Promise<void> {
    if (this.isShuttingDown || this.reconnecting) return
    this.reconnecting = true

    const deadlineMs = parseInt(
      process.env.WORKER_RECONNECT_DEADLINE_MS || '300000',
      10,
    )
    const startedAt = Date.now()
    let delayMs = 1000

    workerLogger.warn('Broker connection lost; reconnecting')
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- SIGTERM flips this field concurrently across the await; the narrowing from the guard at the top of the method is stale here
        if (this.isShuttingDown) return
        try {
          await this.startConsuming()
          workerLogger.info('Reconnected to RabbitMQ and resumed consuming')
          return
        } catch (error) {
          workerLogger.warn({ err: error, delayMs }, 'Reconnect attempt failed')
          if (Date.now() - startedAt >= deadlineMs) {
            workerLogger.error(
              { deadlineMs },
              'Broker unreachable past the failure window; exiting so the restart policy takes over',
            )
            process.exit(1)
          }
          delayMs = Math.min(delayMs * 2, 30_000)
        }
      }
    } finally {
      this.reconnecting = false
    }
  }

  /**
   * Ack strictly on the channel the message arrived on. Delivery tags are
   * channel-scoped: acking an old delivery's tag on a replacement channel
   * makes the broker close it with 406 PRECONDITION_FAILED, tearing the new
   * consumer down in a loop. If the delivery channel is no longer current,
   * the ack is dropped on purpose — the broker requeued everything
   * unacknowledged when that channel died, and the atomic claim refuses the
   * redelivery.
   */
  private ack(deliveryChannel: Channel, msg: ConsumeMessage): void {
    if (deliveryChannel !== RabbitMQClient.getChannel()) {
      workerLogger.warn(
        'Dropping ack from a superseded channel; the redelivery is refused by the claim',
      )
      return
    }
    try {
      deliveryChannel.ack(msg)
    } catch (error) {
      workerLogger.warn({ err: error }, 'Ack failed on a closing channel')
    }
  }

  /** Nack with the same channel discipline as ack(). */
  private nack(
    deliveryChannel: Channel,
    msg: ConsumeMessage,
    requeue = false,
  ): void {
    if (deliveryChannel !== RabbitMQClient.getChannel()) {
      workerLogger.warn('Dropping nack from a superseded channel')
      return
    }
    try {
      deliveryChannel.nack(msg, false, requeue)
    } catch (error) {
      workerLogger.warn({ err: error }, 'Nack failed on a closing channel')
    }
  }

  /**
   * Handle incoming message.
   *
   * Three phases — decode, claim, execute — because the delivery is the job's
   * only wake-up and the three failure modes need three different answers. A
   * body that cannot be decoded is a poison message and is dead-lettered. A
   * claim that could not be attempted is requeued, because the row is still
   * pending/queued and nothing else will pick it up. Everything from a
   * successful claim onwards is settled in the database, so it acks — retries
   * are scheduled by status, never by requeueing. The Python workers make the
   * same three calls at the same three points.
   *
   * Every database call here is contained. Before that, a transient Postgres
   * outage while messages were flowing killed the process outright: the
   * consume callback discarded this promise, so a rejection from the claim or
   * from the failure-marking path became an unhandled rejection, and Node
   * terminates on those. The worker crash-looped for the length of the outage.
   */
  private async handleMessage(
    msg: ConsumeMessage | null,
    deliveryChannel: Channel,
  ): Promise<void> {
    if (!msg) return

    // Phase 1 — decode. Validation is part of decoding rather than a
    // formality: a body that is valid JSON but not a job message is just as
    // unusable as one that is not JSON at all, and it used to travel on as a
    // cast (see `jobMessageSchema`). Both go to the dead-letter exchange,
    // which is the only honest verdict for a body no amount of retrying can
    // fix, and both get there without opening a database connection.
    let message: JobMessage
    try {
      message = jobMessageSchema.parse(JSON.parse(msg.content.toString()))
    } catch (error) {
      workerLogger.error(
        { err: error },
        'Unusable message body; dead-lettering without touching the database',
      )
      this.nack(deliveryChannel, msg, false) // Send to DLQ
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
      // Don't DLQ — another worker may handle this type
      this.ack(deliveryChannel, msg)
      return
    }

    // Phase 2 — claim the job: one atomic UPDATE flips pending/queued to
    // running and counts the attempt. A null claim covers every
    // stale-delivery case in one place — the job does not exist, was
    // cancelled while queued, is already running under another delivery
    // (broker redelivery after a connection drop, or the retry sweep
    // re-publishing), or already settled. Ack without executing; the claim
    // holder owns the outcome.
    let job: Job | null
    try {
      job = await JobService.claimJob(jobId)
    } catch (error) {
      // The claim *threw*, which is a different thing from returning null:
      // it never landed, so the row is untouched and still pending/queued.
      // Acking would consume the job's only delivery and strand the row
      // until the queued-stale sweep noticed it ten minutes later, and
      // `markFailed` is guarded to 'running' rows so it would no-op here.
      // Requeue instead, after a pause, so a database outage bounces the
      // message slowly rather than spinning the queue.
      workerLogger.warn(
        { jobId, type, err: error },
        'Could not claim job; requeueing the delivery after a pause',
      )
      await new Promise((resolve) => setTimeout(resolve, claimRetryDelayMs()))
      this.nack(deliveryChannel, msg, true)
      return
    }
    if (!job) {
      workerLogger.info(
        { jobId, type },
        'Claim refused (missing, cancelled, or already claimed/settled) — acknowledging without executing',
      )
      this.ack(deliveryChannel, msg)
      return
    }

    // Create abort controller for cancellation
    const abortController = new AbortController()
    this.activeJobs.set(jobId, abortController)

    try {
      // Phase 3 — execute. The row is 'running' and ours, so every exit from
      // here is recorded in the database and every exit acks.
      //
      // Per-type timeout when the job type declares one; the worker-wide
      // JOB_TIMEOUT is only the fallback. Logged so a run can be checked
      // against the timeout that actually governed it.
      const config = JobTypeRegistry.getType(type)
      const timeoutMs = config?.timeout ?? this.options.timeout
      workerLogger.info({ jobId, type, timeoutMs }, 'Starting job')

      // Check the stored payload against its type's schema before the handler
      // sees it. `JobService.submit` writes the payload without parsing it, so
      // a caller passing a stale shape surfaced as an unexplained TypeError
      // from somewhere inside the handler; this fails the job with the
      // schema's own message instead, before any side effect has happened.
      // Throwing here lands in the catch below like any other job failure — it
      // is not retryable in any useful sense, since re-reading the same row
      // yields the same verdict, but running it through the ordinary path lets
      // the attempts ledger converge it to 'failed' rather than needing a
      // second kind of terminal write.
      //
      // A gate, not a transform: the handler is still given `job.payload`.
      // `z.object` strips unknown keys, and quietly narrowing what handlers
      // receive is a behaviour change this is not trying to make.
      config?.payloadSchema.parse(job.payload)

      const context = createJobContext(
        jobId,
        message.attemptNumber,
        abortController,
      )

      const result = await executeWithTimeout(
        handler.execute(job.payload, context),
        timeoutMs,
        abortController,
      )

      await JobService.markCompleted(jobId, result as Record<string, unknown>)
      workerLogger.info({ jobId }, 'Completed job')
      this.ack(deliveryChannel, msg)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      workerLogger.error({ jobId, err: error }, 'Job failed')

      // Recording a failure is itself two database writes, running in exactly
      // the conditions where the database is most likely to be the thing that
      // failed — including the case where this catch was entered because
      // `markCompleted` could not write. Letting either reject took the
      // process down with it. They are contained separately so that a lost log
      // does not skip the mark, which is the load-bearing half.
      try {
        await JobService.addLog(jobId, 'error', errorMessage, {
          stack: error instanceof Error ? error.stack : undefined,
        })
      } catch (logError) {
        workerLogger.error(
          { jobId, err: logError },
          'Could not attach the failure log to the job',
        )
      }

      try {
        await JobService.markFailed(jobId, errorMessage)
      } catch (markError) {
        // The row is left 'running'. That is the deliberate residual: the
        // stale-running sweep (`sweepStaleRunningJobs`) expires its lease once
        // it is past the type's own timeout plus the grace window and marks it
        // failed through the same guarded path, so the job still parks for
        // retry or fails terminally — minutes later rather than now.
        workerLogger.error(
          { jobId, err: markError },
          'Could not mark the job failed; leaving the row running for the stale-running sweep to reap',
        )
      }

      // Ack regardless: the execution happened, and handing it back to the
      // broker would re-run work whose failure the database may simply not
      // have recorded. Retries are scheduled by status, never by requeueing.
      this.ack(deliveryChannel, msg)
    } finally {
      this.activeJobs.delete(jobId)
    }
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
