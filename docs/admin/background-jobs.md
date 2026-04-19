# Background Jobs

Cascadia PLM uses RabbitMQ for asynchronous background job processing. This guide covers the jobs architecture, registered job types, administration, and operational concerns.

## Architecture Overview

```
                                    ┌──────────────────────┐
                                    │     Cascadia App     │
                                    │                      │
                                    │  JobService.submit() │
                                    └──────────┬───────────┘
                                               │
                                    INSERT job record (PostgreSQL)
                                    Publish message (RabbitMQ)
                                               │
                                               v
                              ┌─────────────────────────────────┐
                              │         RabbitMQ Broker          │
                              │                                 │
                              │  Exchange: jobs.topic (topic)   │
                              │  DLX: jobs.dlx (fanout)         │
                              │  DLQ: jobs.dead-letter           │
                              └──────────────┬──────────────────┘
                                             │
                              Routing by key (e.g., jobs.conversion.cad)
                                             │
                                             v
                              ┌──────────────────────────────┐
                              │        Job Worker(s)          │
                              │                              │
                              │  Consume message             │
                              │  Look up job in PostgreSQL   │
                              │  Execute handler             │
                              │  Update job status           │
                              └──────────────────────────────┘
```

**Key design decisions**:

- **PostgreSQL is the source of truth** for job state, progress, and results. RabbitMQ handles dispatch only.
- **Lightweight messages**: RabbitMQ messages contain only `jobId`, `type`, `priority`, and `attemptNumber`. The full payload is read from the database.
- **Retry logic lives in the database**, not in RabbitMQ. Failed jobs are re-queued by the application after configurable delays.
- **Dead letter queue** catches messages that cannot be parsed or have no registered handler.

## RabbitMQ Configuration

### Exchange and Queue Names

| Name               | Type   | Purpose                               |
| ------------------ | ------ | ------------------------------------- |
| `jobs.topic`       | topic  | Main job routing exchange             |
| `jobs.dlx`         | fanout | Dead letter exchange                  |
| `jobs.dead-letter` | queue  | Dead letter queue for failed messages |

### Connection

The RabbitMQ connection URL is configured via environment variable:

```
RABBITMQ_URL=amqp://localhost:5672
```

The `RabbitMQClient` uses a singleton connection with lazy initialization. It automatically sets up the exchanges and dead letter queue on first connect.

### Priority Support

Messages support priority levels 1-10. The priority mapping is:

| Priority   | RabbitMQ Value | Use Case                      |
| ---------- | -------------- | ----------------------------- |
| `critical` | 9              | System-critical operations    |
| `high`     | 6              | User-facing operations        |
| `normal`   | 3              | Standard background work      |
| `low`      | 1              | Maintenance and cleanup tasks |

## Job Worker Process

The job worker runs as a separate process (or container) from the main application. It consumes messages from RabbitMQ and executes the appropriate handler.

### Starting the Worker

**Development**:

```bash
# Start RabbitMQ
docker compose up -d rabbitmq

# Start the job worker
docker compose --profile dev up jobs-worker-dev -d

# Watch worker logs
docker logs -f cascadia-jobs-worker-dev
```

The dev worker uses plain `tsx` (not watch mode). You must restart it manually to pick up code changes.

**Production**: The worker runs as a Docker container using `workers/node/Dockerfile`.

### Worker Configuration

Workers are configured with:

| Option        | Description                                             |
| ------------- | ------------------------------------------------------- |
| `queueName`   | Queue to consume from                                   |
| `jobTypes`    | Routing patterns to handle (e.g., `['*']` for all jobs) |
| `concurrency` | Maximum concurrent jobs (controls prefetch count)       |
| `timeout`     | Default timeout per job in milliseconds                 |

### Message Processing Flow

For each consumed message:

1. Parse the message JSON
2. Look up the handler in `JobTypeRegistry`
3. Fetch the job record from PostgreSQL
4. Skip if the job is already cancelled
5. Mark the job as `running` with `startedAt` timestamp
6. Create a `JobContext` (progress reporter, logger, abort signal)
7. Execute the handler with a timeout
8. On success: mark as `completed` with result
9. On failure: increment attempts, schedule retry or mark as `failed`
10. Acknowledge the message (retries are handled by the database, not RabbitMQ redelivery)

If a message cannot be parsed or has no handler, it is negatively acknowledged without requeue, sending it to the dead letter queue.

## Registered Job Types

### CAD Conversion

