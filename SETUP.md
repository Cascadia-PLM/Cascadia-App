# Setup Guide

Detailed installation and configuration instructions for Cascadia PLM.

## Prerequisites

- **Node.js** 22+ ([download](https://nodejs.org/))
- **PostgreSQL** 18+ ([download](https://www.postgresql.org/download/))
- **npm** (included with Node.js)
- **Docker** (optional, for RabbitMQ and CAD workers)

## Installation

### 1. Clone and Install

```bash
git clone https://github.com/Cascadia-PLM/Cascadia-App.git
cd Cascadia-App
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your database credentials. At minimum, set:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia
```

### 3. Set Up the Database

Create the database if it doesn't exist:

```bash
createdb -U postgres cascadia
```

> **Windows:** if `createdb` is not found, add `C:\Program Files\PostgreSQL\18\bin`
> to your PATH (see [Troubleshooting](#troubleshooting)) — that is the simplest fix,
> and `psql` needs it too. To use the full path instead without changing PATH,
> PowerShell requires the call operator, or it treats the quoted path as a string
> rather than a command:
>
> ```powershell
> & "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres cascadia
> ```

Push the schema and run the minimal seed:

```bash
npm run db:push
npm run db:seed
```

> **Note:** `db:push` and `db:generate` are interactive (drizzle-kit prompts). They may hang in non-interactive shells.

### 4. Start the Dev Server

```bash
npm run dev
```

Visit `http://localhost:3000`. Log in with the default admin credentials created by the seed script.

## Docker Compose

For a production-like setup with all services:

```bash
docker compose up -d
```

This starts three services by default:

- **postgres** — PostgreSQL database
- **app** — Cascadia web application
- **rabbitmq** — Message broker for background jobs

### Development Workers

Background job workers and CAD conversion services run under Docker profiles:

```bash
# Node.js jobs worker (requires RabbitMQ)
docker compose --profile dev up jobs-worker-dev -d

# CAD converter worker
docker compose --profile cad up cad-converter-dev -d

# All workers at once
docker compose --profile dev --profile cad up -d
```

### Utility Services

```bash
# pgAdmin database browser
docker compose --profile tools up pgadmin -d
```

## Optional Features

These features work out of the box with the core setup but can be enhanced with additional configuration.

### Background Jobs (RabbitMQ)

Required for: CAD file conversion, design cloning, notification jobs.

```bash
# Start RabbitMQ via Docker
docker compose up -d rabbitmq

# Start the Node.js job worker (development mode)
npm run jobs:worker:dev
```

Set in `.env`:

```
RABBITMQ_URL=amqp://cascadia:cascadia@localhost:5672
```

### AI Assistant

Requires an API key from Anthropic or OpenAI. Configure via the Admin > AI Settings page in the UI, or set in `.env`:

```
ANTHROPIC_API_KEY=your-key-here
# or
OPENAI_API_KEY=your-key-here
```

### AI CAD Generation

Requires a Zoo API key for text-to-CAD model generation. Set it either via the
environment:

```
ZOO_API_KEY=your-zoo-api-key
```

…or in the UI as an admin at **Admin → AI Assistant** (`/admin/ai`), in the
**CAD Generation** section. A key saved and enabled there is stored in the
database (encrypted at rest when `ENCRYPTION_KEY` is set) and overrides the
environment variable.

### CAD Conversion Workers

Convert STEP/IGES files to STL/GLB for in-browser 3D viewing. Requires Docker:

```bash
npm run cad:worker:dev      # CAD converter only
npm run workers:dev         # All workers (RabbitMQ + CAD + jobs)
```

### OAuth (GitHub)

Register a GitHub OAuth App and set:

```
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
```

The callback URL should be `{BASE_URL}/api/v1/auth/callback/github`.

### S3-Compatible Storage

By default, files are stored on the local filesystem. To use S3-compatible storage (AWS S3, MinIO, etc.):

```
VAULT_TYPE=s3
S3_BUCKET=your-bucket-name
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your-access-key       # Optional if using IAM roles
S3_SECRET_ACCESS_KEY=your-secret-key   # Optional if using IAM roles
S3_ENDPOINT=https://s3.amazonaws.com   # Override for MinIO/LocalStack
```

### Encryption at Rest

Encrypt sensitive data (API keys stored in the database) with:

```
ENCRYPTION_KEY=your-64-char-hex-string
```

Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Environment Variable Reference

| Variable                | Required | Default                 | Description                         |
| ----------------------- | -------- | ----------------------- | ----------------------------------- |
| `DATABASE_URL`          | Yes      | —                       | PostgreSQL connection string        |
| `BASE_URL`              | No       | `http://localhost:3000` | Application base URL                |
| `NODE_ENV`              | No       | `development`           | Environment mode                    |
| `VAULT_ROOT`            | No       | `./vault`               | Vault root directory                |
| `VAULT_TYPE`            | No       | `local`                 | Storage backend (`local` or `s3`)   |
| `RABBITMQ_URL`          | No       | —                       | RabbitMQ connection URL             |
| `ANTHROPIC_API_KEY`     | No       | —                       | Anthropic API key for AI assistant  |
| `OPENAI_API_KEY`        | No       | —                       | OpenAI API key for AI assistant     |
| `ZOO_API_KEY`           | No       | —                       | Zoo API key for CAD generation      |
| `GITHUB_CLIENT_ID`      | No       | —                       | GitHub OAuth app client ID          |
| `GITHUB_CLIENT_SECRET`  | No       | —                       | GitHub OAuth app client secret      |
| `ENCRYPTION_KEY`        | No       | —                       | 32-byte hex key for data encryption |
| `S3_BUCKET`             | No       | —                       | S3 bucket name                      |
| `S3_REGION`             | No       | —                       | S3 region                           |
| `S3_ACCESS_KEY_ID`      | No       | —                       | S3 access key (or use IAM roles)    |
| `S3_SECRET_ACCESS_KEY`  | No       | —                       | S3 secret key (or use IAM roles)    |
| `S3_ENDPOINT`           | No       | —                       | S3 endpoint override (for MinIO)    |
| `DATABASE_CA_CERT_PATH` | No       | —                       | Path to CA cert for database SSL    |

## Database Management

```bash
npm run db:push       # Diff-apply schema directly (dev/CI/demo only — NOT the upgrade path)
npm run db:generate   # Mint migration SQL for a schema change
npm run db:migrate    # Apply committed migrations (the upgrade path for released installs)
npm run db:baseline   # One-time stamp for a pre-v0.5 push-created database
npm run db:studio     # Open Drizzle Studio GUI
npm run db:seed       # Minimal seed (admin, roles, program, standard library)
npm run db:reset      # Truncate all tables
npm run db:reset:seed # Truncate + minimal seed
```

## Troubleshooting

### Windows-Specific

- **PostgreSQL path:** Default install is `C:\Program Files\PostgreSQL\18\`. Add the `bin` directory to your PATH for `createdb` and `psql`.
- **Docker Desktop:** When running the jobs worker inside Docker on Windows, the worker needs to reach the host PostgreSQL. Set `POSTGRES_HOST=host.docker.internal` in the worker's environment.
- **Path separators:** Use forward slashes in imports. Node.js handles conversion automatically.

### Common Issues

- **`db:push` hangs:** Drizzle-kit is interactive. Run it in a terminal that supports prompts, not inside a non-interactive script.
- **Seed duplicate key errors:** Always run `npm run db:reset` before reseeding. Use `npm run db:reset:seed` for a clean one-step reset.
- **Port 3000 in use:** `npm run dev` runs two halves — the client on `CLIENT_PORT` (default 3000) and the API on `API_PORT` (default 3001). There is no `--port` flag; set the environment variable instead. The client proxies `/api` to `API_PORT`, so move both if 3001 is taken too:

  ```bash
  CLIENT_PORT=3100 API_PORT=3101 npm run dev
  ```

  ```powershell
  $env:CLIENT_PORT=3100; $env:API_PORT=3101; npm run dev
  ```

- **RabbitMQ connection refused:** Ensure RabbitMQ is running (`docker compose up -d rabbitmq`) and the URL in `.env` matches the container credentials.

## Next Steps

- See [README.md](./README.md) for an overview of features and architecture
- See [cascadia-feature-list.md](./cascadia-feature-list.md) for a comprehensive feature inventory
- See `docs/orchestration/` for production deployment guides (single-server, distributed, Kubernetes)
