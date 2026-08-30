// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The jobs worker itself — everything except which modules are attached.
 *
 * An app entry registers its edition's modules and then calls
 * `runJobsWorker()`. Keeping the 100-odd lines of queue-naming and shutdown
 * logic here rather than duplicating them per app is the whole reason this is a
 * function and not an entry point.
 *
 * Environment variables:
 * - RABBITMQ_URL: RabbitMQ connection URL (default: amqp://localhost:5672)
 * - DATABASE_URL: PostgreSQL connection URL
 * - WORKER_CONCURRENCY: Number of concurrent jobs (default: 5)
 * - JOB_TYPES: Comma-separated job type patterns (default: *)
 * - JOB_TIMEOUT: Job timeout in ms (default: 300000)
 * - HEALTH_PORT: Port for health check endpoint (default: 3002)
 * - JOB_RETRY_SWEEP_MS: Interval for the parked-retry sweep (default: 15000)
 * - JOB_QUEUED_STALE_MS: How long a 'queued' row may sit before that sweep
 *   treats its message as lost and re-publishes it (default: 600000). Keep it
 *   comfortably above the deployment's worst-case queue latency: a backlog
 *   older than it costs one duplicate delivery per row per window, which the
 *   claim discards.
 * - WORKER_RECONNECT_DEADLINE_MS: How long to retry a lost broker connection
 *   before exiting 1 for the restart policy to take over (default: 300000)
 * - WORKER_CLAIM_RETRY_DELAY_MS: How long a delivery whose claim could not be
 *   attempted — the database was unreachable — waits before it is requeued
 *   (default: 5000). Keep it to seconds: the prefetch slot is held for the
 *   duration, so a long delay turns an outage into a deadlock rather than
 *   into slow bouncing.
 * - WORKER_QUEUE_NAME: Override the derived queue name (default: derived from
 *   the routing patterns, so workers with the same JOB_TYPES share a queue)
 */

// Load .env file for local development
import 'dotenv/config'

import http from 'node:http'
import { createHash } from 'node:crypto'
import { JobWorker } from './lib/jobs/worker'
import { RabbitMQClient } from './lib/jobs/rabbitmq/client'
import { JobTypeRegistry } from './lib/jobs/registry'
import { startRetryScheduler } from './lib/jobs/scheduler'
import { workerLogger } from './lib/logging/logger'

// Register job type definitions (configs + schemas)
import './lib/jobs/definitions/register'

// Register Node.js handler implementations
import './lib/jobs/node-handlers/register'

/**
 * Start a simple HTTP health check server for container orchestration.
 *
 * Gates on broker connectivity as well as the shutdown flag: a worker whose
 * RabbitMQ connection dropped consumes nothing, and reporting 200 while
 * idle-forever is how that failure stayed invisible. 503 'disconnected'
 * matches the Python workers' health shape.
 */
function startHealthServer(worker: JobWorker, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const shuttingDown = worker.isShuttingDownNow()
      const brokerConnected = RabbitMQClient.isConnected()
      const isHealthy = !shuttingDown && brokerConnected

      res.writeHead(isHealthy ? 200 : 503, {
        'Content-Type': 'application/json',
      })
      res.end(
        JSON.stringify({
          status: shuttingDown
            ? 'shutting_down'
            : brokerConnected
              ? 'healthy'
              : 'disconnected',
          activeJobs: worker.getActiveJobCount(),
          timestamp: new Date().toISOString(),
        }),
      )
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })

  server.listen(port, () => {
    console.log(`[Jobs Worker] Health server listening on port ${port}`)
  })

  return server
}

