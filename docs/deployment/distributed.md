# Distributed Services Deployment

Run Cascadia as separate services across multiple servers: a shared infrastructure tier (PostgreSQL, RabbitMQ, MinIO), one or more app servers, and dedicated job workers.

## When to Use

- High availability requirements
- 50+ concurrent users
- Need to scale the app tier and job workers independently
- Heavy file processing workloads (CAD conversion, report generation)
- Geographic distribution of services
- Dedicated hardware for licensed converters or GPU-accelerated processing

## Architecture

```
+-----------------+    +-----------------+    +-----------------+
|  App Server A   |    |  App Server B   |    |  Jobs Server    |
|  +-----------+  |    |  +-----------+  |    |  +-----------+  |
|  | Core App  |  |    |  | Core App  |  |    |  |   Jobs    |  |
|  |   :3000   |  |    |  |   :3000   |  |    |  |  Workers  |  |
|  +-----+-----+  |    |  +-----+-----+  |    |  +-----+-----+  |
+---------+--------+    +---------+--------+    +---------+--------+
          |                       |                       |
          +----------+------------+-----------------------+
                     |
+--------------------v----------------------------------------+
|                    Shared Services                           |
|                                                             |
|  +-----------+  +-----------+  +-----------+                |
|  | PostgreSQL|  | RabbitMQ  |  | MinIO/S3  |                |
|  |   :5432   |  |   :5672   |  |   :9000   |                |
|  +-----------+  +-----------+  +-----------+                |
|                                                             |
|  Infrastructure Server                                      |
+-------------------------------------------------------------+
```

## Components

### Infrastructure Server

Hosts the shared stateful services that all other components connect to:

- **PostgreSQL 18** -- single source of truth for all data
- **RabbitMQ** -- message broker for async job processing
- **MinIO** -- S3-compatible object storage for the file vault (optional if using cloud S3)

### App Servers (1-N)

Stateless application instances behind a load balancer:

- Serve the web UI and REST API
- Connect to PostgreSQL on the infrastructure server
- Submit jobs to RabbitMQ on the infrastructure server
- Read/write files to MinIO/S3 on the infrastructure server
- Use `VAULT_MODE=embedded` with `VAULT_TYPE=s3` so each app instance accesses shared storage without a separate vault service

### Jobs Servers (1-N)

Background task processing workers:

- Consume jobs from RabbitMQ queues
- Connect to PostgreSQL for job records and item data
- Access files via S3/MinIO
- Scale based on queue depth
- Can be specialized by job type (e.g., dedicated CAD conversion workers)

## Deployment Steps

### Step 1: Infrastructure Server

```bash
cd docs/orchestration/deployments/distributed/infrastructure/
cp .env.example .env
```

Edit `.env` with strong passwords:

```bash
POSTGRES_PASSWORD=<strong-random-password>
RABBITMQ_PASSWORD=<strong-random-password>
MINIO_PASSWORD=<strong-random-password>
```

Start the infrastructure services:

```bash
docker compose up -d
```

Verify all services are healthy:

```bash
docker compose ps
```

Optionally start pgAdmin for database management:

```bash
docker compose --profile tools up -d
```

#### Infrastructure Compose File

```yaml
services:
  postgres:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-cascadia}
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
    ports:
      - '${POSTGRES_PORT:-5432}:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    command: >
      postgres
      -c listen_addresses='*'
      -c max_connections=200
      -c shared_buffers=256MB

  rabbitmq:
    image: rabbitmq:3-management-alpine
    restart: unless-stopped
    environment:
      RABBITMQ_DEFAULT_USER: ${RABBITMQ_USER:-cascadia}
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD:?RABBITMQ_PASSWORD is required}
      RABBITMQ_DEFAULT_VHOST: ${RABBITMQ_VHOST:-cascadia}
    ports:
      - '${RABBITMQ_PORT:-5672}:5672'
      - '${RABBITMQ_MGMT_PORT:-15672}:15672'
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: ${MINIO_USER:-cascadia}
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD:?MINIO_PASSWORD is required}
    ports:
      - '${MINIO_API_PORT:-9000}:9000'
      - '${MINIO_CONSOLE_PORT:-9001}:9001'
    volumes:
      - minio_data:/data
    command: server /data --console-address ":9001"
```

Note that PostgreSQL is configured with `listen_addresses='*'` and `max_connections=200` to accept connections from remote app and jobs servers.

### Step 2: Initialize the Database

Before starting any app servers, push the schema to PostgreSQL:

```bash
# From your development machine, with DATABASE_URL pointing to the infrastructure server
DATABASE_URL=postgresql://postgres:<password>@<infra-host>:5432/cascadia npx drizzle-kit push
```

Or let the first app server handle it on startup (the compose command includes `drizzle-kit push`).

### Step 3: Create the MinIO Bucket

Access the MinIO console at `http://<infra-host>:9001` and create a bucket named `cascadia-vault`. Or use the MinIO client:

```bash
mc alias set cascadia http://<infra-host>:9000 cascadia <minio-password>
mc mb cascadia/cascadia-vault
```

### Step 4: App Servers

On each app server:

```bash
cd docs/orchestration/deployments/distributed/app/
cp .env.example .env
```

Edit `.env`, pointing all URLs to the infrastructure server:

```bash
SESSION_SECRET=<same-secret-across-all-app-servers>
DATABASE_URL=postgresql://postgres:<password>@<infra-host>:5432/cascadia
RABBITMQ_URL=amqp://cascadia:<password>@<infra-host>:5672/cascadia
S3_ENDPOINT=http://<infra-host>:9000
S3_ACCESS_KEY=cascadia
S3_SECRET_KEY=<minio-password>
BASE_URL=https://plm.example.com
```