| Property     | Value                              |
| ------------ | ---------------------------------- |
| Type         | `conversion.cad.step-to-stl`       |
| Label        | CAD to STL Conversion              |
| Routing Key  | `jobs.conversion.cad`              |
| Timeout      | 600,000 ms (10 minutes)            |
| Max Attempts | 2                                  |
| Retry Delays | 60s, 120s                          |
| Priority     | normal                             |
| Handler      | Python worker (separate container) |

Converts STEP/IGES CAD files to STL and GLB formats using pythonocc-core. The handler runs in the Python CAD converter service, not in the Node.js worker.

### Design Clone

| Property     | Value                  |
| ------------ | ---------------------- |
| Type         | `design.clone`         |
| Label        | Clone Design           |
| Routing Key  | `jobs.design.clone`    |
| Timeout      | 300,000 ms (5 minutes) |
| Max Attempts | 2                      |
| Retry Delays | 60s, 120s              |
| Priority     | high                   |
| Handler      | Node.js worker         |

Clones an entire design including all items, branches, and relationships. Runs at high priority because the user is typically waiting for the result.

### Workflow Transition Notification

| Property     | Value                              |
| ------------ | ---------------------------------- |
| Type         | `notification.workflow.transition` |
| Label        | Workflow Transition Notification   |
| Routing Key  | `jobs.notification.workflow`       |
| Timeout      | 60,000 ms (1 minute)               |
| Max Attempts | 3                                  |
| Retry Delays | 30s, 60s, 120s                     |
| Priority     | high                               |
| Handler      | Node.js worker                     |

Sends notifications when items transition between lifecycle states. High priority for timely user notifications.

### Work Instruction Part Change Alert

| Property     | Value                                      |
| ------------ | ------------------------------------------ |
| Type         | `notification.workinstruction.partchanged` |
| Label        | Work Instruction Part Change Notification  |
| Routing Key  | `jobs.notification.workinstruction`        |
| Timeout      | 120,000 ms (2 minutes)                     |
| Max Attempts | 3                                          |
| Retry Delays | 30s, 60s, 120s                             |
| Priority     | normal                                     |
| Handler      | Node.js worker                             |

Alerts work instruction owners when referenced parts are changed.

### Zoo Text-to-CAD Generation

| Property     | Value                      |
| ------------ | -------------------------- |
| Type         | `generation.cad.zoo`       |
| Label        | Zoo Text-to-CAD Generation |
| Routing Key  | `jobs.generation.cad.zoo`  |
| Timeout      | 600,000 ms (10 minutes)    |
| Max Attempts | 2                          |
| Retry Delays | 60s, 120s                  |
| Priority     | normal                     |
| Handler      | Node.js worker             |

Generates CAD models from text descriptions using the Zoo Text-to-CAD API. Long timeout due to external API latency.

### Parametric CAD Generation

| Property     | Value                                       |
| ------------ | ------------------------------------------- |
| Type         | `generation.cad.parametric`                 |
| Label        | Parametric CAD Generation                   |
| Routing Key  | `jobs.generation.cad.parametric`            |
| Timeout      | 60,000 ms (1 minute)                        |
| Max Attempts | 3                                           |
| Retry Delays | 5s, 15s, 30s                                |
| Priority     | high                                        |
| Handler      | Python CadQuery worker (separate container) |

Generates parametric CAD models using CadQuery. Fast retry delays because generation typically completes in 1-2 seconds.

### Thread Cache Cleanup

| Property     | Value                       |
| ------------ | --------------------------- |
| Type         | `maintenance.cache.cleanup` |
| Label        | Thread Cache Cleanup        |
| Routing Key  | `jobs.maintenance.cache`    |
| Timeout      | 60,000 ms (1 minute)        |
| Max Attempts | 3                           |
| Retry Delays | 30s, 60s, 120s              |
| Priority     | low                         |
| Handler      | Node.js worker              |

Removes expired and invalidated cache entries. Run periodically (daily or hourly) via a scheduler.

## Job Database Schema

### Jobs Table

| Column             | Type         | Description                                |
| ------------------ | ------------ | ------------------------------------------ |
| `id`               | UUID         | Primary key                                |
| `type`             | VARCHAR(100) | Job type identifier                        |
| `status`           | VARCHAR(20)  | Current status (see below)                 |
| `priority`         | VARCHAR(20)  | `low`, `normal`, `high`, `critical`        |
| `payload`          | JSONB        | Job-specific input data                    |
| `result`           | JSONB        | Job output on completion                   |
| `error`            | TEXT         | Error message on failure                   |
| `progress`         | INTEGER      | Percentage complete (0-100)                |
| `progress_message` | TEXT         | Human-readable progress status             |
| `item_id`          | UUID         | Optional link to an item                   |
| `created_by`       | UUID         | User who submitted the job                 |
| `created_at`       | TIMESTAMPTZ  | When the job was submitted                 |
| `queued_at`        | TIMESTAMPTZ  | When the job was published to RabbitMQ     |
| `started_at`       | TIMESTAMPTZ  | When the worker began execution            |
| `completed_at`     | TIMESTAMPTZ  | When the job finished (success or failure) |
| `attempts`         | INTEGER      | Number of execution attempts so far        |
| `max_attempts`     | INTEGER      | Maximum retry attempts allowed             |
| `next_retry_at`    | TIMESTAMPTZ  | When the next retry is scheduled           |