/**
 * Register the process-level backstops.
 *
 * Node terminates the process on an unhandled rejection, and the worker had
 * enough uncontained `await`s on database calls that a transient Postgres
 * outage crash-looped it for the length of the outage. Those call sites are
 * now contained individually (see `JobWorker.handleMessage`); these two
 * handlers are what stops the *next* uncontained one doing the same thing,
 * and they turn a silent death into a log line either way.
 *
 * The two are answered differently on purpose. An unhandled rejection is
 * logged and survived: this process's state is a broker consumer and a map of
 * active jobs, and a promise nobody awaited corrupts neither — whatever job
 * was involved is recovered by the retry and stale-running sweeps, which is
 * strictly better than dropping every other in-flight job by exiting. An
 * uncaught exception unwound a synchronous stack from an unknown point and is
 * not survivable in the same way, so it is logged and the process exits 1 for
 * the restart policy to take over — the same answer `reconnectUntilDeadline`
 * gives an unreachable broker.
 */
export function installProcessBackstops(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    workerLogger.error(
      { err: reason },
      'Unhandled promise rejection in the jobs worker; continuing, and whatever job it belonged to is left to the sweeps',
    )
  })

  process.on('uncaughtException', (error: unknown) => {
    workerLogger.error(
      { err: error },
      'Uncaught exception in the jobs worker; exiting so the restart policy takes over',
    )
    process.exit(1)
  })
}

export async function runJobsWorker(): Promise<void> {
  // First, before anything that can throw: the backstops are worth most
  // during startup, when a misconfigured worker is at its most likely to die
  // in a way nothing reports.
  installProcessBackstops()

  const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10)
  const rawJobTypes = (process.env.JOB_TYPES || '*')
    .split(',')
    .map((t) => t.trim())
  const timeout = parseInt(process.env.JOB_TIMEOUT || '300000', 10)
  const healthPort = parseInt(process.env.HEALTH_PORT || '3002', 10)

  // When JOB_TYPES=*, derive routing patterns from registered handlers
  // so this worker only subscribes to job types it can actually process.
  const jobTypes = rawJobTypes.includes('*')
    ? JobTypeRegistry.getHandledRoutingKeys()
    : rawJobTypes.map((t) => `jobs.${t}`)

  // The queue name is derived from the routing patterns, NOT from
  // hostname+timestamp. Workers sharing a binding set share a queue and
  // compete for jobs, so each job is delivered exactly once; a per-instance
  // name would make the topic exchange fan the SAME job out to every worker
  // and orphan a still-bound durable queue on every restart.
  //
  // Hashing the patterns (rather than using one fixed name) keeps queue
  // identity tied to what the queue is actually bound to: a worker started
  // with a different JOB_TYPES gets its own queue instead of unioning its
  // bindings onto a shared one and receiving job types it cannot handle.
  // Bindings are additive and never auto-removed, so this also means a change
  // to the handled set yields a fresh queue rather than a stale binding.
  const queueName =
    process.env.WORKER_QUEUE_NAME ||
    `worker-${createHash('sha256')
      .update([...jobTypes].sort().join(','))
      .digest('hex')
      .slice(0, 10)}`

  console.log('[Jobs Worker] Configuration:')
  console.log(`  Queue: ${queueName}`)
  console.log(`  Routing patterns: ${jobTypes.join(', ')}`)
  console.log(`  Concurrency: ${concurrency}`)
  console.log(`  Timeout: ${timeout}ms`)
  console.log(`  Health port: ${healthPort}`)
  console.log(
    `  RabbitMQ: ${process.env.RABBITMQ_URL || 'amqp://localhost:5672'}`,
  )

  const worker = new JobWorker({
    queueName,
    routingPatterns: jobTypes,
    concurrency,
    timeout,
  })

  // Start health check server before connecting to RabbitMQ
  const healthServer = startHealthServer(worker, healthPort)

  // Parked retries and submit-crash orphans are re-published from here — the
  // sweep lives in the worker process, next to the atomic claim that makes
  // its duplicate publishes harmless.
  const retryScheduler = startRetryScheduler()

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(
      '[Jobs Worker] Shutting down retry scheduler and health server...',
    )
    retryScheduler.stop()
    healthServer.close()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await worker.start()
}
