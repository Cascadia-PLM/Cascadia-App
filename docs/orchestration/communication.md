# Inter-Service Communication

This document describes how Cascadia services communicate when deployed in a distributed architecture.

## Communication Patterns

### Synchronous (HTTP/REST)

Used for: Real-time operations that need immediate response.

```
Core App ──HTTP──► Vault Service    (file upload/download)
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
      VAULT_SERVICE_URL: http://vault:3001
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
```

### Kubernetes

Services discovered via DNS:

```yaml
env:
  - name: DATABASE_URL
    value: postgresql://user:pass@postgres-service.cascadia.svc.cluster.local:5432/cascadia
  - name: VAULT_SERVICE_URL
    value: http://vault-service.cascadia.svc.cluster.local:3001
  - name: RABBITMQ_URL
    value: amqp://user:pass@rabbitmq-service.cascadia.svc.cluster.local:5672
```

### Environment Variables (Any Platform)

All service URLs are configurable via environment:

| Variable            | Purpose                | Default              |
| ------------------- | ---------------------- | -------------------- |
| `DATABASE_URL`      | PostgreSQL connection  | Required             |
| `VAULT_SERVICE_URL` | External vault service | None (embedded)      |
| `RABBITMQ_URL`      | Message broker         | None (jobs disabled) |
| `REDIS_URL`         | Cache layer            | None (no cache)      |

## Core App ↔ Vault Service

When vault runs as a separate service, Core App delegates file operations.

### Authentication

Services authenticate using a shared secret token:

```bash
# Vault Service
SERVICE_TOKEN=your-secret-token-here

# Core App
VAULT_SERVICE_URL=http://vault:3001
VAULT_SERVICE_TOKEN=your-secret-token-here
```

### API Contract

#### Upload File

```http
POST /files
Authorization: Bearer ${SERVICE_TOKEN}
Content-Type: multipart/form-data

file: (binary)
itemId: uuid
filename: string
mimeType: string
createdBy: uuid
```

Response:

```json
{
  "id": "file-uuid",
  "filename": "drawing.pdf",
  "version": 1,
  "size": 1048576,
  "checksum": "sha256:abc123..."
}
```

#### Download File

```http
GET /files/:fileId
Authorization: Bearer ${SERVICE_TOKEN}
```

Response: Binary file stream with headers:

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="drawing.pdf"
Content-Length: 1048576
```

#### Check Out

```http
POST /files/:fileId/checkout
Authorization: Bearer ${SERVICE_TOKEN}
Content-Type: application/json

{
  "userId": "user-uuid"
}
```

#### Check In (New Version)

```http
POST /files/:fileId/checkin
Authorization: Bearer ${SERVICE_TOKEN}
Content-Type: multipart/form-data

file: (binary)
userId: uuid
comment: string
```

### Error Handling

Vault service errors are propagated to Core App:

```json
{
  "error": "FILE_NOT_FOUND",
  "message": "File with ID xyz not found",
  "statusCode": 404
}
```

Core App should:

1. Log the error with correlation ID
2. Return appropriate user-facing message
3. Not expose internal service details

### Retry Policy

```typescript
const vaultClient = {
  maxRetries: 3,
  retryDelay: [100, 500, 2000], // Exponential backoff
  timeout: 30000, // 30 seconds for uploads
  retryOn: [502, 503, 504], // Gateway errors only
}
```

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
GET /api/jobs/:id
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

| Table         | Writers       | Readers        |
| ------------- | ------------- | -------------- |
| `items`       | Core App      | All            |
| `vault_files` | Vault Service | All            |
| `jobs`        | Jobs Server   | Core App       |
| `sessions`    | Core App      | All (for auth) |

### Consistency Model

- **Strong consistency** within single service operations
- **Eventual consistency** across service boundaries

Example: File upload

1. Vault Service stores file, creates `vault_files` record
2. Core App links file to item via `item_id` in vault record
3. Both see consistent state after transaction commits

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
  vault:
    networks:
      - internal # Internal only
  postgres:
    networks:
      - internal # Internal only
```

### TLS for Internal Traffic

In production, enable TLS between services:

```bash
# Vault Service with TLS
VAULT_SERVICE_URL=https://vault:3001
VAULT_TLS_CERT=/certs/vault.crt
VAULT_TLS_KEY=/certs/vault.key
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
    vault: vaultMode === 'service' ? await checkVaultService() : 'embedded',
    rabbitmq: jobsMode !== 'disabled' ? await checkRabbitMQ() : 'disabled',
  }

  const healthy = Object.values(checks).every(
    (c) => c === 'ok' || c === 'embedded' || c === 'disabled',
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

// Pass to downstream services
fetch(VAULT_SERVICE_URL + '/files', {
  headers: {
    'X-Correlation-ID': correlationId,
    Authorization: `Bearer ${SERVICE_TOKEN}`,
  },
})
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
