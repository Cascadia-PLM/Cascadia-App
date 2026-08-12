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
 * - WORKER_QUEUE_NAME: Override the derived queue name (default: derived from
 *   the routing patterns, so workers with the same JOB_TYPES share a queue)
 */

// Load .env file for local development
import 'dotenv/config'

import http from 'node:http'
import { createHash } from 'node:crypto'
import { JobWorker } from './lib/jobs/worker'
import { JobTypeRegistry } from './lib/jobs/registry'

// Register job type definitions (configs + schemas)
import './lib/jobs/definitions/register'

// Register Node.js handler implementations
import './lib/jobs/node-handlers/register'

/**
 * Start a simple HTTP health check server for container orchestration
 */
function startHealthServer(worker: JobWorker, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const isHealthy = !worker.isShuttingDownNow()

      res.writeHead(isHealthy ? 200 : 503, {
        'Content-Type': 'application/json',
      })
      res.end(
        JSON.stringify({
          status: isHealthy ? 'healthy' : 'shutting_down',
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

export async function runJobsWorker(): Promise<void> {
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

  // Handle graceful shutdown
  const shutdown = () => {
    console.log('[Jobs Worker] Shutting down health server...')
    healthServer.close()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await worker.start()
}
