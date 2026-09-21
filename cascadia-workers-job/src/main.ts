// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The jobs worker itself — everything except which modules are attached.
 *
 * An app entry (`cascadia-app/src/jobs-worker.ts`) registers its edition's
 * modules and then calls `runJobsWorker()`. Keeping the 100-odd lines of
 * queue-naming and shutdown logic here rather than duplicating them per app is
 * the whole reason this is a function and not an entry point.
 *
 * This package sits above the api: it imports the api's services, registry and
 * job definitions, and registers the handlers that run them. The api never
 * imports this package — `JobService.submit` needs a job's definition, which
 * stays in the api, never its handler.
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
 * - DLQ_CHECK_MS: How often the dead-letter queue's depth is read for
 *   /health, and how stale a cached depth may be (default: 30000)
 * - DLQ_WARN_DEPTH: Depth at which the worker logs a warning that the
 *   dead-letter queue needs draining (default: 100)
 * - EVENT_POLL_INTERVAL_MS: Domain event consumer poll interval (default: 2000)
 * - EVENT_CONSUMER_PARK_AFTER: Consecutive handler failures after which an
 *   event consumer is parked until an admin resumes it (default: 10)
 * - EVENT_CONSUMERS_IN_APP: Whether the *app server* also polls event
 *   consumers (default: true). Set false when this worker is deployed, to keep
 *   one poller; running both is safe either way.
 * - EVENT_RETENTION_DAYS: How much event history the retention job keeps
 *   (default: 90). Zero or less retains forever.
 * - WEBHOOK_PUMP_INTERVAL_MS: How often the webhook delivery pump looks for
 *   pending deliveries (default: 5000).
 * - WEBHOOK_DELIVERY_RETENTION_DAYS: How much webhook delivery history the same
 *   retention job keeps (default: 30). Zero or less retains forever. Pending
 *   deliveries are never pruned whatever their age.
 * - ENCRYPTION_KEY: Required to sign webhook deliveries. The pump refuses to
 *   start when a signed subscription exists and this is unset, rather than
 *   sending unsigned.
 */

// Load .env file for local development
import 'dotenv/config'

import http from 'node:http'
import { createHash } from 'node:crypto'
import {
  ensureDomainEventSequencing,
  sequenceUnsequencedEvents,
} from '@cascadia/api/lib/events'
import {
  registerCoreExtensions,
  registerRabbitMqEventRelay,
  registerWebhookDispatcher,
  startEventConsumerPolling,
} from '@cascadia/api/lib/extensions'
import { db } from '@cascadia/api/lib/db'
import { startWebhookDeliveryPump } from '@cascadia/api/lib/webhooks/pump'
import { RabbitMQClient } from '@cascadia/api/lib/jobs/rabbitmq/client'
import { JobTypeRegistry } from '@cascadia/api/lib/jobs/registry'
import { ItemTypeRegistry } from '@cascadia/api/lib/items/registry'
import { workerLogger } from '@cascadia/api/lib/logging/logger'
import { redactUrlCredentials } from '@cascadia/api/lib/logging/redact-url'
import { deadLetterDepth, startRetryScheduler } from './scheduler'
import { JobWorker } from './worker'

// Register job type definitions (configs + schemas)
import '@cascadia/api/lib/jobs/definitions/register'

// Register Node.js handler implementations
import './register'

// Register item type definitions.
//
// The HTTP server gets these from any of the route modules it mounts; this
// process mounts none, so without this line the registry is empty here and
// every item type answers "no lifecycle assigned" — which is what
// `design.clone` hit on its first item, reporting it as an unseeded database.
import '@cascadia/api/lib/items/registerItemTypes.server'

