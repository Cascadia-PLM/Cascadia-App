# Managed Cloud Database Deployment

Run Cascadia with a managed PostgreSQL database from AWS RDS, Google Cloud SQL, Azure Database for PostgreSQL, or any PostgreSQL-compatible managed service. The application runs in Docker while the database is fully managed by the cloud provider.

## When to Use

- Production environments requiring automated backups and failover
- Compliance requirements for managed database operations
- Teams that prefer not to manage PostgreSQL infrastructure
- Deployments already running on a cloud provider with managed database offerings
- Need for point-in-time recovery and automated patching

## Architecture

```
+-------------------------------------+
|        Application Server(s)        |
|                                     |
|  +-------------------------------+  |
|  |        Cascadia App           |  |
|  |   (Core + Vault + Jobs)       |  |
|  +---------------+---------------+  |
+-----------------+-------------------+
                  | TLS
                  |
+-----------------v-------------------+
|         Cloud Provider              |
|                                     |
|  +-------------------------------+  |
|  |     Managed PostgreSQL        |  |
|  |                               |  |
|  |  - Automated backups          |  |
|  |  - Multi-AZ failover          |  |
|  |  - Point-in-time recovery     |  |
|  |  - Automatic updates          |  |
|  +-------------------------------+  |
+-------------------------------------+
```

## Cloud Provider Setup

### AWS RDS

1. **Create an RDS PostgreSQL instance**:
   - Engine: PostgreSQL 18+
   - Instance class: `db.t3.medium` (development) or `db.r6g.large`+ (production)
   - Storage: 100 GB gp3
   - Multi-AZ: Yes for production
   - Encryption at rest: Enabled

2. **Configure the security group**:
   - Allow inbound TCP 5432 from application server IP addresses only
   - Do not allow public access

3. **Connection string**:
   ```bash
   DATABASE_URL=postgresql://cascadia:PASSWORD@mydb.abc123.us-east-1.rds.amazonaws.com:5432/cascadia?sslmode=require
   ```

| Setting          | Development | Production    |
| ---------------- | ----------- | ------------- |
| Instance Class   | db.t3.micro | db.r6g.large+ |
| Storage          | 20 GB gp3   | 100 GB+ gp3   |
| Multi-AZ         | No          | Yes           |
| Backup Retention | 7 days      | 30 days       |
| Encryption       | Optional    | Required      |

**Cost optimization**: Use Reserved Instances for predictable workloads. Consider Aurora Serverless for variable workloads.

### Google Cloud SQL

1. **Create a Cloud SQL PostgreSQL instance**:
   - Engine: PostgreSQL 18
   - Machine type: `db-custom-4-16384` (4 vCPU, 16 GB)
   - Storage: 100 GB SSD
   - High availability: Regional for production

2. **Configure access**:
   - Add application server IPs to Authorized Networks, or
   - Use Cloud SQL Auth Proxy (recommended for Cloud Run and GKE)

3. **Connection string**:

   Via Cloud SQL Auth Proxy (recommended):

   ```bash
   DATABASE_URL=postgresql://cascadia:PASSWORD@127.0.0.1:5432/cascadia
   ```

   Via Unix socket (Cloud Run):

   ```bash
   DATABASE_URL=postgresql://cascadia:PASSWORD@/cascadia?host=/cloudsql/project:region:instance
   ```

| Setting                | Development | Production         |
| ---------------------- | ----------- | ------------------ |
| Machine Type           | db-f1-micro | db-custom-4-16384+ |
| Storage                | 10 GB SSD   | 100 GB+ SSD        |
| High Availability      | No          | Regional           |
| Automated Backups      | Yes         | Yes                |
| Point-in-time Recovery | No          | Yes                |

**Cost optimization**: Use committed use discounts. Consider Cloud SQL Insights for query optimization.

### Azure Database for PostgreSQL

1. **Create a Flexible Server**:
   - Tier: General Purpose
   - vCores: 4
   - Storage: 100 GB
   - High Availability: Zone Redundant for production

2. **Configure firewall rules**:
   - Add application server IP addresses

3. **Connection string**:

   ```bash
   DATABASE_URL=postgresql://cascadia@server:PASSWORD@server.postgres.database.azure.com:5432/cascadia?sslmode=require
   ```

   Note: Azure uses the `username@server` format for the user field.

| Setting           | Development    | Production              |
| ----------------- | -------------- | ----------------------- |
| Tier              | Burstable B1ms | General Purpose D4s_v3+ |
| Storage           | 32 GB          | 256 GB+                 |
| High Availability | Disabled       | Zone Redundant          |
| Backup Retention  | 7 days         | 35 days                 |

