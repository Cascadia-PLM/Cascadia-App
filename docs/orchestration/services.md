# Services Reference

This document describes each deployable service in the Cascadia PLM system.

## Service Summary

| Service          | Image                   | Purpose                | Required   |
| ---------------- | ----------------------- | ---------------------- | ---------- |
| `cascadia-app`   | `ghcr.io/cascadia-plm/cascadia-app`          | Core web application   | Yes        |
| `cascadia-vault` | `cascadia/vault`        | File storage service   | Optional\* |
| `cascadia-jobs`  | `ghcr.io/cascadia-plm/cascadia-jobs-worker`         | Background job workers | Optional   |
| `postgres`       | `postgres:18-alpine`    | Database               | Yes        |
| `rabbitmq`       | `rabbitmq:3-management` | Message broker         | With Jobs  |
| `minio`          | `minio/minio`           | S3-compatible storage  | Optional   |

\*Vault can be embedded in Core App or run separately.

---

## Core App (`cascadia-app`)

The main Cascadia application providing all PLM functionality.

### Responsibilities

- Web user interface (React/Vite SPA with TanStack Router)
- REST API endpoints
- User authentication and session management
- Item CRUD (Parts, Documents, Change Orders, Projects, Requirements, Tasks)
- Workflow/lifecycle state management
- Reporting engine
- Permission enforcement

### Image Build

```bash
docker build -t ghcr.io/cascadia-plm/cascadia-app -f docker/app.Dockerfile .
```

### Environment Variables

| Variable            | Required     | Default                 | Description                          |
| ------------------- | ------------ | ----------------------- | ------------------------------------ |
| `DATABASE_URL`      | Yes          | -                       | PostgreSQL connection string         |
| `SESSION_SECRET`    | Yes          | -                       | 32+ character secret for sessions    |
| `BASE_URL`          | No           | `http://localhost:3000` | Public URL for the app               |
| `NODE_ENV`          | No           | `production`            | Environment mode                     |
| `VAULT_MODE`        | No           | `embedded`              | `embedded` or `service`              |
| `VAULT_SERVICE_URL` | If `service` | -                       | URL to vault service                 |
| `JOBS_MODE`         | No           | `embedded`              | `embedded`, `service`, or `disabled` |
| `RABBITMQ_URL`      | If Jobs      | -                       | AMQP connection string               |

### Ports

- `3000` - HTTP (main application)

### Health Check

```
GET /api/health
```

### Volumes

- `/app/storage` - Local file storage (if vault embedded)
- `/app/vault` - Vault files (if vault embedded)

### Dependencies

- PostgreSQL (required)
- RabbitMQ (if using external jobs service)
- Vault Service (if `VAULT_MODE=service`)

---

## Vault Service (`cascadia-vault`)

Optional standalone service for file management. When deployed separately, the Core App delegates file operations to this service.

### Responsibilities

- File upload and download
- Check-out/check-in workflow
- Version management
- Storage abstraction (local, S3, Azure Blob)
- Thumbnail generation hooks

### When to Separate

- High file I/O workloads
- Need for dedicated storage infrastructure
- Integration with enterprise content management
- Compliance requirements for file isolation

### Image Build

```bash
docker build -t cascadia/vault -f docker/vault.Dockerfile .
```

### Environment Variables

| Variable        | Required | Default      | Description                     |
| --------------- | -------- | ------------ | ------------------------------- |
| `DATABASE_URL`  | Yes      | -            | PostgreSQL connection string    |
| `STORAGE_TYPE`  | No       | `local`      | `local`, `s3`, `azure`          |
| `STORAGE_PATH`  | If local | `/app/vault` | Local storage directory         |
| `S3_BUCKET`     | If s3    | -            | S3 bucket name                  |
| `S3_REGION`     | If s3    | -            | AWS region                      |
| `S3_ACCESS_KEY` | If s3    | -            | AWS access key ID               |
| `S3_SECRET_KEY` | If s3    | -            | AWS secret access key           |
| `S3_ENDPOINT`   | If s3    | -            | Custom endpoint (MinIO)         |
| `SERVICE_TOKEN` | Yes      | -            | Shared secret for Core App auth |

### Ports

- `3001` - HTTP (internal API)

### Health Check

```
GET /health
```

### Volumes (if local storage)

- `/app/vault` - File storage root

### API Endpoints

Internal API consumed by Core App:

```
POST   /files              # Upload file
GET    /files/:id          # Download file
GET    /files/:id/metadata # Get file metadata
POST   /files/:id/checkout # Check out file
POST   /files/:id/checkin  # Check in new version
DELETE /files/:id          # Soft delete file
GET    /files/:id/versions # List versions
```

---

## Jobs Server (`cascadia-jobs`)

Background job processing service for async operations.

### Responsibilities

- File format conversions
- Long-running computations (BOM rollup, impact analysis)
- Scheduled tasks (cleanup, archival)
- Integration sync (ERP push, external APIs)
- Email notifications

### When to Separate

- Heavy file conversion workloads
- Need to scale workers independently
- Dedicated hardware for licensed converters
- Isolate resource-intensive operations from web tier

### Development Setup

