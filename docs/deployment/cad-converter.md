# CAD Converter Service Deployment

The CAD converter is a Python microservice that converts STEP and IGES files into STL and GLB formats using pythonocc-core (the Python binding for OpenCASCADE). It runs as a RabbitMQ consumer, processing jobs submitted by the main Cascadia application.

## Overview

| Attribute      | Value                                                          |
| -------------- | -------------------------------------------------------------- |
| Language       | Python 3.11                                                    |
| CAD Engine     | pythonocc-core >= 7.7 (OpenCASCADE)                            |
| Message Broker | RabbitMQ (pika)                                                |
| Database       | PostgreSQL (psycopg)                                           |
| Configuration  | pydantic-settings                                              |
| Docker Base    | condaforge/miniforge3 (build) + debian:bookworm-slim (runtime) |
| Default Port   | 3003 (health check only)                                       |
| Source Path    | `workers/cad-converter/`                                       |

## What It Does

1. Consumes `jobs.conversion.cad.*` messages from RabbitMQ
2. Reads the source STEP/IGES file from the vault filesystem
3. Tessellates the CAD geometry into triangle meshes
4. Produces STL (mesh) and GLB (mesh with per-face colors) output files
5. Optionally decomposes assemblies into individual parts with transforms
6. Generates PNG thumbnails via offscreen OpenGL rendering (Xvfb)
7. Writes output files back to the vault and creates `vault_files` database records
8. Updates job status in the `jobs` table

## Architecture

```
+------------------+       +------------+       +------------------+
|  Cascadia App    | --->  |  RabbitMQ  | --->  |  CAD Converter   |
|  (submit job)    |       |  (queue)   |       |  (Python worker) |
+------------------+       +------------+       +--------+---------+
                                                         |
                                    +--------------------+----+
                                    |                         |
                              +-----v------+           +-----v------+
                              | PostgreSQL |           | Vault FS   |
                              | (job state)|           | (CAD files)|
                              +------------+           +------------+
```

## Prerequisites

- RabbitMQ running and accessible
- PostgreSQL running with the Cascadia schema
- Vault filesystem accessible (mounted volume)
- Docker (for containerized deployment)

## Docker Image Build

The Dockerfile uses a two-stage build to package the conda environment into a slim Debian runtime image.

### Stage 1: Build Environment

Uses `condaforge/miniforge3` to create a conda environment from `environment.yml`:

```yaml
name: cad-converter
channels:
  - conda-forge
  - defaults
dependencies:
  - python=3.11
  - pythonocc-core>=7.7
  - pip
  - pip:
      - pika>=1.3
      - 'psycopg[binary]>=3.1'
      - pydantic>=2.0
      - pydantic-settings>=2.0
      - pytest>=7.0
```

The environment is then packed with `conda-pack` into a portable tarball.

### Stage 2: Slim Runtime

Uses `debian:bookworm-slim` with only the runtime libraries needed for OpenCASCADE:

- `libgl1` -- OpenGL
- `libglib2.0-0` -- GLib
- `libgomp1` -- OpenMP (parallel tessellation)
- `libx11-6`, `libxext6`, `libxrender1` -- X11 (for Xvfb)
- `xvfb` -- Virtual framebuffer for offscreen rendering

The packed conda environment is extracted into `/venv` and added to PATH.

### Build Command

```bash
cd workers/cad-converter/
docker build -t cascadia/cad-converter .
```

Or from the project root using the development compose file:

```bash
docker compose --profile cad build cad-converter-dev
```

The resulting image is approximately 1-2 GB (mostly OpenCASCADE libraries).

## Entrypoint

The `entrypoint.sh` script:

1. Starts Xvfb (virtual framebuffer) on display `:99` with a 512x512x24 screen
2. Exports `DISPLAY=:99` so OpenGL operations use the virtual display
3. Launches `python -m cad_converter.main` with signal forwarding
4. Cleans up Xvfb on shutdown

Xvfb is required because pythonocc's thumbnail rendering uses OpenGL, which needs a display even in headless environments.

## Configuration

All configuration is via environment variables (case-insensitive, no prefix):