/**
 * Start a simple HTTP health check server for container orchestration.
 *
 * Gates on broker connectivity as well as the shutdown flag: a worker whose
 * RabbitMQ connection dropped consumes nothing, and reporting 200 while
 * idle-forever is how that failure stayed invisible. 503 'disconnected'
 * matches the Python workers' health shape.
 *
 * `dlqDepth` reports the dead-letter queue, which nothing consumes: it is the
 * only place a poison message can be seen at all, and until it appeared here
 * an operator had to know to open the management UI. It is deliberately not
 * part of the health verdict — a worker with a backlog of undecodable
 * messages is doing its job correctly, and a queue nobody drains must not
 * make an orchestrator restart every worker in the fleet. `null` means the
 * depth is not known yet or the broker could not answer it; a monitor should
 * treat that as unknown rather than as zero. The value is served from a cache
 * the scheduler refreshes, so a poll every second costs the broker nothing.
 *
 * `webhookPump` says whether this worker is sending webhook deliveries:
 * `starting`, `running`, or `not_running` when the pump refused to start — a
 * signed subscription exists and `ENCRYPTION_KEY` is not set — and nothing is
 * being delivered. Not part of the verdict either: a restart would refuse
 * again, for the same reason.
 */
function startHealthServer(
  worker: JobWorker,
  port: number,
  extras: () => Record<string, unknown> = () => ({}),
): http.Server {
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
          dlqDepth: deadLetterDepth(),
          ...extras(),
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

  // The database half of item-type registration, awaited for the same reason
  // the HTTP server awaits it: a job that resolves a lifecycle must see the
  // assigned one, not the shipped default.
  await ItemTypeRegistry.initialize()

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
    `  RabbitMQ: ${redactUrlCredentials(process.env.RABBITMQ_URL || 'amqp://localhost:5672')}`,
  )

  const worker = new JobWorker({
    queueName,
    routingPatterns: jobTypes,
    concurrency,
    timeout,
  })

  // Start health check server before connecting to RabbitMQ
  let webhookPumpState: 'starting' | 'running' | 'not_running' = 'starting'
  const healthServer = startHealthServer(worker, healthPort, () => ({
    webhookPump: webhookPumpState,
  }))

  // Parked retries and submit-crash orphans are re-published from here — the
  // sweep lives in the worker process, next to the atomic claim that makes
  // its duplicate publishes harmless.
  const retryScheduler = startRetryScheduler()

  // Domain event consumers run in the worker too: it is the process that owns
  // broker connectivity, and `FOR UPDATE SKIP LOCKED` on the cursor rows
  // makes extra pollers harmless if another process ever runs them as well.
  // The sequencing trigger is ensured first — a push-provisioned database
  // has none, and without it no event is ever assigned a seq to consume.
  await ensureDomainEventSequencing(db)
  // Rows written before the trigger existed carry no seq and would never be
  // consumed; give them one before any poller starts.
  await sequenceUnsequencedEvents(db)
  // The relay is a `consumed` extension like any other — registered here
  // rather than at import time so a deployment without RabbitMQ never
  // registers a consumer that cannot connect.
  registerRabbitMqEventRelay()
  // The webhook fan-out, registered here and *only* here for the same reason
  // as the relay: this is the process that drains the deliveries it writes, and
  // registering it somewhere that never runs the pump would advance its cursor
  // past events whose deliveries nobody sends.
  registerWebhookDispatcher()
  // Core's release follow-ups. The app server registers these too; whichever
  // process polls first for a given consumer takes its cursor row and the
  // other skips it.
  registerCoreExtensions()
  const stopEventPolling = startEventConsumerPolling({
    intervalMs: parseInt(process.env.EVENT_POLL_INTERVAL_MS || '2000', 10),
  })

  // The webhook delivery pump. Not the maintenance sweep, which submits one job
  // per registered type guarded over a twenty-four-hour period — a webhook would
  // fire at most once a day. It refuses to start rather than sending unsigned if
  // a signed subscription exists with no ENCRYPTION_KEY.
  const webhookPump = await startWebhookDeliveryPump()
  webhookPumpState = webhookPump.running ? 'running' : 'not_running'

  // Handle graceful shutdown. Event polling and the webhook pump each let the
  // work in flight finish — a consumer run commits or rolls back whole, and an
  // interrupted delivery gives its attempt back — and each bounds its own wait,
  // so a hung receiver cannot hold the process open.
  const shutdown = () => {
    console.log(
      '[Jobs Worker] Shutting down retry scheduler, event polling, webhook pump and health server...',
    )
    retryScheduler.stop()
    void Promise.allSettled([stopEventPolling(), webhookPump.stop()]).finally(
      () => healthServer.close(),
    )
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await worker.start()
}
