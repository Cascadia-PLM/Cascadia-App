# Services Reference

This document describes each deployable service in the Cascadia PLM system.

## Service Summary

| Service         | Image                                       | Purpose                | Required  |
| --------------- | ------------------------------------------- | ---------------------- | --------- |
| `cascadia-app`  | `ghcr.io/cascadia-plm/cascadia-app`         | Core web application   | Yes       |
| `cascadia-jobs` | `ghcr.io/cascadia-plm/cascadia-jobs-worker` | Background job workers | Optional  |
| `postgres`      | `postgres:18-alpine`                        | Database               | Yes       |
| `rabbitmq`      | `rabbitmq:3-management`                     | Message broker         | With Jobs |
| `minio`         | `minio/minio`                               | S3-compatible storage  | Optional  |

File storage (the vault) runs inside the Core App process — see
[File Vault](#file-vault-embedded-in-core-app) below.

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

| Variable       | Required | Default                 | Description                                                                                                                         |
| -------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | Yes      | -                       | PostgreSQL connection string                                                                                                        |
| `BASE_URL`     | No       | `http://localhost:3000` | Public URL for the app                                                                                                              |
| `NODE_ENV`     | No       | `production`            | Environment mode                                                                                                                    |
| `VAULT_TYPE`   | No       | `local`                 | Vault storage backend: `local`, `s3`                                                                                                |
| `VAULT_ROOT`   | No       | `./vault`               | Root directory for local storage                                                                                                    |
| `JOBS_MODE`    | No       | —                       | Set by the compose templates only — the app reads no such variable. Run a separate jobs worker (or not); nothing else to configure. |
| `RABBITMQ_URL` | If Jobs  | -                       | AMQP connection string                                                                                                              |

Sessions are opaque random tokens stored hashed in the database — there is no
session-secret variable to set.

### Ports

- `3000` - HTTP (main application)

### Health Check

```
GET /api/v1/health
```

### Volumes

- `/app/storage` - General file storage
- `/app/vault` - Vault files (local storage backend)

### Dependencies

- PostgreSQL (required)
- RabbitMQ (if using external jobs service)

---

## File Vault (embedded in Core App)

File storage is part of the Core App process. The vault library
(`packages/core/src/lib/vault/`) handles upload/download, check-out/check-in,
version management, and storage abstraction — there is no separate vault
container to build or deploy.

Storage backends:

- **Local filesystem** (default) — `VAULT_TYPE=local`; the root directory
  resolves from the admin setting in the database, then `VAULT_ROOT`, then
  `./vault`.
- **S3-compatible** — `VAULT_TYPE=s3` with `S3_BUCKET`, `S3_REGION`,
  credentials, and an optional `S3_ENDPOINT` for MinIO.

To scale file I/O, scale the Core App horizontally and point every instance at
shared S3-compatible storage.

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

| Variable             | Required | Default | Description                          |
| -------------------- | -------- | ------- | ------------------------------------ |
| `DATABASE_URL`       | Yes      | -       | PostgreSQL connection string         |
| `RABBITMQ_URL`       | Yes      | -       | AMQP connection string               |
| `WORKER_CONCURRENCY` | No       | `5`     | Max concurrent jobs                  |
| `JOB_TYPES`          | No       | `*`     | Comma-separated job types to process |

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
- Shared vault volume or S3 (for file access)

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

All services share the same database schema, applied from Core App. Released
installs upgrade with the committed migrations (also run at boot):

```bash
# Apply committed migrations (the upgrade path)
docker exec cascadia-app npm run db:migrate

# Diff-apply the schema directly (dev/CI/demo only)
docker exec cascadia-app npm run db:push
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
# App vault on MinIO
VAULT_TYPE=s3
S3_BUCKET=cascadia-vault
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=cascadia
S3_SECRET_KEY=${MINIO_PASSWORD}
S3_FORCE_PATH_STYLE=true  # Required for MinIO
```

---

## Service Communication Matrix

| From        | To         | Protocol  | Purpose         |
| ----------- | ---------- | --------- | --------------- |
| Core App    | PostgreSQL | TCP/5432  | Data storage    |
| Core App    | S3/MinIO   | HTTP/9000 | File storage    |
| Core App    | RabbitMQ   | AMQP/5672 | Job submission  |
| Jobs Server | PostgreSQL | TCP/5432  | Job records     |
| Jobs Server | RabbitMQ   | AMQP/5672 | Job consumption |
| Jobs Server | S3/MinIO   | HTTP/9000 | File access     |
