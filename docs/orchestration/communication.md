# Inter-Service Communication

This document describes how Cascadia services communicate when deployed in a distributed architecture.

## Communication Patterns

### Synchronous (HTTP/REST)

Used for: Real-time operations that need immediate response.

```
Core App ──HTTP──► S3 / MinIO       (vault file storage, if configured)
Core App ──HTTP──► External APIs    (OAuth, integrations)
```

### Asynchronous (Message Queue)

Used for: Background tasks, event-driven workflows.

```
Core App ──AMQP──► RabbitMQ ──AMQP──► Jobs Server
```

### Database-Mediated

Used for: Shared state, eventual consistency.

```
All Services ──SQL──► PostgreSQL ──SQL──► All Services
```

## Service Discovery

### Docker Compose (Default)

Services discover each other by container name:

```yaml
services:
  app:
    environment:
      DATABASE_URL: postgresql://postgres:pass@postgres:5432/cascadia
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
```

### Kubernetes

Services discovered via DNS:

```yaml
env:
  - name: DATABASE_URL
    value: postgresql://user:pass@postgres-service.cascadia.svc.cluster.local:5432/cascadia
  - name: RABBITMQ_URL
    value: amqp://user:pass@rabbitmq-service.cascadia.svc.cluster.local:5672
```

### Environment Variables (Any Platform)

All service URLs are configurable via environment:

| Variable       | Purpose               | Default              |
| -------------- | --------------------- | -------------------- |
| `DATABASE_URL` | PostgreSQL connection | Required             |
| `RABBITMQ_URL` | Message broker        | None (jobs disabled) |
| `REDIS_URL`    | Cache layer           | None (no cache)      |

File storage is embedded in the Core App — it talks directly to local disk or
S3-compatible storage (`VAULT_TYPE`, `S3_*` variables), not to a separate
vault service.

## Core App ↔ Jobs Server

Communication via RabbitMQ for asynchronous task processing.

### Message Flow

```
┌──────────┐         ┌───────────┐         ┌──────────┐
│ Core App │──emit──►│ RabbitMQ  │──consume─│ Jobs     │
│          │         │           │          │ Server   │
│          │◄──poll──│           │◄──ack────│          │
└──────────┘         └───────────┘         └──────────┘
      │                                          │
      └──────────────── PostgreSQL ──────────────┘
                    (job status updates)
```

### Job Submission

Core App publishes to RabbitMQ and creates database record:

```typescript
// Core App submits job
async function submitJob(type: string, payload: object) {
  // 1. Create job record in database
  const job = await db
    .insert(jobs)
    .values({
      id: generateId(),
      type,
      payload,
      status: 'pending',
      createdBy: currentUser.id,
    })
    .returning()

  // 2. Publish to RabbitMQ
  await rabbitmq.publish('jobs.topic', type, {
    jobId: job.id,
    type,
    attemptNumber: 1,
  })

  return job
}
```

### Job Processing

Jobs Server consumes from queues and updates database:

```typescript
// Jobs Server processes job
async function processJob(message: JobMessage) {
  const job = await db.query.jobs.findFirst({
    where: eq(jobs.id, message.jobId),
  })

  // Update status to running
  await db
    .update(jobs)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(jobs.id, job.id))

  try {
    const result = await executeJob(job.type, job.payload)

    // Mark completed
    await db
      .update(jobs)
      .set({ status: 'completed', result, completedAt: new Date() })
      .where(eq(jobs.id, job.id))
  } catch (error) {
    // Mark failed, potentially retry
    await db
      .update(jobs)
      .set({
        status: 'failed',
        error: error.message,
        attempts: job.attempts + 1,
      })
      .where(eq(jobs.id, job.id))

    if (job.attempts < job.maxAttempts) {
      // Re-queue with delay
      await rabbitmq.publish(
        'jobs.retry',
        job.type,
        {
          jobId: job.id,
          attemptNumber: job.attempts + 1,
        },
        { delay: calculateBackoff(job.attempts) },
      )
    }
  }
}
```

