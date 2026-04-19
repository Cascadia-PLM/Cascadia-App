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

Create a `types.ts` file in `src/lib/jobs/definitions/yourjob/`:

```typescript
// src/lib/jobs/definitions/yourjob/types.ts
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
// src/lib/jobs/definitions/yourjob/config.ts
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
| `timeout`            | Yes      | Max execution time in ms                                     |
| `maxAttempts`        | Yes      | Total attempts including retries                             |
| `retryDelays`        | Yes      | Array of delays between retries (ms)                         |
| `priority`           | Yes      | Default priority: `low`, `normal`, `high`, `critical`        |
| `maxConcurrent`      | No       | Limit concurrent executions of this job type                 |
| `rateLimitPerMinute` | No       | Rate limit for external API calls                            |

## Step 3: Create Job Handler

Create a handler file at `src/lib/jobs/node-handlers/yourjob.ts`:

```typescript
// src/lib/jobs/node-handlers/yourjob.ts
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

## Step 4: Register the Config and Handler

Registration is split into two files:

**Config registration** in `src/lib/jobs/definitions/register.ts`:

```typescript
// src/lib/jobs/definitions/register.ts
import { JobTypeRegistry } from '../registry'

// ... existing registrations ...

// Widget processing jobs
import { widgetProcessingConfig } from './yourjob/config'

JobTypeRegistry.register(widgetProcessingConfig)
```

**Handler registration** in `src/lib/jobs/node-handlers/register.ts`:

```typescript
// src/lib/jobs/node-handlers/register.ts
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
src/lib/jobs/
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
