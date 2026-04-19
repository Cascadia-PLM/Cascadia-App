# Docker Overview

Cascadia PLM ships as a set of Docker images built from a single monorepo. Each service has its own multi-stage Dockerfile under `docker/`, plus the CAD converter service which has its own Dockerfile at `workers/cad-converter/Dockerfile`.

## Docker Images

| Image                    | Dockerfile                         | Base Image                                       | Purpose                         | Port |
| ------------------------ | ---------------------------------- | ------------------------------------------------ | ------------------------------- | ---- |
| `cascadia/app`           | `docker/app.Dockerfile`            | `node:20-alpine`                                 | Core web application (UI + API) | 3000 |
| `cascadia/vault`         | `docker/vault.Dockerfile`          | `node:20-alpine`                                 | Standalone file storage service | 3001 |
| `cascadia/jobs`          | `workers/node/Dockerfile`          | `node:20-alpine`                                 | Background job workers          | 3002 |
| `cascadia/cad-converter` | `workers/cad-converter/Dockerfile` | `condaforge/miniforge3` + `debian:bookworm-slim` | STEP/IGES to STL/GLB conversion | 3003 |

### Building Images

```bash
# Core app
docker build -t cascadia/app -f docker/app.Dockerfile .

# Vault service
docker build -t cascadia/vault -f docker/vault.Dockerfile .

# Jobs server
docker build -t cascadia/jobs -f workers/node/Dockerfile .

# CAD converter
docker build -t cascadia/cad-converter -f workers/cad-converter/Dockerfile workers/cad-converter/
```

## Multi-Stage Dockerfile Builds

All Node.js images use a three-stage build pattern to minimize image size and separate build-time from runtime dependencies.

### Core App (`docker/app.Dockerfile`)

**Stage 1 -- deps**: Installs all npm dependencies (including devDependencies needed for the build).

**Stage 2 -- builder**: Copies dependencies and source, runs `npm run build`. Uses `NODE_OPTIONS="--max-old-space-size=4096"` because the Vite + Hono builds can be memory-intensive.

**Stage 3 -- production**: Installs `dumb-init` for proper signal handling, copies the built `.output/` directory, Drizzle config, database schema, seed scripts, and auth modules. Creates a non-root `nodejs` user (UID 1001). Runs as that user.

Key details:

- The production stage reinstalls all npm dependencies (including dev) because seed scripts require `tsx`.
- Drizzle schema files (`src/lib/db/`) are copied to support runtime migrations via `npx drizzle-kit push`.
- Storage directories `/app/storage/files` and `/app/vault` are created with correct ownership.
- Health check hits `GET /api/health` on port 3000.
- Entrypoint uses `dumb-init` for signal forwarding; default command is `npm run serve`.

### Vault Service (`docker/vault.Dockerfile`)

Same three-stage pattern. Differences from the app image:

- Production stage installs only production dependencies (`npm ci --only=production`).
- Copies only vault-specific code (`src/lib/vault`, `src/lib/db`).
- Exposes port 3001.
- Default environment: `STORAGE_TYPE=local`, `STORAGE_PATH=/app/vault`.
- Health check hits `GET /health` on port 3001.
- Default command runs `node .output/server/index.mjs`.

### Jobs Server (`workers/node/Dockerfile`)

Same three-stage pattern. Differences:

- Production stage installs additional system packages: `imagemagick` (image processing), `ghostscript` (PDF operations). LibreOffice is available as a commented-out option for office document conversions.
- Installs only production npm dependencies (`npm install --omit=dev`).
- Creates a `/app/tmp` directory for conversion scratch space.
- Default environment: `WORKER_CONCURRENCY=5`, `JOB_TYPES=*`, `JOB_TIMEOUT=300000`.
- Health check hits `GET /health` on port 3002.
- Default command runs `node .output/server/jobs-worker.mjs`.

### CAD Converter (`workers/cad-converter/Dockerfile`)

Uses a two-stage build with conda-pack:

**Stage 1 -- build**: Uses `condaforge/miniforge3` to create a conda environment from `environment.yml` with `pythonocc-core>=7.7`, `pika`, `psycopg`, and `pydantic-settings`. Packs the environment with `conda-pack` into a portable tarball.

**Stage 2 -- runtime**: Uses `debian:bookworm-slim`. Installs only the runtime libraries needed for OpenCASCADE (`libgl1`, `libglib2.0-0`, `libgomp1`, X11 libs) plus `xvfb` for offscreen rendering. Unpacks the conda environment. Creates a `cadworker` user.

Key details:

- Xvfb (virtual framebuffer) is started by `entrypoint.sh` before the Python process, providing a DISPLAY for OpenGL-based thumbnail rendering.
- Health check hits the configurable `HEALTH_PORT` (default 3003).
- Default command is `--worker` which starts the RabbitMQ consumer.

## Docker Compose for Development

The root `docker-compose.yml` provides the full development stack:

```bash
# Core services (PostgreSQL + app + RabbitMQ)
docker compose up -d

# Add dev workers (jobs + CAD converter)
docker compose --profile dev up -d

# Add CAD services only
docker compose --profile cad up -d

# Add pgAdmin
docker compose --profile tools up -d
```

### Development Services

