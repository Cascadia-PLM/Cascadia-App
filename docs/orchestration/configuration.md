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

| Variable       | Description                  | Example                               |
| -------------- | ---------------------------- | ------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |

There is no session-secret variable: sessions are opaque random tokens stored
hashed in the database, so no signing key exists to configure or rotate.

### Security

| Variable                | Description                                                                                                                                                       | Example                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`        | AES-256-GCM key for encrypting admin-entered provider API keys at rest - 64 hex chars. When unset, those keys are stored in plaintext (the server logs a warning) | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_CA_CERT_PATH` | Path to CA certificate for database SSL/TLS verification                                                                                                          | `/etc/ssl/certs/db-ca.pem`                                                               |

### Application Settings

| Variable    | Default                 | Description                                                                                                           |
| ----------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`  | `production`            | Environment mode (`development`, `production`, `test`)                                                                |
| `PORT`      | `3000`                  | HTTP port to listen on                                                                                                |
| `BASE_URL`  | `http://localhost:3000` | Public URL of the application. Read only to build the OAuth callback URL (GitHub); everything else is origin-relative |
| `LOG_LEVEL` | `info`                  | Logging verbosity (`debug`, `info`, `warn`, `error`)                                                                  |

### Security Headers

The application sets baseline security headers on all API responses (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`). CSP and HSTS should be configured at the reverse proxy / ingress layer since they require environment-specific tuning.

The Kubernetes ingress (`docs/orchestration/deployments/kubernetes/ingress.yaml`) includes these automatically. For other deployments, configure your reverse proxy with:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Adjust `script-src` and `style-src` to remove `'unsafe-inline'` if your deployment supports nonce-based or hash-based CSP.

### Client IP Trust

Rate-limit buckets, `auth_events` rows and API-key activity records are all keyed on the caller's address. `X-Forwarded-For` is a request header, so the caller writes it too — the app therefore believes only as many forwarded hops as you declare.

| Variable              | Default | Description                                                              |
| --------------------- | ------- | ------------------------------------------------------------------------ |
| `TRUSTED_PROXY_COUNT` | `0`     | How many reverse proxies in front of the app append to `X-Forwarded-For` |

Set it to the number of proxies a request genuinely passes through on its way in:

- `0` — nothing in front of the app, or you have not checked. Forwarded headers are ignored entirely and the TCP peer address is the answer.
- `1` — one nginx, Traefik, ALB or ingress controller terminating for the app.
- `2` — a CDN or WAF in front of that load balancer.

Entries are counted **from the right**, because each proxy appends the address it saw. With `TRUSTED_PROXY_COUNT=2` and `X-Forwarded-For: 192.0.2.66, 203.0.113.7, 10.0.0.4`, the app reads `203.0.113.7` — the address the outermost trusted proxy observed — and discards `192.0.2.66`, which the caller supplied. A header carrying fewer entries than the declared depth, or whose trusted entry is not an address, falls back to the peer address; it never falls forward to the leftmost, caller-chosen entry.

> **Leaving this at `0` behind a proxy is safe but blunt.** Every request resolves to the proxy's own address, so everyone behind it shares one rate-limit bucket and audit rows record the proxy rather than the client. That fails closed — nobody can forge their way into a private bucket — but one abusive client can spend the shared login budget for everybody. Set the real depth.

Two requirements on the proxy itself:

- It must **append** to `X-Forwarded-For`, not replace it. nginx's `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` does; a bare `$remote_addr` does not, and would leave a one-entry header where the app expects the chain.
- `X-Real-IP` alone is not read. A proxy that sets only that header must also be configured to append `X-Forwarded-For`.

### Rate Limiting

Sliding-window limits, held per instance and per resolved client address (above). Multi-instance deployments count independently — this is abuse prevention, not metering.

| Variable                       | Default | Description                                                         |
| ------------------------------ | ------- | ------------------------------------------------------------------- |
| `RATE_LIMIT_ENFORCE`           | unset   | Set to `true` to enforce limits when `NODE_ENV` is not `production` |
| `RATE_LIMIT_LOGIN_PER_MINUTE`  | `10`    | Budget for login and password endpoints                             |
| `RATE_LIMIT_API_PER_MINUTE`    | `1000`  | Budget for every other route that does not opt out                  |
| `RATE_LIMIT_UPLOAD_PER_MINUTE` | `100`   | Budget for file uploads                                             |

Limits are enforced whenever `NODE_ENV=production`, which every containerized deployment and both editions' built entrypoints set. `RATE_LIMIT_ENFORCE=true` is for the one case that gate misses: a staging box running the development server that still wants the login budget enforced.

Raise the per-minute budgets for deployments where many users share one egress address — a corporate NAT puts a whole office in one bucket, and a single page load spends several API requests. An unset, unparseable or non-positive value falls back to the default rather than removing the limit.

### Vault Configuration

| Variable     | Default      | Description                      |
| ------------ | ------------ | -------------------------------- |
| `VAULT_TYPE` | `local`      | Storage backend: `local` or `s3` |
| `VAULT_ROOT` | `/app/vault` | Local storage directory          |

> **Note:** the app always uses its configured storage backend directly — the
> local root resolves DB setting → `VAULT_ROOT` → `./vault`. There is no
> remote vault service to point it at.

### Jobs Configuration

| Variable       | Default | Description            |
| -------------- | ------- | ---------------------- |
| `RABBITMQ_URL` | -       | AMQP URL for job queue |

### OAuth Providers (Optional)

GitHub is the only implemented provider. Setting both variables is what enables it
-- there is no separate on/off flag -- and the callback URL is derived from `BASE_URL`
(`{BASE_URL}/api/v1/auth/callback/github`), so it has no variable of its own.

| Variable               | Description                |
| ---------------------- | -------------------------- |
| `GITHUB_CLIENT_ID`     | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app secret    |

No `GOOGLE_*` or `AZURE_*` variable is read by any code. Those providers are
roadmap items, not configuration.

### Optional Packages

Separately-licensed functionality. Read once at process start; there is no
in-app toggle, so an instance cannot enable a package it is not entitled to.

| Variable            | Default | Description                                                                                     |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `CASCADIA_PACKAGES` | -       | Comma-separated package ids, or `*` for all. Known ids: `advanced-auditing`, `odoo-integration` |

### Advanced Auditing Package

Only meaningful when `CASCADIA_PACKAGES` includes `advanced-auditing`. See
[Advanced Auditing](../features/advanced-auditing.md) for the required reverse
proxy configuration.

| Variable                                   | Default              | Description                                                                                                   |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CASCADIA_SIGNATURE_METHOD`                | `pki-preferred`      | Credential required to sign: `pki`, `pki-preferred`, or `password`. Use `pki` for DoD deployments.            |
| `CASCADIA_CLIENT_CERT_HEADER`              | -                    | Header the mTLS terminator forwards the client certificate in. **PKI signing is disabled until this is set.** |
| `CASCADIA_SIGNING_CA_BUNDLE`               | -                    | Path to a PEM bundle of trusted issuers (e.g. the DoD PKI roots).                                             |
| `CASCADIA_SIGNATURE_REQUIRE_TRUSTED_CHAIN` | `true` with a bundle | Reject certificates that do not chain to a configured anchor.                                                 |
| `CASCADIA_SIGNATURE_ENROLLMENT`            | `auto`               | How a card binds to a user: `auto` (trust on first use) or `admin`.                                           |
| `CASCADIA_PDF_SIGNING_P12`                 | -                    | PKCS#12 archive holding the instance signing key. **Signing released PDFs is disabled until this is set.**    |
| `CASCADIA_PDF_SIGNING_PASSPHRASE`          | `''`                 | Passphrase for that archive.                                                                                  |
| `CASCADIA_PDF_SIGNING_NAME`                | `Cascadia PLM`       | Signer name shown in a PDF reader's signature panel.                                                          |
| `CASCADIA_PDF_SIGNING_CONTACT`             | -                    | Contact shown alongside the signature.                                                                        |
| `CASCADIA_PDF_SIGNING_LOCATION`            | -                    | Location shown alongside the signature.                                                                       |
| `CASCADIA_AUDIT_ANCHOR_PERIOD_MS`          | `86400000` (24h)     | Gap between scheduled chain anchors. `0` opts out of scheduled anchoring.                                     |

> **Security:** `CASCADIA_CLIENT_CERT_HEADER` makes Cascadia trust a request
> header as proof of identity. Only set it once the reverse proxy overwrites
> that header on every request and the app is unreachable except through it.

**Chain anchoring rides the jobs worker.** Setting `CASCADIA_PDF_SIGNING_P12`
is what turns anchoring on: the worker's maintenance sweep then submits the
`audit.anchor.chains` job every `CASCADIA_AUDIT_ANCHOR_PERIOD_MS`. A deployment
with the package licensed but no signing credential never anchors and nothing
fails to say so — `GET /api/v1/signatures/anchors` is the health check, and
reports `configured: false` on exactly that instance. An instance that already
submits the job from its own scheduler should set the period to `0`, or it will
anchor twice a period (harmless — anchors are append-only evidence — but it
doubles the reconciliation scan). Anchoring runs only where the jobs worker
runs; an app-only deployment takes no anchors.

---

## Vault Storage Configuration

The file vault runs inside the Core App — there is no standalone vault
service. `VAULT_TYPE=local` (the default) stores files under `VAULT_ROOT`.
For S3-compatible storage:

```bash
VAULT_TYPE=s3
S3_BUCKET=cascadia-vault
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_ENDPOINT=                        # Leave empty for AWS, set for MinIO
S3_FORCE_PATH_STYLE=false           # Set true for MinIO
```

---

## Jobs Server Configuration

### Required Variables

| Variable       | Description                  |
| -------------- | ---------------------------- |
| `DATABASE_URL` | PostgreSQL connection string |
| `RABBITMQ_URL` | AMQP connection string       |

### Worker Settings

| Variable                      | Default  | Description                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------------- |
| `WORKER_CONCURRENCY`          | `5`      | Max concurrent jobs per worker                                      |
| `JOB_TYPES`                   | `*`      | Job types to process (comma-separated or `*`)                       |
| `JOB_TIMEOUT`                 | `300000` | Default job timeout (ms)                                            |
| `MAX_RETRIES`                 | `3`      | Default retry attempts                                              |
| `WORKER_CLAIM_RETRY_DELAY_MS` | `5000`   | Pause before requeueing a delivery whose claim hit a database error |

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

Workers read and write vault files through the shared storage backend — a
vault directory both containers mount, or S3.

For direct S3 access:

```bash
S3_BUCKET=cascadia-vault
S3_REGION=us-east-1
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
```

---

## CAD Worker Timeout Enforcement

The Python CAD workers (`cad-converter`, `cad-generator`) enforce `JOB_TIMEOUT`
themselves, in two stages. A pythonocc or CadQuery call that wedges inside
native code cannot be interrupted — a Python thread cannot be killed, and one
parked in a C extension never reaches the interpreter to be asked to stop — so
the deadline is enforced from the outside.

At the deadline the worker marks the job failed through the same guarded
update any other failure uses: the row leaves 'running' and rejoins the
ordinary attempts ledger, parking for retry or failing terminally. If the job's
thread is **still** alive `POISON_EXIT_GRACE_MS` after that, the slot is not
coming back, so the worker logs a critical line and exits with status 1 and the
container restart policy reclaims it. Jobs that were still running in that
process are left 'running' and recovered by the app's stale-running sweep
(`JOB_STALE_RUNNING_GRACE_MS`).

The grace window is what makes the second stage safe: a conversion that merely
overran its deadline and then finished costs only its own row, never the other
jobs sharing the process.

| Variable               | Default                               | Description                                                                |
| ---------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `JOB_TIMEOUT`          | `600000` converter, `60000` generator | How long a single job may run, in milliseconds                             |
| `POISON_EXIT_GRACE_MS` | `60000`                               | Extra time a timed-out job's thread gets before the worker restarts itself |
| `EXIT_ON_HUNG_JOB`     | `true`                                | Kill switch for that restart; the timeout is still recorded when off       |

Raise `JOB_TIMEOUT` for deployments whose STEP files legitimately take longer
than the default. Nothing distinguishes "slow" from "hung", so a timeout that is
too low now burns a job's retry attempts rather than being ignored, as it was
before enforcement existed.

Set `EXIT_ON_HUNG_JOB=false` to keep a wedged container alive for debugging.
Timed-out jobs are still failed and retried; the worker simply keeps the lost
concurrency slot until someone restarts it by hand.

---

## PostgreSQL Configuration

When running PostgreSQL in Docker.

| Variable            | Default                           | Description                                                                  |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `POSTGRES_DB`       | `cascadia`                        | Database name                                                                |
| `POSTGRES_USER`     | `postgres`                        | Database user                                                                |
| `POSTGRES_PASSWORD` | — (required)                      | No compose default — the stack refuses to start without it                   |
| `POSTGRES_BIND`     | `127.0.0.1`                       | Host bind address for the port mapping; set `0.0.0.0` to expose deliberately |
| `PGDATA`            | `/var/lib/postgresql/data/pgdata` | Data directory                                                               |

---

## RabbitMQ Configuration

When running RabbitMQ in Docker.

| Variable            | Default     | Description                                                                         |
| ------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `RABBITMQ_USER`     | `cascadia`  | Management user (compose maps it to `RABBITMQ_DEFAULT_USER`)                        |
| `RABBITMQ_PASSWORD` | `cascadia`  | Management password — change it for any shared deployment                           |
| `RABBITMQ_VHOST`    | `/`         | Default virtual host                                                                |
| `RABBITMQ_BIND`     | `127.0.0.1` | Host bind for the AMQP and management-UI ports; loopback keeps them off the network |

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

# Vault (local storage)
VAULT_TYPE=local
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
  RABBITMQ_URL: 'amqp://...'
```

---

## Validation

### Required Variable Checks

On startup, services validate required variables:

```typescript
const required = ['DATABASE_URL']
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

services:
  app:
    secrets:
      - db_password
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
```