### Status Polling

Core App queries database for job status:

```typescript
// Polling endpoint
GET /api/v1/jobs/:id
{
  "id": "job-uuid",
  "type": "conversion.pdf",
  "status": "running",
  "progress": 45,
  "progressMessage": "Converting page 3 of 7"
}
```

### Real-Time Updates (Future)

For real-time progress, consider:

1. **Server-Sent Events** - Simple, one-way streaming
2. **WebSockets** - Two-way, more complex
3. **Polling with smart intervals** - Start fast, slow down

## Database as Communication Channel

Services share state through PostgreSQL. This is the source of truth.

### Shared Tables

| Table         | Writers     | Readers        |
| ------------- | ----------- | -------------- |
| `items`       | Core App    | All            |
| `vault_files` | Core App    | All            |
| `jobs`        | Jobs Server | Core App       |
| `sessions`    | Core App    | All (for auth) |

### Consistency Model

- **Strong consistency** within single service operations
- **Eventual consistency** across service boundaries

Example: File upload

1. Core App stores the file through the embedded vault, creates a `vault_files` record
2. Core App links the file to an item via `item_id` in the vault record
3. Jobs workers see consistent state after the transaction commits

### Avoiding Conflicts

1. **Ownership model** - Each table has one primary writer
2. **Optimistic locking** - Use `updated_at` for concurrent updates
3. **Event sourcing** - For audit-critical operations

## Network Security

### Internal Network

All inter-service communication should occur on a private network:

```yaml
# Docker Compose
networks:
  internal:
    driver: bridge
    internal: true # No external access
  external:
    driver: bridge

services:
  app:
    networks:
      - internal
      - external # Serves web traffic
  postgres:
    networks:
      - internal # Internal only
```

### TLS for Internal Traffic

In production, enable TLS between services:

```bash
# PostgreSQL with TLS
DATABASE_URL=postgresql://user:pass@db-host:5432/cascadia?sslmode=require
```

### Service Mesh (Kubernetes)

For advanced scenarios, use Istio or Linkerd:

- Automatic mTLS between services
- Traffic policies and rate limiting
- Distributed tracing
- Circuit breaking

## Health Checks and Resilience

### Circuit Breaker Pattern

Prevent cascade failures when a service is down:

```typescript
const circuitBreaker = {
  failureThreshold: 5, // Open after 5 failures
  resetTimeout: 30000, // Try again after 30s
  halfOpenRequests: 1, // Test with 1 request
}

// States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (testing)
```

### Health Check Endpoints

All services expose health endpoints:

```http
GET /health
{
  "status": "healthy",
  "version": "1.0.0",
  "checks": {
    "database": "ok",
    "rabbitmq": "ok",
    "storage": "ok"
  }
}
```

### Dependency Health

Core App should check downstream services:

```typescript
async function healthCheck() {
  const checks = {
    database: await checkDatabase(),
    rabbitmq: jobsMode !== 'disabled' ? await checkRabbitMQ() : 'disabled',
  }

  const healthy = Object.values(checks).every(
    (c) => c === 'ok' || c === 'disabled',
  )

  return { status: healthy ? 'healthy' : 'degraded', checks }
}
```

## Monitoring and Observability

### Correlation IDs

Track requests across services:

```typescript
// Core App generates correlation ID
const correlationId = request.headers['x-correlation-id'] || generateId()

// Pass to downstream work — e.g. include it in job payloads
await rabbitmq.publish('jobs.topic', type, { jobId, correlationId })
```

### Structured Logging

All services log with correlation ID:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "service": "core-app",
  "correlationId": "abc123",
  "message": "File upload started",
  "fileId": "file-uuid",
  "userId": "user-uuid"
}
```

### Metrics (Future)

Prometheus metrics for each service:

- Request latency histograms
- Error rates by endpoint
- Queue depths
- Active connections
