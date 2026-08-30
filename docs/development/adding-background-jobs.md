# Adding Background Jobs

This guide covers how to add new background job types to Cascadia. Background jobs use RabbitMQ for async processing and follow a registry pattern that mirrors `ItemTypeRegistry`.

## Architecture Overview

```
Service Code                    RabbitMQ                  Worker Process
┌────────────────┐             ┌──────────┐              ┌──────────────────┐
│ JobService     │  publish    │  Queue   │  consume     │ JobTypeRegistry  │
│   .submit()   ─┼────────────>│          ├──────────────>│   .getHandler()  │
│                │             │          │              │   handler.execute │
│ jobs table     │  update     │          │              │   update status   │
│ (PostgreSQL)   │<────────────┼──────────┼──────────────┤                  │
└────────────────┘             └──────────┘              └──────────────────┘
```

1. Service code calls `JobService.submit()` with a type and payload
2. A job record is inserted into the `jobs` table
3. A lightweight message is published to RabbitMQ
4. The worker consumes the message, looks up the handler, and executes it
5. Job status and progress are updated in the database

## Step 1: Define Payload and Result Schemas

Create a `types.ts` file in `packages/core/src/lib/jobs/definitions/yourjob/`:

```typescript
// packages/core/src/lib/jobs/definitions/yourjob/types.ts
import { z } from 'zod'

/**
 * Payload for the widget processing job
 */
export const widgetProcessingPayloadSchema = z.object({
  widgetId: z.string().uuid(),
  userId: z.string().uuid(),
  options: z
    .object({
      force: z.boolean().optional(),
      priority: z.enum(['low', 'normal', 'high']).optional(),
    })
    .optional(),
})

export type WidgetProcessingPayload = z.infer<
  typeof widgetProcessingPayloadSchema
>

/**
 * Result of the widget processing job
 */
export const widgetProcessingResultSchema = z.object({
  success: z.boolean(),
  processedCount: z.number(),
  errors: z.array(z.string()).optional(),
})

export type WidgetProcessingResult = z.infer<
  typeof widgetProcessingResultSchema
>
```

## Step 2: Create Job Configuration

Create a `config.ts` file with the job type configuration:

```typescript
// packages/core/src/lib/jobs/definitions/yourjob/config.ts
import type { JobTypeConfig } from '../../types'
import {
  widgetProcessingPayloadSchema,
  widgetProcessingResultSchema,
} from './types'
import type { WidgetProcessingPayload, WidgetProcessingResult } from './types'

export const widgetProcessingConfig: JobTypeConfig<
  WidgetProcessingPayload,
  WidgetProcessingResult
> = {
  /** Unique job type identifier — use dot-separated category.action.detail */
  type: 'widget.process.batch',

  /** Human-readable label */
  label: 'Widget Batch Processing',

  /** RabbitMQ routing key — used for queue binding */
  routingKey: 'jobs.widget.process',

  /** Zod schemas for validation */
  payloadSchema: widgetProcessingPayloadSchema,
  resultSchema: widgetProcessingResultSchema,

  /** Timeout before job is considered stuck (ms) */
  timeout: 300000, // 5 minutes

  /** Maximum retry attempts */
  maxAttempts: 3,

  /** Retry delays in ms (exponential backoff) */
  retryDelays: [30000, 60000, 120000], // 30s, 1min, 2min

  /** Default priority for this job type */
  priority: 'normal', // 'low' | 'normal' | 'high' | 'critical'

  /** Optional: limit concurrent executions */
  // maxConcurrent: 5,

  /** Optional: rate limit for external API calls */
  // rateLimitPerMinute: 60,
}
```

### Configuration Fields

| Field                | Required | Description                                                  |
| -------------------- | -------- | ------------------------------------------------------------ |
| `type`               | Yes      | Unique identifier (e.g., `notification.workflow.transition`) |
| `label`              | Yes      | Human-readable name                                          |
| `routingKey`         | Yes      | RabbitMQ routing key for queue binding                       |
| `payloadSchema`      | Yes      | Zod schema to validate job payload                           |
| `resultSchema`       | Yes      | Zod schema to validate job result                            |
| `timeout`            | Yes      | Max execution time in ms (also the stale-running lease)      |
| `maxAttempts`        | Yes      | Total attempts including retries                             |
| `retryDelays`        | Yes      | Array of delays between retries (ms)                         |
| `priority`           | Yes      | Default priority: `low`, `normal`, `high`, `critical`        |
| `maxConcurrent`      | No       | Limit concurrent executions of this job type                 |
| `rateLimitPerMinute` | No       | Rate limit for external API calls                            |

