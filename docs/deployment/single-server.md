# Single-Server Deployment

All Cascadia components running on one machine: PostgreSQL, the core application (with embedded vault and jobs), and optional tooling.

## When to Use

- Development and testing environments
- Small teams (fewer than 20 users)
- Proof of concept or evaluation deployments
- Low file processing workloads
- Environments where operational simplicity is more important than high availability

## Architecture

```
+-------------------------------------+
|           Single Server             |
|                                     |
|  +-------------------------------+  |
|  |        Cascadia App           |  |
|  |   (Core + Vault + Jobs)       |  |
|  |         :3000                 |  |
|  +---------------+---------------+  |
|                  |                  |
|  +---------------v---------------+  |
|  |        PostgreSQL             |  |
|  |           :5432               |  |
|  +-------------------------------+  |
|                                     |
|  Volumes:                           |
|  - postgres_data                    |
|  - app_storage                      |
|  - app_vault                        |
+-------------------------------------+
```

The app container runs in **embedded mode** for both vault and jobs, meaning file storage and background job processing happen inside the same process. No RabbitMQ is needed.

## Prerequisites

- Docker and Docker Compose installed
- At least 2 GB of available RAM
- Sufficient disk space for PostgreSQL data and file vault storage

## Quick Start

```bash
# Navigate to the single-server deployment directory
cd docs/orchestration/deployments/single-server/

# Copy the environment template
cp .env.example .env

# Edit .env and set required values:
#   SESSION_SECRET - generate with: openssl rand -hex 32
#   POSTGRES_PASSWORD - use a strong password
vi .env

# Start services
docker compose up -d

# Verify both containers are healthy
docker compose ps

# Access the application
open http://localhost:3000
```

## Configuration

### Required Variables

| Variable            | Description                                 | How to Generate              |
| ------------------- | ------------------------------------------- | ---------------------------- |
| `SESSION_SECRET`    | 32+ character secret for session encryption | `openssl rand -hex 32`       |
| `POSTGRES_PASSWORD` | PostgreSQL password                         | Use a strong random password |

### Optional Variables

| Variable        | Default                 | Description                                   |
| --------------- | ----------------------- | --------------------------------------------- |
| `APP_PORT`      | `3000`                  | Port exposed to the host                      |
| `BASE_URL`      | `http://localhost:3000` | Public URL (used for OAuth callbacks, emails) |
| `NODE_ENV`      | `production`            | Environment mode                              |
| `POSTGRES_DB`   | `cascadia`              | Database name                                 |
| `POSTGRES_USER` | `postgres`              | Database user                                 |
| `POSTGRES_PORT` | `5432`                  | PostgreSQL port on the host                   |

### Full `.env.example`

```bash
# REQUIRED
SESSION_SECRET=
POSTGRES_PASSWORD=

# APPLICATION
APP_PORT=3000
BASE_URL=http://localhost:3000
NODE_ENV=production

# DATABASE
POSTGRES_DB=cascadia
POSTGRES_USER=postgres
POSTGRES_PORT=5432

# OPTIONAL: pgAdmin (start with --profile tools)
PGADMIN_EMAIL=admin@cascadia.local
PGADMIN_PASSWORD=admin
PGADMIN_PORT=5050
```

## Docker Compose Configuration

The compose file defines two services (plus optional pgAdmin):

```yaml
services:
  postgres:
    image: postgres:18-alpine
    container_name: cascadia-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-cascadia}
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      PGDATA: /var/lib/postgresql/data/pgdata
    ports:
      - '${POSTGRES_PORT:-5432}:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test:
        [
          'CMD-SHELL',
          'pg_isready -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-cascadia}',
        ]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - cascadia-internal

  app:
    build:
      context: ../../..
      dockerfile: docker/app.Dockerfile
      target: production
    container_name: cascadia-app
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: ${NODE_ENV:-production}
      DATABASE_URL: postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-cascadia}
      SESSION_SECRET: ${SESSION_SECRET:?SESSION_SECRET is required}
      BASE_URL: ${BASE_URL:-http://localhost:3000}
      VAULT_MODE: embedded
      VAULT_TYPE: local
      FILE_STORAGE_PATH: /app/storage/files
      VAULT_ROOT: /app/vault
      JOBS_MODE: embedded
    ports:
      - '${APP_PORT:-3000}:3000'
    volumes:
      - app_storage:/app/storage
      - app_vault:/app/vault
    networks:
      - cascadia-internal
    command: sh -c "npx drizzle-kit push --force && npm run serve"
```

