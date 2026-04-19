# Configuration Reference

Complete reference for all environment variables used across Cascadia services.

## Configuration Hierarchy

1. **Environment Variables** - Highest priority, set at runtime
2. **`.env` Files** - Loaded on startup (development)
3. **Docker Compose** - Environment section in compose files
4. **Kubernetes** - ConfigMaps and Secrets
5. **Defaults** - Hardcoded fallbacks

## Core App Configuration

### Required Variables

| Variable         | Description                               | Example                               |
| ---------------- | ----------------------------------------- | ------------------------------------- |
| `DATABASE_URL`   | PostgreSQL connection string              | `postgresql://user:pass@host:5432/db` |
| `SESSION_SECRET` | Secret for session encryption (32+ chars) | `your-random-32-character-string`     |

### Security

| Variable                | Description                                                         | Example                                                                                  |
| ----------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`        | AES-256 key for encrypting sensitive data (API keys) - 64 hex chars | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_CA_CERT_PATH` | Path to CA certificate for database SSL/TLS verification            | `/etc/ssl/certs/db-ca.pem`                                                               |

### Application Settings

| Variable    | Default                 | Description                                            |
| ----------- | ----------------------- | ------------------------------------------------------ |
| `NODE_ENV`  | `production`            | Environment mode (`development`, `production`, `test`) |
| `PORT`      | `3000`                  | HTTP port to listen on                                 |
| `BASE_URL`  | `http://localhost:3000` | Public URL of the application                          |
| `LOG_LEVEL` | `info`                  | Logging verbosity (`debug`, `info`, `warn`, `error`)   |

### Security Headers