| Service             | Profile      | Description                                            |
| ------------------- | ------------ | ------------------------------------------------------ |
| `postgres`          | default      | PostgreSQL 18 database                                 |
| `app`               | default      | Core app (builds from local source)                    |
| `rabbitmq`          | default      | RabbitMQ with management UI                            |
| `jobs-worker-dev`   | `dev`        | Jobs worker with source mount and `tsx watch`          |
| `cad-converter-dev` | `dev`, `cad` | CAD converter built from `workers/cad-converter/`      |
| `cad-generator-dev` | `dev`, `cad` | Parametric CAD generator from `workers/cad-generator/` |
| `pgadmin`           | `tools`      | pgAdmin 4 for database management                      |

### Development Worker Notes

The `jobs-worker-dev` service:

- Mounts the full source tree into the container for live code updates.
- Uses `tsx watch` for automatic restart on file changes.
- Uses `host.docker.internal` to reach PostgreSQL running on the Windows host. Set `POSTGRES_HOST=postgres` if PostgreSQL also runs in Docker.
- **Must run inside Docker on Windows** due to Docker Desktop networking limitations with AMQP authentication.

The `cad-converter-dev` service:

- Builds directly from the `workers/cad-converter/` Dockerfile.
- Mounts the local `./vault` directory so it can read/write the same files as the host app.
- Health check endpoint on port 3003.

### Environment Variables

Development defaults are configured in the compose file. Override with a `.env` file at the project root:

```bash
# PostgreSQL credentials
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=cascadia

# RabbitMQ credentials
RABBITMQ_USER=cascadia
RABBITMQ_PASSWORD=cascadia

# Use 'postgres' if PostgreSQL runs in Docker, 'host.docker.internal' if on host
POSTGRES_HOST=host.docker.internal
```

## Docker Compose for Production

Production deployments use the compose files under `docs/orchestration/deployments/`. These reference pre-built images rather than building from source.

### Single Server

```bash
cd docs/orchestration/deployments/single-server/
cp .env.example .env
# Edit .env: set SESSION_SECRET and POSTGRES_PASSWORD
docker compose up -d
```

Runs PostgreSQL + the app container on one machine. The app runs migrations on startup:

```yaml
command: sh -c "npx drizzle-kit push --force && npm run serve"
```

### Production Image References

Production compose files use `image:` instead of `build:`:

```yaml
services:
  app:
    image: cascadia/app:${APP_VERSION:-latest}
```

Before deploying, push your images to a registry or build them on each host:

```bash
# Build and tag
docker build -t cascadia/app:1.0.0 -f docker/app.Dockerfile .
docker build -t cascadia/jobs:1.0.0 -f workers/node/Dockerfile .

# Push to registry
docker tag cascadia/app:1.0.0 registry.example.com/cascadia/app:1.0.0
docker push registry.example.com/cascadia/app:1.0.0
```

## Volumes

All services use named Docker volumes for persistent data:

| Volume          | Service  | Mount Point                | Purpose               |
| --------------- | -------- | -------------------------- | --------------------- |
| `postgres_data` | postgres | `/var/lib/postgresql/data` | Database files        |
| `app_storage`   | app      | `/app/storage`             | General file storage  |
| `app_vault`     | app      | `/app/vault`               | Vault file storage    |
| `rabbitmq_data` | rabbitmq | `/var/lib/rabbitmq`        | Message queue data    |
| `pgadmin_data`  | pgadmin  | `/var/lib/pgadmin`         | pgAdmin configuration |

To use host-mounted paths instead of Docker-managed volumes:

```yaml
volumes:
  postgres_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /data/postgres
```

## Health Checks

All services include Docker health checks:

| Service       | Endpoint                                       | Interval | Start Period |
| ------------- | ---------------------------------------------- | -------- | ------------ |
| PostgreSQL    | `pg_isready`                                   | 10s      | 30s          |
| Core App      | `GET /api/health`                              | 30s      | 40s          |
| Vault Service | `GET /health`                                  | 30s      | 20s          |
| Jobs Server   | `GET /health`                                  | 30s      | 20s          |
| RabbitMQ      | `rabbitmq-diagnostics check_port_connectivity` | 30s      | 30s          |
| CAD Converter | Python `urllib` to `/health`                   | 30s      | 60s          |

## Networking

Production compose files use isolated bridge networks:

```yaml
networks:
  cascadia-internal:
    driver: bridge
```

For distributed deployments, each component stack defines its own network. Services communicate across hosts via exposed ports and environment-variable-configured URLs.

## Security Considerations

- All Node.js images run as non-root user `nodejs` (UID 1001).
- The CAD converter runs as non-root user `cadworker`.
- Production compose files use `${VAR:?error}` syntax to enforce required secrets.
- Never commit `.env` files containing credentials to version control.
- In production, consider Docker secrets or an external secrets manager instead of environment variables.

## Common Operations

```bash
# View logs
docker compose logs -f app
docker compose logs -f jobs-worker-dev

# Restart a service
docker compose restart app

# Run database migrations
docker compose exec app npx drizzle-kit push

# Run seed scripts
docker compose exec app npm run db:seed

# Open a shell in the app container
docker compose exec app sh

# Remove all containers and volumes (destructive)
docker compose down -v
```
