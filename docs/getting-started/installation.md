# Installation

Local development setup guide for Cascadia PLM.

## Prerequisites

| Requirement    | Version  | Notes                                     |
| -------------- | -------- | ----------------------------------------- |
| **Node.js**    | 22.x LTS | Recommended. 20.x also works.             |
| **npm**        | 10+      | Ships with Node.js 22.                    |
| **PostgreSQL** | 18+      | Required. Must be running and accessible. |
| **Git**        | 2.x      | For cloning the repository.               |

### Optional dependencies

| Dependency         | Purpose                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Docker Desktop** | Required for RabbitMQ (background jobs), CAD converter, and containerized deployment.                         |
| **Python 3.11+**   | Only if developing the CAD converter microservice locally (most developers use the Docker container instead). |

## Clone and install

```bash
git clone https://github.com/Cascadia-PLM/Cascadia-App.git
cd Cascadia-App
npm install
```

This installs all Node.js dependencies including Drizzle ORM, Hono, TanStack Router, TanStack Query, and the development toolchain (TypeScript, Vitest, Playwright, etc.).

## PostgreSQL setup

### macOS (Homebrew)

```bash
brew install postgresql@18
brew services start postgresql@18
createdb cascadia
```

### Linux (Ubuntu/Debian)

```bash
sudo apt install postgresql-18
sudo systemctl start postgresql
sudo -u postgres createdb cascadia
```

### Windows

PostgreSQL can be installed via the [official installer](https://www.postgresql.org/download/windows/) or via the Docker Compose setup described below.

**Native install** (typical path: `C:\Program Files\PostgreSQL\18\`):

```bash
# Using the PostgreSQL bin directory (add to PATH or use full path)
"C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres cascadia
```

You may be prompted for the `postgres` user password you set during installation.

**Docker alternative** (recommended if you already have Docker Desktop):

```bash
docker compose up -d postgres
```

This starts PostgreSQL 18 on port 5432 with default credentials (`postgres`/`postgres`) and automatically creates the `cascadia` database.

### Verify the database

```bash
# Should connect without error
psql -U postgres -d cascadia -c "SELECT 1"
```

## Environment variables

Copy the example environment file:

```bash
cp .env.example .env
```

The defaults work for local development with a standard PostgreSQL setup:

```bash
# .env (minimum required)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia
SESSION_SECRET=change-this-to-a-random-32-char-string
```

If your PostgreSQL uses a different username, password, or port, update `DATABASE_URL` accordingly.

See the [Configuration Guide](./configuration.md) for the full list of environment variables.

## Push the database schema

Cascadia uses Drizzle ORM for schema management. Push the schema to your database:

```bash
npm run db:push
```

This is an interactive command that uses `drizzle-kit push` to apply the schema directly. It will prompt to confirm table creation. For development, this is the fastest way to get started.

> **Note**: `db:push` applies the schema without creating migration files. For production deployments, use `npm run db:generate` followed by `npm run db:migrate` to create and run versioned migrations.

## Seed the database

Run the minimal seed to create the admin user, default roles, a default program, and lifecycle definitions:

```bash
npm run db:seed
```

Expected output:

```
Seeding minimal database...

 Roles (Global Admin, Administrator, Power User, Approver, User, View Only)
 Admin User (admin@cascadia.local / Cascadia)
 Default Program
 Standard Parts Library (Global)
 Default Lifecycles (Part, Document, ChangeOrder)
 Flexible Workflow (Dynamic Change Order)
 Issue Lifecycle (Free)
 Item Type Configs (with lifecycle assignments)

 Minimal seed complete!

Admin User:
  Email: admin@cascadia.local
  Password: Cascadia
  Roles: Global Admin, Administrator
```

## First run

Start the development server:

```bash
npm run dev
```

The server starts on **http://localhost:3000**. Open this URL in your browser and log in with:

- **Email**: `admin@cascadia.local`
- **Password**: `Cascadia`

You should see the Cascadia dashboard. Proceed to the [Quick Start Guide](./quick-start.md) for next steps.

## Common issues

### Port 3000 already in use

Another process is occupying port 3000. Either stop it or change the port:

```bash
# Find what's using port 3000
# macOS/Linux
lsof -i :3000
# Windows
netstat -ano | findstr :3000

# Or start Cascadia on a different port
npx vite dev --port 3001
```

### `drizzle-kit push` hangs

`drizzle-kit push` and `drizzle-kit generate` are interactive commands. They will hang if run in a non-interactive shell (e.g., piped through another command or run from certain IDE terminals). Run them directly in a terminal.

### Database connection refused

Ensure PostgreSQL is running and the `DATABASE_URL` in `.env` matches your setup:

```bash
# Check PostgreSQL is running
# macOS
brew services list | grep postgresql
# Linux
systemctl status postgresql
# Windows
sc query postgresql-x64-18
```

### Windows: `psql` hangs waiting for password

On Windows, `psql` may ignore the `PGPASSWORD` environment variable depending on your shell. Use the npm scripts instead of calling psql directly:

```bash
npm run db:reset        # Truncate all tables
npm run db:reset:seed   # Truncate + re-seed
```

### Windows: path separator issues

Node.js handles forward/backward slashes automatically, but some tools may not. Use forward slashes in `.env` paths:

```bash
# Good
FILE_STORAGE_PATH=./storage/files

# Avoid
FILE_STORAGE_PATH=.\storage\files
```

### Missing `tsx` command

If `tsx` is not found, ensure `npm install` completed successfully. `tsx` is a dev dependency and should be available via `npx tsx`:

```bash
npx tsx scripts/seed-minimal.ts
```

### Docker Desktop not running (Windows/macOS)

If you see errors about Docker when running `docker compose` commands, ensure Docker Desktop is started. Background jobs (RabbitMQ) and the CAD converter are optional for basic development -- the core app works without them.

## Next steps

- [Configuration](./configuration.md) -- All environment variables and runtime configuration
- [Quick Start](./quick-start.md) -- Create your first program, parts, and ECO
