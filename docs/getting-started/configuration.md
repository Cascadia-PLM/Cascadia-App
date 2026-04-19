# Configuration

All configuration options for Cascadia PLM, from environment variables to the runtime configuration system.

## Environment variables

Cascadia uses a `.env` file at the project root for local development. Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
```

### Required variables

These must be set for the application to start:

| Variable         | Description                                           | Example                                                  |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`   | PostgreSQL connection string                          | `postgresql://postgres:postgres@localhost:5432/cascadia` |
| `SESSION_SECRET` | Secret for session cookie encryption (32+ characters) | `your-random-32-character-string`                        |

### Application settings

| Variable    | Default                       | Description                                           |
| ----------- | ----------------------------- | ----------------------------------------------------- |
| `NODE_ENV`  | `production`                  | Environment mode: `development`, `production`, `test` |
| `PORT`      | `3000`                        | HTTP port                                             |
| `BASE_URL`  | `http://localhost:3000`       | Public URL of the application                         |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | Logging verbosity: `debug`, `info`, `warn`, `error`   |

### File storage (Vault)

Cascadia stores uploaded files (CAD models, documents, drawings) in a vault. By default, the vault uses local filesystem storage.

| Variable            | Default           | Description                            |
| ------------------- | ----------------- | -------------------------------------- |
| `VAULT_TYPE`        | `local`           | Storage backend: `local` or `s3`       |
| `VAULT_ROOT`        | `./vault`         | Root directory for local vault storage |
| `FILE_STORAGE_PATH` | `./storage/files` | General file storage path              |

#### S3 storage

To use S3 (or S3-compatible storage like MinIO):

```bash
VAULT_TYPE=s3
S3_BUCKET=cascadia-vault
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_ENDPOINT=                        # Leave empty for AWS; set for MinIO (e.g., http://localhost:9000)
S3_FORCE_PATH_STYLE=false           # Set true for MinIO
```

> **Note**: The source code uses `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (with `_ID` and `_ACCESS_KEY` suffixes). Some documentation references use the shorter `S3_ACCESS_KEY` / `S3_SECRET_KEY` names. Use the full names shown above.

### Database SSL/TLS

| Variable                | Default | Description                                 |
| ----------------------- | ------- | ------------------------------------------- |
| `DATABASE_CA_CERT_PATH` | -       | Path to CA certificate for SSL verification |

SSL is enabled automatically in production (`NODE_ENV=production`) unless connecting via Cloud SQL Unix socket. Provide a CA certificate path for strict verification, or the driver falls back to `ssl: 'require'`.

### Security

| Variable         | Description                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `ENCRYPTION_KEY` | AES-256 key for encrypting sensitive data at rest (64 hex characters) |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This key is optional for development but recommended for production. It encrypts sensitive values like stored API keys.

### Background jobs (RabbitMQ)

Background jobs are optional and only needed for features like email notifications, CAD conversion, and scheduled tasks.

| Variable             | Default  | Description                                   |
| -------------------- | -------- | --------------------------------------------- |
| `RABBITMQ_URL`       | -        | AMQP connection string                        |
| `WORKER_CONCURRENCY` | `5`      | Maximum concurrent jobs per worker            |
| `JOB_TYPES`          | `*`      | Job types to process (comma-separated or `*`) |
| `JOB_TIMEOUT`        | `300000` | Default job timeout in milliseconds           |

Development setup with Docker:

```bash
# Start RabbitMQ
docker compose up -d rabbitmq

# Start the jobs worker (in a separate terminal)
npm run jobs:worker:dev
```

The default `.env.example` ships with `RABBITMQ_URL=amqp://cascadia:cascadia@localhost:5672`.

### Email (SMTP)

Required for notification jobs in production. In development, emails are logged to the console.

| Variable    | Default                  | Description                               |
| ----------- | ------------------------ | ----------------------------------------- |
| `SMTP_HOST` | -                        | SMTP server hostname                      |
| `SMTP_PORT` | `587`                    | SMTP port (587 for STARTTLS, 465 for SSL) |
| `SMTP_USER` | -                        | SMTP username                             |
| `SMTP_PASS` | -                        | SMTP password                             |
| `SMTP_FROM` | `noreply@cascadia.local` | Default "From" address                    |

### OAuth providers (optional)