**Important**: `SESSION_SECRET` must be identical on all app servers so sessions are portable across the load balancer.

Start the app:

```bash
docker compose up -d
```

### Step 5: Jobs Servers

On each jobs server:

```bash
cd docs/orchestration/deployments/distributed/jobs/
cp .env.example .env
```

Edit `.env` with the same infrastructure URLs:

```bash
DATABASE_URL=postgresql://postgres:<password>@<infra-host>:5432/cascadia
RABBITMQ_URL=amqp://cascadia:<password>@<infra-host>:5672/cascadia
S3_ENDPOINT=http://<infra-host>:9000
S3_ACCESS_KEY=cascadia
S3_SECRET_KEY=<minio-password>
WORKER_CONCURRENCY=5
JOB_TYPES=*
WORKER_REPLICAS=2
```

Start the workers:

```bash
docker compose up -d
```

### Step 6: Load Balancer

Configure a load balancer (Nginx, HAProxy, AWS ALB, etc.) to distribute traffic across app servers.

Example Nginx configuration:

```nginx
upstream cascadia_app {
    server app-server-1:3000;
    server app-server-2:3000;
}

server {
    listen 443 ssl;
    server_name plm.example.com;

    ssl_certificate /etc/ssl/certs/plm.crt;
    ssl_certificate_key /etc/ssl/private/plm.key;

    # Allow large file uploads
    client_max_body_size 500m;

    location / {
        proxy_pass http://cascadia_app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support for design engine streaming
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
}
```

## Worker Specialization

Run dedicated worker instances for different job types to isolate resource-intensive operations:

```bash
# General worker (reports, notifications, cleanup)
JOB_TYPES=reports,notifications,cleanup WORKER_CONCURRENCY=5 docker compose up -d

# CAD conversion worker (dedicated hardware with more memory)
JOB_TYPES=conversion.cad WORKER_CONCURRENCY=2 docker compose up -d
```

Or uncomment the specialized worker sections in the jobs `docker-compose.yml`:

```yaml
worker-cad:
  image: cascadia/jobs:${JOBS_VERSION:-latest}
  environment:
    WORKER_CONCURRENCY: 2
    JOB_TYPES: conversion.cad
  deploy:
    replicas: 1
```

## Scaling

### Add App Servers

Deploy the app compose file on a new server, configure it with the same `.env` values, and add it to the load balancer.

### Scale Job Workers

```bash
# Add more worker containers on the same server
docker compose up -d --scale worker=3

# Or deploy on additional servers
```

### Database Scaling

For read-heavy workloads:

1. Add PostgreSQL streaming read replicas
2. Configure PgBouncer for connection pooling:

```yaml
pgbouncer:
  image: edoburu/pgbouncer
  environment:
    DATABASE_URL: postgresql://postgres:<password>@postgres:5432/cascadia
    POOL_MODE: transaction
    MAX_CLIENT_CONN: 1000
    DEFAULT_POOL_SIZE: 50
  ports:
    - '6432:5432'
```

Point `DATABASE_URL` in app servers to PgBouncer instead of directly to PostgreSQL.

## Network Security

- **PostgreSQL** (5432): Allow inbound only from app servers and jobs servers.
- **RabbitMQ** (5672): Allow inbound only from app servers and jobs servers. The management UI (15672) should be restricted to admin access.
- **MinIO** (9000): Allow inbound only from app servers and jobs servers. The console (9001) should be restricted to admin access.
- **App** (3000): Expose only through the load balancer. Do not expose directly to the internet.

Use TLS for all inter-service communication in production:

```bash
DATABASE_URL=postgresql://...?sslmode=require
```

## File Structure

```
distributed/
+-- infrastructure/
|   +-- docker-compose.yml   # PostgreSQL, RabbitMQ, MinIO
|   +-- .env.example
+-- app/
|   +-- docker-compose.yml   # Core App only
|   +-- .env.example
+-- jobs/
|   +-- docker-compose.yml   # Jobs workers only
|   +-- .env.example
+-- README.md
```

## Monitoring

### RabbitMQ Management UI

Access at `http://<infra-host>:15672` to monitor queue depths, message rates, and consumer status.

### Health Checks

All services expose health endpoints:

- App: `GET http://<app-host>:3000/api/health`
- Jobs workers: `GET http://<jobs-host>:3002/health`
- MinIO: `GET http://<infra-host>:9000/minio/health/live`
- PostgreSQL: `pg_isready -U postgres -d cascadia`
- RabbitMQ: `rabbitmq-diagnostics check_port_connectivity`

### Correlation IDs

Track requests across services by passing the `X-Correlation-ID` header from the load balancer through to downstream services. All services log with this ID for distributed tracing.

## Troubleshooting

### App Cannot Reach Infrastructure

Verify network connectivity from the app server:

```bash
# Test PostgreSQL
docker compose exec app node -e "require('net').connect(5432, '<infra-host>').on('connect', () => {console.log('ok'); process.exit(0)})"

# Test RabbitMQ
docker compose exec app node -e "require('net').connect(5672, '<infra-host>').on('connect', () => {console.log('ok'); process.exit(0)})"
```

### Workers Not Processing Jobs

1. Check RabbitMQ management UI for queue consumers
2. Verify `RABBITMQ_URL` is correct in the jobs `.env`
3. Check worker logs: `docker compose logs -f worker`

### S3/MinIO Access Denied

Verify the bucket exists and credentials match between the infrastructure `.env` (`MINIO_USER`/`MINIO_PASSWORD`) and the app/jobs `.env` (`S3_ACCESS_KEY`/`S3_SECRET_KEY`).