## Step 3: Create Job Handler

Create a handler file at `packages/core/src/lib/jobs/node-handlers/yourjob.ts`:

```typescript
// packages/core/src/lib/jobs/node-handlers/yourjob.ts
import type { JobHandler, JobContext } from '../../types'
import type { WidgetProcessingPayload, WidgetProcessingResult } from './types'

export const widgetProcessingHandler: JobHandler<
  WidgetProcessingPayload,
  WidgetProcessingResult
> = {
  /** Must match the config type */
  type: 'widget.process.batch',

  async execute(
    payload: WidgetProcessingPayload,
    context: JobContext,
  ): Promise<WidgetProcessingResult> {
    // Log job start
    await context.log.info('Starting widget processing', {
      widgetId: payload.widgetId,
    })

    // Update progress (0-100)
    await context.updateProgress(10, 'Loading widget data...')

    // Do the actual work...
    const widget = await loadWidget(payload.widgetId)

    // Check for cancellation in loops
    if (context.signal.aborted) {
      throw new Error('Job was cancelled')
    }

    await context.updateProgress(50, 'Processing widget...')

    // Process the widget
    const result = await processWidget(widget, payload.options)

    await context.updateProgress(90, 'Finalizing...')

    // Log completion
    await context.log.info('Widget processing completed', {
      processedCount: result.processedCount,
    })

    return {
      success: true,
      processedCount: result.processedCount,
    }
  },
}
```

### JobContext API

The `context` object provides:

| Property                                    | Type            | Description               |
| ------------------------------------------- | --------------- | ------------------------- |
| `context.jobId`                             | `string`        | Unique job ID             |
| `context.attempt`                           | `number`        | Current attempt (1-based) |
| `context.updateProgress(percent, message?)` | `Promise<void>` | Report progress (0-100)   |
| `context.log.info(message, data?)`          | `Promise<void>` | Structured logging        |
| `context.log.warn(message, data?)`          | `Promise<void>` | Warning log               |
| `context.log.error(message, data?)`         | `Promise<void>` | Error log                 |
| `context.log.debug(message, data?)`         | `Promise<void>` | Debug log                 |
| `context.signal`                            | `AbortSignal`   | Cancellation signal       |

### Cancellation

Always check `context.signal.aborted` in long-running loops:

```typescript
for (const item of items) {
  if (context.signal.aborted) {
    throw new Error('Job was cancelled')
  }
  await processItem(item)
}
```

The signal fires in three cases: the worker is shutting down, the job's
timeout elapsed, or an admin cancelled the job from another process. The
cross-process case rides progress reporting — `context.updateProgress` is a
checkpoint that learns the row was cancelled and aborts the local signal
(the Python workers' `update_job_progress` raises `JobCancelled` at the same
point). **A handler that never reports progress is only stopped by its
timeout**, so long handlers should call `updateProgress` at every natural
boundary — it is the cancellation poll, not just cosmetics.

Whatever the handler does, the job's outcome is settled: a row that reached
`cancelled` (or any terminal state) is immutable — the completion/failure
marks are guarded to `running` rows, so a handler that ignores its signal
completes into the void.

### Timeouts

`config.timeout` is enforced per job type; the worker-wide `JOB_TIMEOUT` is
only the fallback for types that do not set one. When the timeout fires the
worker aborts `context.signal` and marks the job failed (which parks it for
retry while attempts remain). The timeout that governed a run is logged on
its `Starting job` line as `timeoutMs`.