Cascadia supports OAuth login via Azure AD and Google. These are optional -- local email/password authentication works without them.

| Variable               | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `AZURE_TENANT_ID`      | Azure AD tenant ID                                               |
| `AZURE_CLIENT_ID`      | Azure AD OAuth application client ID                             |
| `AZURE_CLIENT_SECRET`  | Azure AD OAuth application secret                                |
| `AZURE_REDIRECT_URI`   | Callback URL (e.g., `http://localhost:3000/auth/callback/azure`) |
| `GOOGLE_CLIENT_ID`     | Google OAuth client ID                                           |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret                                       |

To set up Azure AD OAuth:

1. Register an application in the Azure Portal under App Registrations.
2. Set the redirect URI to `{BASE_URL}/auth/callback/azure`.
3. Copy the Tenant ID, Client ID, and create a Client Secret.
4. Add the values to your `.env` file.

### AI providers (optional)

Cascadia includes an AI chatbot and design engine that require API keys from supported providers.

| Variable            | Description                            |
| ------------------- | -------------------------------------- |
| `OPENAI_API_KEY`    | OpenAI API key for GPT models          |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude models    |
| `ZOO_API_KEY`       | Zoo API key for text-to-CAD generation |

At least one of `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is required for AI features. If neither is set, the AI chatbot panel is hidden but the rest of the application works normally.

AI settings can also be configured per-program via the Admin UI at `/admin/ai`. The `ai_settings` database table stores provider configuration that can override environment variables.

### CAD converter (optional)

The CAD converter is a Python microservice that converts STEP/IGES files to STL and GLB formats. It runs in Docker.

```bash
# Start the CAD converter
npm run cad:worker:dev

# View logs
npm run cad:worker:logs

# Stop
npm run cad:worker:stop
```

No additional environment variables are needed -- the converter connects to the same RabbitMQ and PostgreSQL instances.

---

## Runtime configuration system

Beyond environment variables, Cascadia implements a hybrid **code-first + runtime configuration** architecture. This allows administrators to modify item type behavior (labels, permissions, lifecycle states, relationships) without redeploying the application.

### What can be configured at runtime

| Setting            | Code-defined (default) | Runtime-overridable |
| ------------------ | ---------------------- | ------------------- |
| Database schema    | Yes                    | No                  |
| Zod validation     | Yes                    | No                  |
| React components   | Yes                    | No                  |
| Labels / display   | Yes                    | Yes                 |
| Permissions (CRUD) | Yes                    | Yes                 |
| Lifecycle states   | Yes                    | Yes                 |
| Relationships      | Yes                    | Yes                 |
| Field metadata     | Yes                    | Yes                 |

### How it works

The `ItemTypeRegistry` merges code definitions with runtime overrides stored in the `item_type_configs` database table. Runtime values take precedence over code defaults.

```
Code Definitions (TypeScript)  +  Runtime Configs (Database)
         |                                  |
         +------ ItemTypeRegistry ----------+
                        |
                  Merged Config
              (runtime wins for
               overridable fields)
```

### Database table: `item_type_configs`

| Column        | Type        | Description                                   |
| ------------- | ----------- | --------------------------------------------- |
| `id`          | UUID        | Primary key                                   |
| `item_type`   | VARCHAR(50) | Item type name (unique): Part, Document, etc. |
| `config`      | JSONB       | Runtime override configuration                |
| `version`     | INTEGER     | Optimistic locking version                    |
| `is_active`   | BOOLEAN     | Soft delete flag                              |
| `modified_by` | UUID (FK)   | User who last modified                        |
| `modified_at` | TIMESTAMPTZ | Last modification timestamp                   |

### Config JSON structure

The `config` JSONB column accepts these fields:

```typescript
interface RuntimeItemTypeConfig {
  label?: string // Display name override (e.g., "Component" instead of "Part")
  pluralLabel?: string // Plural display name
  icon?: string // Lucide icon name
  lifecycleDefinitionId?: string // UUID of the lifecycle/workflow definition
  states?: Array<{
    id: string // State identifier
    name: string // Display name
    color?: string // Badge color
    description?: string // Help text
  }>
  permissions?: {
    create: string[] // Role names that can create
    read: string[] // Use ["*"] for all roles
    update: string[]
    delete: string[]
  }
  relationships?: Array<{
    type: string // e.g., "BOM", "Reference"
    label: string
    targetTypes: string[]
    allowMultiple: boolean
  }>
  fieldMetadata?: Record<
    string,
    {
      label?: string
      description?: string
      required?: boolean
      visible?: boolean
    }
  >
}
```

### Managing runtime configuration

**Via Admin UI**: Navigate to `/admin/item-types` to view, edit, and reset configurations.

**Via API** (requires Admin role):

```bash
# List all configurations
GET /api/admin/item-type-configs