| Variable                  | Default                                                  | Description                                       |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `DATABASE_URL`            | `postgresql://postgres:postgres@localhost:5432/cascadia` | PostgreSQL connection string                      |
| `RABBITMQ_URL`            | `amqp://localhost:5672`                                  | RabbitMQ connection string                        |
| `VAULT_ROOT`              | `/vault`                                                 | Root directory for vault file storage             |
| `WORKER_CONCURRENCY`      | `2`                                                      | Maximum concurrent jobs (RabbitMQ prefetch count) |
| `JOB_TIMEOUT`             | `600000`                                                 | Job timeout in milliseconds (10 minutes)          |
| `HEALTH_PORT`             | `3003`                                                   | HTTP health check port                            |
| `MESH_LINEAR_DEFLECTION`  | `0.1`                                                    | Default tessellation linear deflection (mm)       |
| `MESH_ANGULAR_DEFLECTION` | `0.5`                                                    | Default tessellation angular deflection (rad)     |
| `STL_FORMAT`              | `binary`                                                 | STL output format: `binary` or `ascii`            |

## Development Setup

### Using Docker Compose (Recommended)

The root `docker-compose.yml` includes a development service:

```bash
# Start RabbitMQ first
docker compose up -d rabbitmq

# Start the CAD converter
docker compose --profile cad up cad-converter-dev -d

# Check logs
docker logs -f cascadia-cad-converter-dev
```

The development service:

- Builds from `workers/cad-converter/Dockerfile`
- Mounts the local `./vault` directory into the container at `/vault`
- Uses `host.docker.internal` for PostgreSQL when it runs on the host (set `POSTGRES_HOST=postgres` if PostgreSQL also runs in Docker)
- Exposes health check on port 3003

### CLI Mode (Local Testing)

The converter also supports standalone CLI conversion without RabbitMQ:

```bash
# From within the conda environment or container
python -m cad_converter.main convert input.step -o ./output/ -q standard
python -m cad_converter.main convert input.step -o ./output/ --decompose --quality high
python -m cad_converter.main convert input.iges -o ./output/ --ascii
```

CLI options:

- `-o, --output` -- Output directory (default: `./output`)
- `-q, --quality` -- Mesh quality: `preview`, `standard`, `high`
- `--decompose` -- Decompose assembly into individual parts
- `--ascii` -- Write ASCII STL instead of binary

## Production Deployment

### Standalone Container

```bash
docker run -d \
  --name cascadia-cad-converter \
  --restart unless-stopped \
  -e DATABASE_URL=postgresql://cascadia:PASSWORD@db-host:5432/cascadia \
  -e RABBITMQ_URL=amqp://cascadia:PASSWORD@rabbitmq-host:5672/cascadia \
  -e VAULT_ROOT=/vault \
  -e WORKER_CONCURRENCY=2 \
  -v /path/to/vault:/vault \
  -p 3003:3003 \
  cascadia/cad-converter
```

### In the Distributed Deployment

Add the CAD converter as an additional worker alongside the Node.js jobs workers. It consumes from the same RabbitMQ instance but binds to `jobs.conversion.cad.#` routing keys only.

```yaml
# Add to the jobs docker-compose.yml
cad-converter:
  image: cascadia/cad-converter:latest
  restart: unless-stopped
  environment:
    DATABASE_URL: ${DATABASE_URL}
    RABBITMQ_URL: ${RABBITMQ_URL}
    VAULT_ROOT: /vault
    WORKER_CONCURRENCY: 2
    HEALTH_PORT: 3003
  volumes:
    - vault_data:/vault
  healthcheck:
    test:
      [
        'CMD',
        'python',
        '-c',
        "import urllib.request; urllib.request.urlopen('http://localhost:3003/health')",
      ]
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 60s
```

### In Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cascadia-cad-converter
  namespace: cascadia
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cascadia-cad-converter
  template:
    metadata:
      labels:
        app: cascadia-cad-converter
    spec:
      containers:
        - name: cad-converter
          image: cascadia/cad-converter:latest
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: cascadia-secrets
                  key: database-url
            - name: RABBITMQ_URL
              valueFrom:
                secretKeyRef:
                  name: cascadia-secrets
                  key: rabbitmq-url
            - name: VAULT_ROOT
              value: /vault
            - name: WORKER_CONCURRENCY
              value: '2'
          resources:
            requests:
              cpu: '500m'
              memory: '1Gi'
            limits:
              cpu: '2000m'
              memory: '4Gi'
          livenessProbe:
            httpGet:
              path: /health
              port: 3003
            initialDelaySeconds: 60
            periodSeconds: 30
          volumeMounts:
            - name: vault
              mountPath: /vault
      volumes:
        - name: vault
          persistentVolumeClaim:
            claimName: cascadia-vault-pvc