For local development on Windows, the jobs worker **must** run inside Docker due to a Docker Desktop networking limitation with AMQP authentication.

Start the development worker:

```bash
# Start RabbitMQ and the dev worker
docker compose up -d rabbitmq
docker compose --profile dev up jobs-worker-dev -d

# Check worker logs
docker logs -f cascadia-jobs-worker-dev
```

The dev worker:

- Mounts source code for hot reloading via `tsx watch`
- Uses `host.docker.internal` to reach PostgreSQL on the host
- Connects to RabbitMQ on the Docker network

If running PostgreSQL in Docker too, set `POSTGRES_HOST=postgres` in `.env`.

### Image Build

```bash
docker build -t ghcr.io/cascadia-plm/cascadia-jobs-worker -f workers/node/Dockerfile .
```

### Environment Variables

| Variable             | Required    | Default | Description                          |
| -------------------- | ----------- | ------- | ------------------------------------ |
| `DATABASE_URL`       | Yes         | -       | PostgreSQL connection string         |
| `RABBITMQ_URL`       | Yes         | -       | AMQP connection string               |
| `VAULT_SERVICE_URL`  | If external | -       | Vault service URL                    |
| `WORKER_CONCURRENCY` | No          | `5`     | Max concurrent jobs                  |
| `JOB_TYPES`          | No          | `*`     | Comma-separated job types to process |

### Worker Specialization

Run multiple instances with different `JOB_TYPES` for specialization:

```bash
# General worker
JOB_TYPES=reports,notifications,cleanup

# Conversion worker (dedicated hardware)
JOB_TYPES=conversion.cad,conversion.office
```

### Health Check

```
GET /health
```

Returns worker status and queue depth.

### Dependencies

- PostgreSQL (required)
- RabbitMQ (required)
- Vault Service or S3 (for file access)

---

## PostgreSQL Database

The central data store for all Cascadia services.

### Deployment Options

#### Self-Hosted (Docker)

```yaml
postgres:
  image: postgres:18-alpine
  environment:
    POSTGRES_DB: cascadia
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
  volumes:
    - postgres_data:/var/lib/postgresql/data
```

#### AWS RDS

```
DATABASE_URL=postgresql://user:pass@myinstance.region.rds.amazonaws.com:5432/cascadia?sslmode=require
```

#### Google Cloud SQL

```
DATABASE_URL=postgresql://user:pass@/cascadia?host=/cloudsql/project:region:instance
```

#### Azure Database for PostgreSQL

```
DATABASE_URL=postgresql://user:pass@server.postgres.database.azure.com:5432/cascadia?sslmode=require
```

### Requirements

- PostgreSQL 18 or higher
- 1GB+ RAM recommended
- SSD storage recommended

### Schema Management

All services share the same database schema. Migrations run from Core App:

```bash
# Apply schema changes
docker exec cascadia-app npx drizzle-kit push

# Generate migration files
docker exec cascadia-app npx drizzle-kit generate
```

---

## RabbitMQ (Message Broker)

Required when Jobs Server runs separately from Core App.

### Deployment

```yaml
rabbitmq:
  image: rabbitmq:3-management-alpine
  environment:
    RABBITMQ_DEFAULT_USER: cascadia
    RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD}
  ports:
    - '5672:5672' # AMQP
    - '15672:15672' # Management UI
  volumes:
    - rabbitmq_data:/var/lib/rabbitmq
```

### Connection String

```
RABBITMQ_URL=amqp://cascadia:password@rabbitmq:5672
```

### Queue Structure

```
Exchange: jobs.topic (topic exchange)

Queues:
  jobs.conversion.cad      - CAD file conversions
  jobs.conversion.office   - Office document conversions
  jobs.reports             - Report generation
  jobs.integration         - External system sync
  jobs.maintenance         - Cleanup and archival
  jobs.dlx                 - Dead letter queue
```

---

## MinIO (S3-Compatible Storage)

Optional object storage for file vault when not using local storage or cloud S3.

### Deployment

```yaml
minio:
  image: minio/minio
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: cascadia
    MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
  ports:
    - '9000:9000' # API
    - '9001:9001' # Console
  volumes:
    - minio_data:/data
```

### Configuration

```bash
# For Vault Service
STORAGE_TYPE=s3
S3_BUCKET=cascadia-vault
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=cascadia
S3_SECRET_KEY=${MINIO_PASSWORD}
S3_FORCE_PATH_STYLE=true  # Required for MinIO
```

---

## Service Communication Matrix

| From          | To            | Protocol  | Purpose         |
| ------------- | ------------- | --------- | --------------- |
| Core App      | PostgreSQL    | TCP/5432  | Data storage    |
| Core App      | Vault Service | HTTP/3001 | File operations |
| Core App      | RabbitMQ      | AMQP/5672 | Job submission  |
| Vault Service | PostgreSQL    | TCP/5432  | File metadata   |
| Vault Service | S3/MinIO      | HTTP/9000 | File storage    |
| Jobs Server   | PostgreSQL    | TCP/5432  | Job records     |
| Jobs Server   | RabbitMQ      | AMQP/5672 | Job consumption |
| Jobs Server   | Vault Service | HTTP/3001 | File access     |