The application sets baseline security headers on all API responses (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`). CSP and HSTS should be configured at the reverse proxy / ingress layer since they require environment-specific tuning.

The Kubernetes ingress (`docs/orchestration/deployments/kubernetes/ingress.yaml`) includes these automatically. For other deployments, configure your reverse proxy with:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Adjust `script-src` and `style-src` to remove `'unsafe-inline'` if your deployment supports nonce-based or hash-based CSP.

### Vault Configuration

| Variable              | Default              | Description                                |
| --------------------- | -------------------- | ------------------------------------------ |
| `VAULT_TYPE`          | `local`              | Storage backend: `local` or `s3`           |
| `VAULT_ROOT`          | `/app/vault`         | Local storage directory                    |
| `FILE_STORAGE_PATH`   | `/app/storage/files` | General file storage                       |
| `VAULT_SERVICE_URL`   | -                    | URL when running vault as separate service |
| `VAULT_SERVICE_TOKEN` | -                    | Auth token for vault service               |

### Jobs Configuration

| Variable       | Default | Description            |
| -------------- | ------- | ---------------------- |
| `RABBITMQ_URL` | -       | AMQP URL for job queue |

### OAuth Providers (Optional)

| Variable               | Description                |
| ---------------------- | -------------------------- |
| `GITHUB_CLIENT_ID`     | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app secret    |
| `GOOGLE_CLIENT_ID`     | Google OAuth client ID     |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `AZURE_CLIENT_ID`      | Azure AD OAuth client ID   |
| `AZURE_CLIENT_SECRET`  | Azure AD OAuth secret      |
| `AZURE_TENANT_ID`      | Azure AD tenant ID         |

---

## Vault Service Configuration

When running vault as a standalone service.

### Required Variables

| Variable        | Description                               |
| --------------- | ----------------------------------------- |
| `DATABASE_URL`  | PostgreSQL connection string              |
| `SERVICE_TOKEN` | Shared secret for Core App authentication |

### Storage Configuration

#### Local Storage

```bash
STORAGE_TYPE=local
STORAGE_PATH=/app/vault
```

#### S3/MinIO Storage

```bash
STORAGE_TYPE=s3
S3_BUCKET=cascadia-vault
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_ENDPOINT=                        # Leave empty for AWS, set for MinIO
S3_FORCE_PATH_STYLE=false           # Set true for MinIO
```

#### Azure Blob Storage

```bash
STORAGE_TYPE=azure
AZURE_STORAGE_ACCOUNT=cascadiavault
AZURE_STORAGE_KEY=your-storage-key
AZURE_CONTAINER=vault
```

### Service Settings

| Variable             | Default | Description                                |
| -------------------- | ------- | ------------------------------------------ |
| `PORT`               | `3001`  | HTTP port for internal API                 |
| `MAX_FILE_SIZE`      | `500MB` | Maximum upload size                        |
| `ALLOWED_EXTENSIONS` | `*`     | Comma-separated whitelist (or `*` for all) |

---

## Jobs Server Configuration

### Required Variables

| Variable       | Description                  |
| -------------- | ---------------------------- |
| `DATABASE_URL` | PostgreSQL connection string |
| `RABBITMQ_URL` | AMQP connection string       |

### Worker Settings

| Variable             | Default  | Description                                   |
| -------------------- | -------- | --------------------------------------------- |
| `WORKER_CONCURRENCY` | `5`      | Max concurrent jobs per worker                |
| `JOB_TYPES`          | `*`      | Job types to process (comma-separated or `*`) |
| `JOB_TIMEOUT`        | `300000` | Default job timeout (ms)                      |
| `MAX_RETRIES`        | `3`      | Default retry attempts                        |

### Specialized Workers

```bash
# General worker
JOB_TYPES=reports,notifications,cleanup,integration

# CAD conversion worker (dedicated hardware)
JOB_TYPES=conversion.cad
WORKER_CONCURRENCY=2

# Office conversion worker
JOB_TYPES=conversion.office
WORKER_CONCURRENCY=10
```

### Email Configuration (for notifications)

| Variable      | Required | Default                  | Description                          |
| ------------- | -------- | ------------------------ | ------------------------------------ |
| `SMTP_HOST`   | Yes\*    | -                        | SMTP server hostname                 |
| `SMTP_PORT`   | No       | `587`                    | SMTP port (587 for TLS, 465 for SSL) |
| `SMTP_USER`   | If auth  | -                        | SMTP username                        |
| `SMTP_PASS`   | If auth  | -                        | SMTP password                        |
| `SMTP_FROM`   | No       | `noreply@cascadia.local` | From address for emails              |
| `SMTP_SECURE` | No       | `false`                  | Use SSL (true for port 465)          |

\*Required when processing notification jobs. In development, emails are logged to console.

```bash
# Example: Gmail
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=notifications@yourcompany.com

# Example: Amazon SES
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=AKIAIOSFODNN7EXAMPLE
SMTP_PASS=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
SMTP_FROM=plm@yourcompany.com
```

### File Access

| Variable              | Description                       |
| --------------------- | --------------------------------- |
| `VAULT_SERVICE_URL`   | Vault service URL for file access |
| `VAULT_SERVICE_TOKEN` | Auth token for vault service      |

Or for direct S3 access:

```bash
S3_BUCKET=cascadia-vault
S3_REGION=us-east-1
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
```

---

## PostgreSQL Configuration

When running PostgreSQL in Docker.

| Variable            | Default                           | Description                  |
| ------------------- | --------------------------------- | ---------------------------- |
| `POSTGRES_DB`       | `cascadia`                        | Database name                |
| `POSTGRES_USER`     | `postgres`                        | Database user                |
| `POSTGRES_PASSWORD` | -                                 | Database password (required) |
| `PGDATA`            | `/var/lib/postgresql/data/pgdata` | Data directory               |

---

## RabbitMQ Configuration

When running RabbitMQ in Docker.

| Variable                 | Default | Description          |
| ------------------------ | ------- | -------------------- |
| `RABBITMQ_DEFAULT_USER`  | `guest` | Management user      |
| `RABBITMQ_DEFAULT_PASS`  | `guest` | Management password  |
| `RABBITMQ_DEFAULT_VHOST` | `/`     | Default virtual host |

Connection string format:

```
amqp://user:password@host:5672/vhost
```

---

## MinIO Configuration

When running MinIO for S3-compatible storage.

| Variable              | Default | Description               |
| --------------------- | ------- | ------------------------- |
| `MINIO_ROOT_USER`     | -       | Admin username            |
| `MINIO_ROOT_PASSWORD` | -       | Admin password (8+ chars) |
| `MINIO_BROWSER`       | `on`    | Enable web console        |

---

## Environment File Examples

### Development (`.env`)

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia

# Security
SESSION_SECRET=dev-session-secret-change-in-prod

# Application
NODE_ENV=development
BASE_URL=http://localhost:3000
LOG_LEVEL=debug

# Vault (local storage)
VAULT_TYPE=local
VAULT_ROOT=./vault-storage
```

### Docker Compose (`.env.docker`)

```bash
# Database
POSTGRES_DB=cascadia
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-this-password
POSTGRES_PORT=5432

# Application
APP_PORT=3000
NODE_ENV=production
BASE_URL=http://localhost:3000
SESSION_SECRET=generate-a-random-32-character-string

# Vault (local storage)
VAULT_TYPE=local
FILE_STORAGE_PATH=/app/storage/files
VAULT_ROOT=/app/vault

# Tools (optional)
PGADMIN_EMAIL=admin@example.com
PGADMIN_PASSWORD=admin
PGADMIN_PORT=5050
```

### Production (Example)

```bash
# Database (managed)
DATABASE_URL=postgresql://cascadia:${DB_PASSWORD}@db.example.com:5432/cascadia?sslmode=require

# Security
SESSION_SECRET=${SESSION_SECRET}  # From secrets manager

# Application
NODE_ENV=production
BASE_URL=https://plm.example.com
LOG_LEVEL=info

# Vault (S3)
VAULT_TYPE=s3
S3_BUCKET=cascadia-vault-prod
S3_REGION=us-east-1
S3_ACCESS_KEY=${AWS_ACCESS_KEY}
S3_SECRET_KEY=${AWS_SECRET_KEY}

# Jobs
RABBITMQ_URL=amqp://cascadia:${MQ_PASSWORD}@mq.example.com:5672

# OAuth
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
```

### Kubernetes ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cascadia-config
data:
  NODE_ENV: 'production'
  BASE_URL: 'https://plm.example.com'
  LOG_LEVEL: 'info'
  VAULT_SERVICE_URL: 'http://vault-service:3001'
```

### Kubernetes Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cascadia-secrets
type: Opaque
stringData:
  DATABASE_URL: 'postgresql://...'
  SESSION_SECRET: '...'
  VAULT_SERVICE_TOKEN: '...'
  RABBITMQ_URL: 'amqp://...'
```

---

## Validation

### Required Variable Checks

On startup, services validate required variables:

```typescript
const required = ['DATABASE_URL', 'SESSION_SECRET']
const missing = required.filter((key) => !process.env[key])

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`)
  process.exit(1)
}
```

### Connection Testing

Services test connections on startup:

```typescript
// Database
await db.execute(sql`SELECT 1`)