```

Note the higher memory limits -- CAD tessellation of large assemblies can be memory-intensive.

## RabbitMQ Topology

The worker declares and binds to the following RabbitMQ topology (matching the Node.js client):

| Resource | Type              | Name                                               |
| -------- | ----------------- | -------------------------------------------------- |
| Exchange | topic             | `jobs.topic`                                       |
| Exchange | fanout            | `jobs.dlx` (dead letter)                           |
| Queue    | durable           | `jobs.dead-letter`                                 |
| Queue    | durable, priority | `cad-worker-<hostname>-<timestamp>` (per instance) |

The worker queue binds to the routing pattern `jobs.conversion.cad.#` on the `jobs.topic` exchange.

Each worker instance creates a unique queue name based on hostname and timestamp, allowing multiple converter instances to operate independently.

### Message Format

The worker expects messages matching the `JobMessage` schema:

```json
{
  "jobId": "uuid",
  "type": "conversion.cad",
  "priority": 5,
  "attemptNumber": 1
}
```

The full job payload is fetched from the `jobs` table in PostgreSQL, not from the message body.

## Mesh Quality Presets

| Preset     | Linear Deflection (mm) | Angular Deflection (rad) | Use Case                                         |
| ---------- | ---------------------- | ------------------------ | ------------------------------------------------ |
| `preview`  | 0.5                    | 1.0                      | Quick preview, small file size                   |
| `standard` | 0.1                    | 0.5                      | Default, good balance of quality and performance |
| `high`     | 0.01                   | 0.1                      | High-fidelity visualization, large file size     |

Quality can be set per-job via the `meshQuality` field in the job payload. Defaults to `standard`.

## Health Check

The worker runs an HTTP health server on a configurable port (default 3003):

```
GET /health
```

Response:

```json
{
  "status": "ok",
  "service": "cad-converter",
  "active_jobs": 0,
  "connected": true
}
```

Returns HTTP 200 when healthy, 503 when shutting down. Docker and Kubernetes health checks use this endpoint.

## Graceful Shutdown

On receiving SIGTERM or SIGINT:

1. The worker stops consuming new messages from RabbitMQ
2. Waits up to 30 seconds for active jobs to complete
3. Closes the RabbitMQ connection
4. Closes the PostgreSQL connection
5. Xvfb is killed by the entrypoint script

## Security

- The container runs as non-root user `cadworker`
- No ports are exposed except the health check (3003)
- The vault directory is mounted read/write for output files
- Database credentials are passed via environment variables

## Troubleshooting

### Worker Not Connecting to RabbitMQ

```bash
docker logs cascadia-cad-converter
```

Look for `RabbitMQ connection failed`. Common causes:

- Wrong `RABBITMQ_URL`
- RabbitMQ not started yet (the worker retries every 5 seconds)
- Network connectivity issues between the worker and RabbitMQ host

### CAD File Not Found

Error: `CAD file not found on disk: /vault/path/to/file.step`

- Verify `VAULT_ROOT` matches the mount point in the Docker volume
- Check that the vault directory is mounted correctly: `docker exec <container> ls /vault`
- Windows-generated paths with backslashes are normalized to forward slashes automatically

### Tessellation Fails on Specific Files

Some STEP files may have invalid geometry. Check the worker logs for OpenCASCADE errors. The worker will mark the job as failed in the database and log the error.

### Out of Memory

Large assemblies with high-quality tessellation can consume significant memory. Solutions:

- Increase container memory limits
- Use `preview` or `standard` quality instead of `high`
- Reduce `WORKER_CONCURRENCY` to process fewer files simultaneously

### Xvfb Issues

If thumbnails fail to generate but conversions succeed, the issue is likely with Xvfb. Thumbnail generation is non-blocking -- the conversion will complete without a thumbnail if rendering fails. Check for:

- Missing X11 libraries in the container
- Xvfb not starting (check entrypoint logs)