### Job Status Lifecycle

```
pending --> queued --> running --> completed
    |         |          |
    |         |          +--> failed (retries exhausted)
    |         |          |
    |         |          +--> pending (retry scheduled, next_retry_at set)
    |         |
    +---------+--> cancelled
```

| Status      | Description                                                 |
| ----------- | ----------------------------------------------------------- |
| `pending`   | Job created, not yet published to queue (or awaiting retry) |
| `queued`    | Published to RabbitMQ, waiting for a worker                 |
| `running`   | Currently being executed by a worker                        |
| `completed` | Finished successfully with result                           |
| `failed`    | All retry attempts exhausted                                |
| `cancelled` | Cancelled by an administrator                               |

### Job Logs Table

Each job has an associated log trail in `job_logs`:

| Column       | Type        | Description                      |
| ------------ | ----------- | -------------------------------- |
| `id`         | UUID        | Primary key                      |
| `job_id`     | UUID        | References `jobs.id`             |
| `level`      | VARCHAR(10) | `debug`, `info`, `warn`, `error` |
| `message`    | TEXT        | Log message                      |
| `data`       | JSONB       | Structured log data              |
| `created_at` | TIMESTAMPTZ | Timestamp                        |

Handlers write logs through the `JobContext.log` interface. These are stored in the database (not just stdout) for post-hoc debugging.

## Retry Logic

When a job fails, the system decides whether to retry based on the `attempts` count vs. `maxAttempts`:

1. If `attempts < maxAttempts`: schedule a retry
   - `status` is set to `pending`
   - `next_retry_at` is set based on the configured retry delays (exponential backoff)
   - A retry scheduler picks up pending jobs whose `next_retry_at` has passed and re-publishes them to RabbitMQ
2. If `attempts >= maxAttempts`: mark as permanently failed
   - `status` is set to `failed`
   - `completed_at` is set
   - The error message from the last attempt is preserved

### Retry Delay Configuration

Each job type defines its own retry delays as an array of milliseconds. The delay used is determined by the attempt number (clamped to the array length):

```
Attempt 1 fails -> retryDelays[0]
Attempt 2 fails -> retryDelays[1]
Attempt 3 fails -> retryDelays[2] (or last element if array is shorter)
```

Example for workflow notifications: `[30000, 60000, 120000]` = 30 seconds, 1 minute, 2 minutes.

## Timeout Handling

Each job execution is wrapped in a timeout. If the handler does not complete within the configured timeout:

- The promise is rejected with `"Job timed out after {timeout}ms"`
- The job follows the normal failure path (retry or permanent failure)
- Handlers should check `context.signal.aborted` in loops to support cooperative cancellation

## Dead Letter Queue

Messages are sent to the dead letter queue (`jobs.dead-letter`) when:

1. The message cannot be parsed as JSON
2. No handler is registered for the job type
3. A message is negatively acknowledged without requeue

The DLQ uses a fanout exchange (`jobs.dlx`), meaning all unprocessable messages end up in the same queue for manual inspection.

**Monitoring**: Check the RabbitMQ management UI (typically at `http://localhost:15672`) to see messages in the dead letter queue.

## Job Cancellation

### Cancelling Pending or Queued Jobs

**API endpoint**: `POST /api/admin/jobs/:id/cancel`

**Role required**: Administrator

Only jobs in `pending` or `queued` status can be cancelled. The job status is set to `cancelled` with a `completed_at` timestamp. If the worker picks up a cancelled job from the queue, it skips execution and acknowledges the message.

Attempting to cancel a `running`, `completed`, or `failed` job returns a validation error.

### Running Job Cancellation

Running jobs are cancelled through the `AbortController` pattern. When the worker shuts down gracefully or when `stop()` is called:

1. All active jobs' abort controllers are triggered
2. Handlers that check `context.signal.aborted` will stop work
3. The worker waits up to 30 seconds for active jobs to complete before exiting