# Get one item type
GET /api/admin/item-type-configs/:itemType

# Create or update
POST /api/admin/item-type-configs
Content-Type: application/json
{ "itemType": "Part", "config": { "label": "Component" } }

# Delete (revert to code defaults)
DELETE /api/admin/item-type-configs/:itemType

# Hot-reload all configs
POST /api/admin/reload-config
```

### Database table: `settings`

General application settings are stored in the `settings` table:

| Column        | Type         | Description                              |
| ------------- | ------------ | ---------------------------------------- |
| `id`          | UUID         | Primary key                              |
| `key`         | VARCHAR(100) | Setting key (unique), e.g., `vault_root` |
| `value`       | TEXT         | Simple text value                        |
| `json_value`  | JSONB        | Complex structured values                |
| `description` | TEXT         | Human-readable description               |
| `modified_by` | UUID (FK)    | User who last modified                   |

The `SettingsService` reads vault configuration from this table, falling back to environment variables when no database setting exists.

### Database table: `ai_settings`

AI provider configuration is stored per-program (or globally when `program_id` is null):

| Column       | Type        | Description                                |
| ------------ | ----------- | ------------------------------------------ |
| `id`         | UUID        | Primary key                                |
| `program_id` | UUID (FK)   | Null = global default; set = per-program   |
| `provider`   | VARCHAR(50) | Provider name: `openai`, `anthropic`, etc. |
| `config`     | JSONB       | Provider config (model, API key, base URL) |
| `enabled`    | BOOLEAN     | Enable/disable AI for this scope           |

### Number sequences

Auto-generated item numbers (e.g., `PN-000001`, `DOC-000001`) are tracked in the `number_sequences` table:

| Column          | Type         | Description                                      |
| --------------- | ------------ | ------------------------------------------------ |
| `id`            | UUID         | Primary key                                      |
| `item_type`     | VARCHAR(50)  | Item type (Part, Document, etc.)                 |
| `scope_key`     | VARCHAR(200) | Scope: global, per-design, per-prefix, or yearly |
| `current_value` | INTEGER      | Last assigned sequence number                    |

---

## Configuration hierarchy

When multiple configuration sources exist, they are resolved in this order (highest priority first):

1. **Environment variables** -- Always win
2. **Database settings** (`settings` table) -- Override defaults
3. **Runtime item type configs** (`item_type_configs`) -- Override code definitions
4. **Code defaults** -- Hardcoded in TypeScript source

---

## Example: minimal `.env` for development

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia
SESSION_SECRET=dev-session-secret-change-in-prod
NODE_ENV=development
BASE_URL=http://localhost:3000
```

## Example: production `.env`

```bash
DATABASE_URL=postgresql://cascadia:${DB_PASSWORD}@db.example.com:5432/cascadia?sslmode=require
DATABASE_CA_CERT_PATH=/etc/ssl/certs/db-ca.pem
SESSION_SECRET=${SESSION_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
NODE_ENV=production
BASE_URL=https://plm.example.com
LOG_LEVEL=info

# S3 vault
VAULT_TYPE=s3
S3_BUCKET=cascadia-vault-prod
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
S3_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}

# Background jobs
RABBITMQ_URL=amqp://cascadia:${MQ_PASSWORD}@mq.example.com:5672

# AI
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

# OAuth
AZURE_TENANT_ID=${AZURE_TENANT_ID}
AZURE_CLIENT_ID=${AZURE_CLIENT_ID}
AZURE_CLIENT_SECRET=${AZURE_CLIENT_SECRET}
AZURE_REDIRECT_URI=https://plm.example.com/auth/callback/azure
```

## Further reading

- [Orchestration configuration reference](../orchestration/configuration.md) -- Docker Compose, Kubernetes, and cloud deployment variables
- [Runtime configuration deep dive](../runtime-configuration.md) -- Full runtime config system documentation with examples