Key points:

- The app waits for PostgreSQL to pass its health check before starting.
- On startup, the app runs `npx drizzle-kit push --force` to apply any pending schema changes, then starts the server.
- `VAULT_MODE=embedded` and `JOBS_MODE=embedded` mean no external vault service or RabbitMQ is required.
- All inter-service communication happens over the `cascadia-internal` bridge network.

## Adding pgAdmin

pgAdmin is available behind a Docker Compose profile so it does not start by default:

```bash
docker compose --profile tools up -d
# Access at http://localhost:5050
# Default login: admin@cascadia.local / admin
```

To connect pgAdmin to the database, use host `cascadia-postgres`, port `5432`, and the credentials from your `.env`.

## Customization

### Change Ports

Edit your `.env` file:

```bash
APP_PORT=8080
POSTGRES_PORT=5433
```

### Use a Reverse Proxy

For production, put the app behind Nginx or another reverse proxy with TLS:

```nginx
server {
    listen 443 ssl;
    server_name plm.example.com;

    ssl_certificate /etc/ssl/certs/plm.crt;
    ssl_certificate_key /etc/ssl/private/plm.key;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Update `BASE_URL` in your `.env` to match the public URL:

```bash
BASE_URL=https://plm.example.com
```

### Persistent Storage Locations

By default, Docker manages volume locations. To use specific host paths:

```yaml
volumes:
  postgres_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /data/postgres
  app_vault:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /data/vault
```

### Enable OAuth

Add OAuth provider credentials to your `.env`:

```bash
ENABLE_OAUTH=true
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
```

Set `BASE_URL` to your public URL so OAuth callback URLs resolve correctly.

## Backup and Restore

### Database Backup

```bash
# Dump the database
docker compose exec postgres pg_dump -U postgres cascadia > backup_$(date +%Y%m%d).sql

# Compressed backup
docker compose exec postgres pg_dump -U postgres cascadia | gzip > backup_$(date +%Y%m%d).sql.gz
```

### Database Restore

```bash
# Stop the app first
docker compose stop app

# Restore
cat backup.sql | docker compose exec -T postgres psql -U postgres cascadia

# Restart
docker compose start app
```

### File Vault Backup

```bash
# Find the vault volume mount point
docker volume inspect single-server_app_vault

# Or copy files from the running container
docker cp cascadia-app:/app/vault ./vault-backup
```

## Upgrading

```bash
# Pull or build new image
docker compose build app

# Restart with the new image (migrations run on startup)
docker compose up -d app

# Check logs for migration output
docker compose logs -f app
```

## Troubleshooting

### App Fails to Start

Check logs:

```bash
docker compose logs app
```

Common causes:

- `POSTGRES_PASSWORD is required` -- set the variable in `.env`.
- `SESSION_SECRET is required` -- set the variable in `.env`.
- Database not ready -- the `depends_on` health check should handle this, but check PostgreSQL logs: `docker compose logs postgres`.

### Database Connection Refused

```bash
# Verify PostgreSQL is running and healthy
docker compose ps
docker compose logs postgres
```

### Schema Push Fails

If `drizzle-kit push` fails on startup, run it manually:

```bash
docker compose exec app npx drizzle-kit push
```

### Reset Everything

```bash
# Stop all containers and delete all data
docker compose down -v

# Start fresh
docker compose up -d
```

## Limitations

- **No high availability**: a single server is a single point of failure.
- **No horizontal scaling**: the app runs as one container.
- **Embedded jobs**: background processing shares CPU/memory with the web server. Under heavy file conversion workloads, consider the [distributed deployment](./distributed.md).
- **Local file storage**: vault files are stored on the local filesystem. For durability, ensure the volume is backed up or migrate to the [cloud database deployment](./cloud-database.md) with S3 storage.