// RabbitMQ (if configured)
if (process.env.RABBITMQ_URL) {
  await rabbitmq.connect()
}

// Vault Service (if external)
if (process.env.VAULT_SERVICE_URL) {
  await fetch(`${process.env.VAULT_SERVICE_URL}/health`)
}
```

---

## Secrets Management

### Development

Use `.env` files (never commit to git):

```bash
# Add to .gitignore
.env
.env.local
.env.*.local
```

### Docker Compose

Use Docker secrets for sensitive values:

```yaml
secrets:
  db_password:
    file: ./secrets/db_password.txt
  session_secret:
    file: ./secrets/session_secret.txt

services:
  app:
    secrets:
      - db_password
      - session_secret
    environment:
      DATABASE_URL: postgresql://postgres:$(cat /run/secrets/db_password)@postgres:5432/cascadia
```

### Kubernetes

Use Kubernetes Secrets:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cascadia-secrets
type: Opaque
data:
  database-url: cG9zdGdyZXNxbDovLy4uLg== # base64 encoded
```

### Cloud Providers

- **AWS**: Secrets Manager or Parameter Store
- **GCP**: Secret Manager
- **Azure**: Key Vault

Integration example (AWS):

```typescript
import { SecretsManager } from '@aws-sdk/client-secrets-manager'

const secrets = new SecretsManager({ region: 'us-east-1' })
const { SecretString } = await secrets.getSecretValue({
  SecretId: 'cascadia/prod',
})
const config = JSON.parse(SecretString)

process.env.DATABASE_URL = config.DATABASE_URL
process.env.SESSION_SECRET = config.SESSION_SECRET
```