There is no API endpoint to cancel a running job directly. The abort mechanism is only triggered during worker shutdown.

## Admin API Reference

All job admin endpoints require the `Administrator` role.

### List Jobs

```
GET /api/admin/jobs?status=running&type=conversion.cad.step-to-stl&limit=100&offset=0
```

**Query parameters**:

| Parameter | Type   | Description                                                                           |
| --------- | ------ | ------------------------------------------------------------------------------------- |
| `status`  | string | Filter by status (`pending`, `queued`, `running`, `completed`, `failed`, `cancelled`) |
| `type`    | string | Filter by job type                                                                    |
| `limit`   | number | Results per page (default: 100)                                                       |
| `offset`  | number | Pagination offset (default: 0)                                                        |

**Response**:

```json
{
  "data": {
    "jobs": [
      {
        "id": "...",
        "type": "conversion.cad.step-to-stl",
        "status": "running",
        "priority": "normal",
        "progress": 45,
        "progressMessage": "Converting faces...",
        "createdAt": "2026-03-27T10:00:00Z",
        "startedAt": "2026-03-27T10:00:05Z"
      }
    ],
    "total": 1
  }
}
```

### Get Job Detail

```
GET /api/admin/jobs/:id
```

Returns the full job record including payload, result, and all log entries.

**Response**:

```json
{
  "data": {
    "job": {
      "id": "...",
      "type": "design.clone",
      "status": "completed",
      "payload": { "designId": "...", "newName": "Copy of Design" },
      "result": { "newDesignId": "..." },
      "progress": 100,
      "attempts": 1,
      "maxAttempts": 2
    },
    "logs": [
      {
        "level": "info",
        "message": "Starting design clone",
        "createdAt": "..."
      },
      { "level": "info", "message": "Cloned 42 items", "createdAt": "..." },
      { "level": "info", "message": "Clone complete", "createdAt": "..." }
    ]
  }
}
```

### Cancel Job

```
POST /api/admin/jobs/:id/cancel
```

Only works for `pending` or `queued` jobs. Returns `{ "data": { "success": true } }`.

### Retry Failed Job

```
POST /api/admin/jobs/:id/retry
```

Only works for `failed` jobs. Resets the job state (clears error, attempts, result, timestamps), then re-publishes to RabbitMQ. Returns the updated job record.

## Progress Tracking

Handlers report progress through the `JobContext`:

```typescript
await context.updateProgress(25, 'Processing geometry...')
await context.updateProgress(50, 'Generating mesh...')
await context.updateProgress(75, 'Writing output file...')
```

Progress is persisted to the database (the `progress` and `progress_message` columns) and can be polled via the admin job detail endpoint or by fetching the job by ID.

## Graceful Shutdown

The worker process handles `SIGTERM` and `SIGINT` signals for graceful shutdown:

1. Stop consuming new messages from the queue
2. Signal all active jobs to abort (via `AbortController`)
3. Wait up to 30 seconds for active jobs to complete
4. Close the RabbitMQ connection
5. Exit the process

This ensures that in-progress jobs are not abruptly killed during deployments or scaling operations. Docker orchestrators (Compose, Kubernetes) send `SIGTERM` and wait for the configured stop grace period.

## Operational Checklist

### Starting the Jobs System

1. Start RabbitMQ: `docker compose up -d rabbitmq`
2. Start the worker: `docker compose --profile dev up jobs-worker-dev -d`
3. Verify the worker connects: `docker logs cascadia-jobs-worker-dev`
4. Check RabbitMQ management UI at `http://localhost:15672` (default credentials: `guest`/`guest`)

### Monitoring

- **Worker logs**: `docker logs -f cascadia-jobs-worker-dev`
- **RabbitMQ UI**: Queue depths, message rates, consumer status
- **Job list API**: `GET /api/admin/jobs?status=failed` to check for failures
- **Dead letter queue**: Check `jobs.dead-letter` in RabbitMQ UI for unprocessable messages

### Common Issues

**Jobs stuck in `queued` status**: The worker is not running or cannot connect to RabbitMQ. Check worker logs and RabbitMQ connectivity.

**Jobs stuck in `pending` with `next_retry_at` set**: The retry scheduler needs to re-publish these jobs. This happens automatically when the worker checks for retryable jobs.

**Dead letter queue growing**: Messages in the DLQ indicate either unregistered job types or malformed messages. Inspect the messages in the RabbitMQ UI to diagnose.

**Worker not picking up code changes**: The dev worker uses `tsx` without file watching. Restart the container: `docker compose --profile dev restart jobs-worker-dev`.