**Cost optimization**: Use Reserved Capacity. Consider Hyperscale for very large databases.

## Deployment Steps

### Step 1: Create the Cloud Database

Follow your cloud provider's instructions above to provision the PostgreSQL instance.

### Step 2: Apply the Database Schema

For a fresh database there is nothing to do here. The compose template in Step 3
boots the app through `scripts/boot-migrate.ts`, which applies the committed
migrations under `apps/*/drizzle/` and only then starts the server -- so an empty
cloud database is brought to the current schema the first time the stack comes
up, and every later boot applies whatever the new image added.

Apply them ahead of the deployment instead -- from your local development
machine or a CI/CD pipeline -- when you want a failed migration to fail the
pipeline rather than the container, or when the schema has to be in place before
anything else is provisioned:

```bash
# Set DATABASE_URL to your cloud database
export DATABASE_URL=postgresql://cascadia:PASSWORD@<cloud-db-host>:5432/cascadia?sslmode=require

# Apply the committed migrations
npm run db:migrate
```

**Do not point `db:push` at a managed instance.** It diff-applies the declared
schema by whatever DDL that takes, unattended and unreviewed, which on a
populated database means dropping columns and tables to make it match the code.
It is the development, CI, and demo-stack path only.
[upgrading.md](./upgrading.md) is the canonical statement of the difference, and
carries the one-time `db:baseline` stamp that a database created before v0.5
needs before `db:migrate` will touch it.

### Step 3: Deploy the Application

```bash
cd docs/orchestration/deployments/cloud-database/
cp .env.example .env
```

Edit `.env`:

```bash
# REQUIRED
DATABASE_URL=postgresql://cascadia:PASSWORD@<cloud-db-host>:5432/cascadia?sslmode=require

# APPLICATION
APP_PORT=3000
BASE_URL=https://plm.example.com
NODE_ENV=production
APP_VERSION=latest

# FILE STORAGE (choose one)
# Option 1: Local storage (default)
VAULT_TYPE=local

# Option 2: AWS S3
# VAULT_TYPE=s3
# S3_BUCKET=cascadia-vault
# S3_REGION=us-east-1
# S3_ACCESS_KEY=AKIA...
# S3_SECRET_KEY=...
```

Start the application:

```bash
docker compose up -d
```

The compose file applies committed migrations on startup, through the guard in `scripts/boot-migrate.ts`:

```yaml
command: sh -c "npx tsx scripts/boot-migrate.ts && npm run serve"
```

### Step 4: Seed the Database (Optional)

```bash
docker compose exec app npm run db:seed
```

## Docker Compose Configuration

The cloud-database compose file runs only the application container -- no database:

```yaml
services:
  app:
    image: ghcr.io/cascadia-plm/cascadia-app:${APP_VERSION:-latest}
    restart: unless-stopped
    environment:
      NODE_ENV: ${NODE_ENV:-production}
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      BASE_URL: ${BASE_URL:-http://localhost:3000}
      VAULT_MODE: embedded
      VAULT_TYPE: ${VAULT_TYPE:-local}
      FILE_STORAGE_PATH: /app/storage/files
      VAULT_ROOT: /app/vault
      S3_BUCKET: ${S3_BUCKET:-}
      S3_REGION: ${S3_REGION:-}
      S3_ACCESS_KEY: ${S3_ACCESS_KEY:-}
      S3_SECRET_KEY: ${S3_SECRET_KEY:-}
      JOBS_MODE: embedded
    ports:
      - '${APP_PORT:-3000}:3000'
    volumes:
      - app_storage:/app/storage
      - app_vault:/app/vault
    command: sh -c "npx tsx scripts/boot-migrate.ts && npm run serve"
```

When using S3 storage, the local volumes (`app_storage`, `app_vault`) are not needed for file vault data, but the app may still use them for temporary files.

## File Storage Options

### Local Storage (Default)

Files are stored on the application server's filesystem in Docker volumes. Suitable for single-server deployments but not for multi-server setups.

### AWS S3

```bash
VAULT_TYPE=s3
S3_BUCKET=cascadia-vault
S3_REGION=us-east-1
S3_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
S3_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

### Google Cloud Storage (via S3 Interop)

```bash
VAULT_TYPE=s3
S3_BUCKET=cascadia-vault
S3_ENDPOINT=https://storage.googleapis.com
S3_ACCESS_KEY=GOOGXXXXXXXX
S3_SECRET_KEY=your-hmac-secret
```

### MinIO (Self-Hosted S3-Compatible)

```bash
VAULT_TYPE=s3
S3_BUCKET=cascadia-vault
S3_ENDPOINT=http://minio-host:9000
S3_ACCESS_KEY=cascadia
S3_SECRET_KEY=minio-password
S3_FORCE_PATH_STYLE=true
```

## Database SSL/TLS

Always use encrypted connections to cloud databases in production:

```bash
# Standard SSL
DATABASE_URL=postgresql://...?sslmode=require