`config.timeout` is also the **stale-running lease**: when the worker dies
before it can mark anything, the scheduler reaps the row at
`timeout + JOB_STALE_RUNNING_GRACE_MS` (see
[How retries actually run](#how-retries-actually-run)). Set it to the type's
worst honest run rather than an optimistic one — it is what tells the
scheduler the difference between a slow job and a lost one.

## Step 4: Register the Config and Handler

Registration is split into two files:

**Config registration** in `packages/core/src/lib/jobs/definitions/register.ts`:

```typescript
// packages/core/src/lib/jobs/definitions/register.ts
import { JobTypeRegistry } from '../registry'

// ... existing registrations ...

// Widget processing jobs
import { widgetProcessingConfig } from './yourjob/config'

JobTypeRegistry.register(widgetProcessingConfig)
```

**Handler registration** in `packages/core/src/lib/jobs/node-handlers/register.ts`:

```typescript
// packages/core/src/lib/jobs/node-handlers/register.ts
import { JobTypeRegistry } from '../registry'

// ... existing registrations ...

// Widget processing jobs
import { widgetProcessingHandler } from './yourjob'

JobTypeRegistry.registerHandler(widgetProcessingHandler)
```

If the handler runs in a separate worker process (e.g., Python CAD converter), register only the config in `definitions/register.ts` without a handler:

```typescript
// Config only — handled by external worker
JobTypeRegistry.register(cadConversionConfig)
// No registerHandler() call in node-handlers/register.ts
```

## Step 5: Submit Jobs

Submit jobs from services or API routes using `JobService.submit()`:

```typescript
import { JobService } from '@/lib/jobs'

// Basic submission
const job = await JobService.submit(
  'widget.process.batch', // Job type (must match config)
  {
    // Payload (validated against schema)
    widgetId: 'abc-123',
    userId: currentUser.id,
    options: { force: true },
  },
  currentUser.id, // Who submitted the job
)

// With options
const job = await JobService.submit('widget.process.batch', payload, userId, {
  priority: 'high', // Override default priority
  itemId: 'abc-123', // Link job to an item (for UI display)
})
```

### Checking Job Status

```typescript
const job = await JobService.getById(jobId)
// job.status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
// job.progress: 0-100
// job.progressMessage: 'Processing widget...'
// job.result: { success: true, processedCount: 42 }
```

## Directory Structure

```
packages/core/src/lib/jobs/
├── JobService.ts              # Submit, query, cancel jobs
├── registry.ts                # JobTypeRegistry (mirrors ItemTypeRegistry)
├── types.ts                   # Core interfaces (JobTypeConfig, JobHandler, JobContext)
├── index.ts                   # Public API
├── definitions/               # Job type configs and payload/result schemas
│   ├── register.ts            # Config registration entry point
│   ├── notification/          # Email notifications
│   │   ├── types.ts
│   │   └── config.ts
│   ├── design/                # Design operations
│   │   └── config.ts
│   ├── conversion/            # CAD conversion (Python worker)
│   │   └── config.ts          # Config only — no handler
│   ├── zoo-generation/        # Text-to-CAD generation
│   │   └── config.ts
│   └── yourjob/               # Your new job type
│       ├── types.ts
│       └── config.ts
├── node-handlers/             # Handler implementations (Node.js worker)
│   ├── register.ts            # Handler registration entry point
│   ├── workflow-transition.ts # Email on state change
│   ├── design-clone.ts        # Clone a design with all items
│   ├── zoo-generation.ts      # Zoo Text-to-CAD
│   └── yourjob.ts             # Your new job handler
├── rabbitmq/
│   └── client.ts              # RabbitMQ connection and publishing
└── worker/
    └── ...                    # Worker process entry point
```

## Running the Worker

The jobs worker runs as a separate process:

```bash
# Start RabbitMQ (required)
docker compose up -d rabbitmq

# Start the dev worker
docker compose --profile dev up jobs-worker-dev -d

# Watch worker logs
docker logs -f cascadia-jobs-worker-dev
```

The worker uses plain `tsx` (not watch mode), so you must restart it to pick up code changes.

## How retries actually run

`maxAttempts` and `retryDelays` describe a loop that lives in three places:

1. **Claim.** A worker (Node or Python) takes an execution with an atomic
   claim — one `UPDATE` that flips a `pending`/`queued` row to `running` and
   increments `attempts`. An execution that starts is an attempt, however it
   ends; a duplicate RabbitMQ delivery finds nothing to claim and acks
   without executing.
2. **Park.** A failed execution below the attempt cap is parked: status back
   to `pending` with `nextRetryAt = now + retryDelays[attempts - 1]`. At the
   cap the row goes `failed` terminally (the admin Retry button resets it).
   The schedule is **snapshotted onto the row** at submit time
   (`jobs.retry_delays`, milliseconds) beside `maxAttempts`, and both failure
   paths — `JobService.markFailed` and the Python workers'
   `mark_job_failed` — read that column, so a type's `retryDelays` governs
   Python-executed types too. Editing a config affects jobs submitted
   afterwards, not rows already queued; the admin Retry button re-snapshots.
   A row written before the column existed, or one whose type declares
   `retryDelays: []`, falls back to the executor's own 30s/60s/120s default.
3. **Sweep.** Every Node jobs worker runs a DB sweep
   (`lib/jobs/scheduler.ts`, interval `JOB_RETRY_SWEEP_MS`, default 15s) that
   re-publishes parked rows whose backoff has elapsed. The sweep also
   recovers **submit-crash orphans**: `JobService.submit` inserts the row,
   publishes, then flips it to `queued`, and a crash between insert and
   publish leaves a `pending` row with no `nextRetryAt` — swept once it is
   older than a two-minute grace window. And it recovers **stranded `queued`
   rows**: the claim is the only thing that ever moves one, so a delivery
   acked without claiming — a worker whose claim hit a transient database
   error, a broker that lost an unconsumed message — took the job's last
   wake-up with it. Such a row is re-published once its `queued_at` is older
   than `JOB_QUEUED_STALE_MS` (default 10 minutes). Keep that comfortably
   above the deployment's worst-case queue latency: a genuine backlog older
   than the grace costs one duplicate delivery per row per window, which the
   claim in step 1 discards, because the re-publish restamps `queued_at`.
4. **Reap.** A row leaves `running` only because the worker executing it
   says so, so a worker that dies mid-execution — OOM kill, pod eviction,
   power loss — used to wedge its job at `running` permanently: the claim
   refuses a redelivery of it, the retry sweep never looks at `running`
   rows, and the admin Retry button requires `failed`. The
   stale-running sweep (`sweepStaleRunningJobs`, cadence
   `JOB_STALE_SWEEP_MS`, default 60s) expires that lease. A row is reaped
   once its `started_at` is older than **the type's own `timeout` plus a
   grace window** (`JOB_STALE_RUNNING_GRACE_MS`, default 5 minutes), and the
   reap is `markFailed` — the same guarded call a worker makes — so the row
   parks for retry or fails terminally on exactly the ledger rules in step
   2, and a worker that was merely slow and finishes during the sweep still
   wins the race. No heartbeat column is involved: the claim already stamps
   `started_at` and the config already declares how long the type may run.

Multiple workers sweeping concurrently can re-publish the same job more than
once; the claim in step 1 is what makes that harmless, so there is
deliberately no cross-process lock around the sweep.

The reap in step 4 skips any row whose type this process has no definition
for — a community jobs worker sweeping a database that also carries
enterprise rows, or a type dropped by an upgrade while rows of it are still
in flight. Its timeout is simply unknowable here, so the row is left exactly
as it is (warned about once per type per process) for whichever worker fleet
does own the type.

One deployment caveat: Python-executed types (CAD conversion/generation)
park their retries in the same table, and the sweep that re-publishes them
runs in the **Node** jobs worker. A deployment running only Python workers
never retries a parked CAD job, and never reaps a stale running one either.

### How a worker settles a delivery

The loop above assumes the delivery itself is answered correctly, and there are
exactly three answers a worker can give one. The Node worker
(`lib/jobs/worker/index.ts`) and the two Python workers give the same three at
the same three points, deliberately: the delivery is the job's only wake-up, so
answering wrongly loses the job silently.

1. **Decode.** The body is parsed as JSON and checked against `jobMessageSchema`
   (`lib/jobs/types.ts`). A body that fails either is a poison message — no
   amount of retrying fixes it — so it is nacked **without requeue**, which
   routes it to the queue's dead-letter exchange. It gets there without opening
   a database connection: validating at the boundary is what stops a garbage
   `jobId` reaching the claim and coming back as a Postgres invalid-input error
   that is indistinguishable, at that point, from an outage.
2. **Claim.** If `claimJob` _throws_ — a different thing from returning null,
   which just means some other delivery owns the job — the claim never landed
   and the row is still `pending`/`queued`. Acking would consume the job's only
   wake-up, and `markFailed` is guarded to `running` rows so it would no-op.
   The delivery is nacked **with requeue** after a pause
   (`WORKER_CLAIM_RETRY_DELAY_MS`, default 5s; `CLAIM_RETRY_DELAY_SECONDS` on
   the Python workers), so a database outage bounces the message on a slow
   cadence instead of spinning the queue at full speed. That pause holds a
   prefetch slot for its duration, which is why it is measured in seconds.
3. **Execute.** From a successful claim onwards every outcome is recorded in
   the database, so every outcome **acks** — including a failed job, because
   retries are scheduled by status and never by requeueing. The stored payload
   is checked against its type's `payloadSchema` before the handler sees it,
   and one that fails goes down the ordinary failure path rather than into the
   handler as an unexplained `TypeError`.

Recording a failure is itself a database write, running in exactly the
conditions where the database is the likely culprit. If it cannot be written
the worker logs loudly and acks anyway, leaving the row `running` — which is
the case the reap in step 4 above exists for. The alternative is what used to
happen: the Node consume callback discarded the handler's promise, so a
transient outage surfaced as an unhandled rejection and Node ended the process,
crash-looping it for the length of the outage. The worker also registers
process-level backstops (`installProcessBackstops` in `jobs-worker-main.ts`) —
an unhandled rejection is logged and survived, an uncaught exception is logged
and exits 1 for the restart policy.

### Handlers must be idempotent

The reap expires a _lease_, not a process. Nothing stops a handler that is
still executing — re-opening the row is all the sweep can do — so a retry
can overlap the attempt it replaced:

- the original worker is wedged rather than dead (a socket with no timeout,
  a long GC pause) and comes back after the retry has started;
- the handler ignores `context.signal` and keeps going past its own timeout;
- the type is Python-executed, where `job_timeout` is currently configured
  but not enforced by the worker, so the handler runs until the process ends.

The `jobs` row is protected up to a point. Every terminal write is guarded to
`running` rows, so while the row sits parked or failed a zombie's
`markCompleted` lands nowhere and the reap's own outcome stands — that is
what the reap relies on. It stops being protected once the retry is claimed:
the row is `running` again, for a _different_ execution, and the guard cannot
tell the two apart because nothing on the row identifies which execution owns
it. **Side effects outside the `jobs` table are never protected.** So
anything a handler does out there has to be idempotent or checkpointed:

- write against a natural key and upsert (`onConflictDoUpdate`) rather than
  inserting blindly, so a second attempt converges instead of duplicating;
- checkpoint anything you paid for or cannot repeat — record the provider's
  request id before waiting on it and resume that id on the next attempt,
  rather than submitting a fresh request;
- check `context.signal.aborted` and call `context.updateProgress` at every
  natural boundary, which is what stops the cooperative cases early.

If a handler genuinely cannot be made idempotent, give its type a `timeout`
that comfortably exceeds its worst honest run: the reap only fires at
`timeout + grace`, so an accurate timeout is what keeps a live handler out
of the sweep's way.

## Existing Job Types for Reference

| Job Type                           | Routing Key                  | Handler | Description                   |
| ---------------------------------- | ---------------------------- | ------- | ----------------------------- |
| `notification.workflow.transition` | `jobs.notification.workflow` | Node.js | Email on state change         |
| `design.clone`                     | `jobs.design.clone`          | Node.js | Clone a design with all items |
| `maintenance.cache.cleanup`        | `jobs.maintenance.cache`     | Node.js | Periodic cache cleanup        |
| `workinstruction.part.changed`     | `jobs.workinstruction.part`  | Node.js | Alert on part change          |
| `cad.conversion.process`           | `jobs.cad.conversion`        | Python  | STEP/IGES to STL/GLB          |
| `cad.parametric.generate`          | `jobs.cad.parametric`        | Python  | Parametric CAD generation     |
| `cad.zoo.generate`                 | `jobs.cad.zoo`               | Node.js | Zoo Text-to-CAD               |
