# Docker Overview

Cascadia PLM ships as a set of Docker images built from a single monorepo. The app image's Dockerfile lives under `docker/`; the worker images have theirs under `workers/`.

## Docker Images

| Image                                         | Dockerfile                         | Base Image                                                       | Purpose                         | Port |
| --------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- | ------------------------------- | ---- |
| `ghcr.io/cascadia-plm/cascadia-app`           | `docker/app.Dockerfile`            | `node:22-alpine`                                                 | Core web application (UI + API) | 3000 |
| `ghcr.io/cascadia-plm/cascadia-jobs-worker`   | `workers/node/Dockerfile`          | `node:22-alpine`                                                 | Background job workers          | 3002 |
| `ghcr.io/cascadia-plm/cascadia-cad-converter` | `workers/cad-converter/Dockerfile` | `condaforge/miniforge3` + `debian:bookworm-slim` (digest-pinned) | STEP/IGES to STL/GLB conversion | 3003 |

File storage (the vault) is part of the core app process — there is no
standalone vault image. Point the app at local disk or S3 with
`VAULT_TYPE`/`VAULT_ROOT` instead.

### Building Images

```bash
# Core app
docker build -t ghcr.io/cascadia-plm/cascadia-app -f docker/app.Dockerfile .

# Jobs server
docker build -t ghcr.io/cascadia-plm/cascadia-jobs-worker -f workers/node/Dockerfile .

# CAD converter
docker build -t ghcr.io/cascadia-plm/cascadia-cad-converter -f workers/cad-converter/Dockerfile workers/cad-converter/
```

## Multi-Stage Dockerfile Builds

All Node.js images use a four-stage build pattern to minimize image size and separate build-time from runtime dependencies.

### Core App (`docker/app.Dockerfile`)

**Stage 1 -- manifests**: A `FROM scratch` stage holding the root `package.json` and `package-lock.json` plus every workspace's `package.json`. Nothing runs in it; it exists so the workspace list is written once and consumed twice, by the two stages that install. CI's `Docker Build Smoke` job builds through it on every run, which is what proves each path in the list still resolves.

**Stage 2 -- deps**: Takes that list with `COPY --from=manifests / ./` and installs all npm dependencies (including devDependencies needed for the build).

**Stage 3 -- builder**: Copies dependencies and source, runs `npm run build:app -- "$APP"` — the `APP` build arg names the app to build (`cascadia`, the only app in this tree). Uses `NODE_OPTIONS="--max-old-space-size=4096"` because the Vite + Hono builds can be memory-intensive.

**Stage 4 -- production**: Reuses the same manifests stage for its production-only install, then installs `dumb-init` for proper signal handling, copies the built `.output/` directory, Drizzle config, database schema, seed scripts, and auth modules. Creates a non-root `nodejs` user (UID 1001). Runs as that user.

Key details:

- The production stage installs production dependencies only (`npm ci --omit=dev --ignore-scripts`) — the server is pre-bundled, so dev dependencies aren't needed at runtime. `tsx` and `drizzle-kit` are then added back as admin tools for running `scripts/*.ts` (seed, migrate, baseline, reset) via `docker exec`.
- The workspace sources (`packages/`, `apps/`, `scripts/`) are copied so those tsx-run admin scripts — including `npm run db:migrate` (and the one-time `npm run db:baseline` stamp for a pre-v0.5 database) — work inside the container.
- Storage directories `/app/storage/files` and `/app/vault` are created with correct ownership.
- Health check hits `GET /api/v1/health` on port 3000.
- Entrypoint uses `dumb-init` for signal forwarding; the default command is `node .output/${APP}/server/index.mjs`, where the `APP` env var (baked from the build arg) names the edition's output directory.

### Jobs Server (`workers/node/Dockerfile`)

Same four-stage pattern. Differences:

- Production stage installs additional system packages: `imagemagick` (image processing), `ghostscript` (PDF operations). LibreOffice is available as a commented-out option for office document conversions.
- Installs only production npm dependencies (`npm ci --omit=dev --ignore-scripts`), the same policy as the app image.
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

| Service             | Profile      | Description                                       |
| ------------------- | ------------ | ------------------------------------------------- |
| `postgres`          | default      | PostgreSQL 18 database                            |
| `app`               | default      | Core app (builds from local source)               |
| `rabbitmq`          | default      | RabbitMQ with management UI                       |
| `jobs-worker-dev`   | `dev`        | Jobs worker with source mount and `tsx watch`     |
| `cad-converter-dev` | `dev`, `cad` | CAD converter built from `workers/cad-converter/` |
| `pgadmin`           | `tools`      | pgAdmin 4 for database management                 |

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
# Edit .env: set POSTGRES_PASSWORD
docker compose up -d
```

Runs PostgreSQL + the app container on one machine. The app applies committed migrations on startup — `scripts/boot-migrate.ts` guards the migrate so a pre-v0.5 database (tables, no journal) is refused with the one command that fixes it rather than migrated blind:

```yaml
command: sh -c "npx tsx scripts/boot-migrate.ts && npm run serve"
```

### Production Image References

Production compose files use `image:` instead of `build:`:

```yaml
services:
  app:
    image: ghcr.io/cascadia-plm/cascadia-app:${APP_VERSION:-latest}
```

Before deploying, push your images to a registry or build them on each host:

```bash
# Build and tag
docker build -t ghcr.io/cascadia-plm/cascadia-app:1.0.0 -f docker/app.Dockerfile .
docker build -t ghcr.io/cascadia-plm/cascadia-jobs-worker:1.0.0 -f workers/node/Dockerfile .

# Push to a private registry (substitute your own host)
docker tag ghcr.io/cascadia-plm/cascadia-app:1.0.0 registry.example.com/cascadia-app:1.0.0
docker push registry.example.com/cascadia-app:1.0.0
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
| Core App      | `GET /api/v1/health`                           | 30s      | 40s          |
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

# Apply committed migrations (the upgrade path; boot runs this too)
docker compose exec app npm run db:migrate

# Run seed scripts
docker compose exec app npm run db:seed

# Open a shell in the app container
docker compose exec app sh

# Remove all containers and volumes (destructive)
docker compose down -v
```