# With CA certificate verification
DATABASE_URL=postgresql://...?sslmode=verify-ca
DATABASE_CA_CERT_PATH=/etc/ssl/certs/db-ca.pem
```

All major cloud providers enable SSL by default for managed PostgreSQL.

## Connection Pooling

For high-traffic deployments with multiple app servers, use a connection pooler:

### AWS RDS Proxy

1. Create an RDS Proxy in the AWS Console
2. Configure Secrets Manager for credentials
3. Update `DATABASE_URL` to the proxy endpoint

### PgBouncer (Self-Managed)

```yaml
pgbouncer:
  image: edoburu/pgbouncer
  environment:
    DATABASE_URL: postgresql://cascadia:PASSWORD@<cloud-db-host>:5432/cascadia
    POOL_MODE: transaction
    MAX_CLIENT_CONN: 1000
    DEFAULT_POOL_SIZE: 50
  ports:
    - '6432:5432'
```

### Cloud SQL Auth Proxy (GCP)

Run as a sidecar container or standalone service:

```yaml
cloudsql-proxy:
  image: gcr.io/cloudsql-docker/gce-proxy
  command: ['/cloud_sql_proxy', '-instances=project:region:instance=tcp:5432']
```

## Backup and Recovery

### AWS RDS

- Automated backups: 1-35 day configurable retention
- Point-in-time recovery: Within backup retention window
- Manual snapshots: Take before major schema changes

### Google Cloud SQL

- Automated backups: Daily, 7-day retention by default
- Point-in-time recovery: Up to 7 days
- On-demand backups: Available any time

### Azure Database

- Automated backups: 7-35 day configurable retention
- Geo-redundant backups: For cross-region disaster recovery
- Long-term retention: Up to 10 years

## Security Best Practices

1. **Never expose the database publicly.** Use VPC peering, private endpoints, or authorized networks.
2. **Always use SSL/TLS.** Include `sslmode=require` (or `verify-ca`) in the connection string.
3. **Rotate credentials regularly.** Use your provider's secrets manager (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault).
4. **Enable audit logging.** Track database access for compliance.
5. **Encrypt at rest.** Enabled by default on all major providers.
6. **Use separate database users per service.** Limit each service to only the tables it needs.
7. **Test restore procedures.** Regularly verify that backups can be restored.

## Troubleshooting

### Cannot Connect to Cloud Database

- **ECONNREFUSED**: Check that the database instance is running and the security group/firewall allows traffic from the app server IP.
- **Password authentication failed**: Verify the username and password in `DATABASE_URL`.
- **ETIMEDOUT**: Check VPC configuration, private endpoints, or network peering.
- **SSL error**: Add `?sslmode=require` or `?sslmode=disable` (for debugging only) to the connection string.

### The App Refuses to Start With "no migration journal"

`scripts/boot-migrate.ts` decides between three states before the server starts:
a journal with entries means apply whatever is new, an empty journal on an empty
database means apply the baseline and everything after it, and an empty journal
on a database that _already has tables_ means stop. The third is what a database
created before v0.5 looks like -- its schema came from `db:push`, which records
nothing -- and migrating it would replay the baseline over live tables. Boot
changes nothing, prints this, and exits non-zero:

```
[boot] REFUSING to start: this database has tables but no migration journal.
```

Stamp the baseline as already applied, once, then bring the stack back up. The
refusing container is restarting on a loop, so run the stamp as a one-off
container rather than exec-ing into the one that keeps exiting:

```bash
docker compose run --rm app npx tsx scripts/db-baseline.ts
docker compose up -d
```

`db-baseline` verifies that the live schema matches the baseline before stamping
and refuses if it does not; nothing in the database has been changed by the
failed boot. Every boot after the stamp applies what is new and does nothing
when there is nothing new, so restarts stay free. See
[upgrading.md](./upgrading.md#upgrading-an-install-created-before-v050) for the
full procedure, including the backup to take first.

### Migrations Fail With a Permissions Error

A failure rather than a refusal usually means the app's database user lacks
CREATE and ALTER on the target schema. Grant them, or apply the migrations
separately as in [Step 2](#step-2-apply-the-database-schema) with a role that
has them.

### Empty Database After Deployment

If pages return 500 errors with `relation "program_members" does not exist`, the
migrations never ran -- check the app's startup output for the `[boot]` lines
above. Apply them by hand and seed:

```bash
docker compose exec app npm run db:migrate
docker compose exec app npm run db:seed
```
