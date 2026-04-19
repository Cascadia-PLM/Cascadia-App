# Database Deployment Guide

Cascadia uses PostgreSQL 18+ as its data store. This guide covers deployment options from local development to enterprise cloud deployments.

## Connection Configuration

All services connect using a standard PostgreSQL connection string:

```
DATABASE_URL=postgresql://[user]:[password]@[host]:[port]/[database]?[options]
```

### Examples

```bash
# Local development
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia

# Docker Compose (container networking)
DATABASE_URL=postgresql://postgres:secret@postgres:5432/cascadia

# AWS RDS
DATABASE_URL=postgresql://cascadia:secret@mydb.abc123.us-east-1.rds.amazonaws.com:5432/cascadia?sslmode=require

# Google Cloud SQL (via proxy)
DATABASE_URL=postgresql://cascadia:secret@/cascadia?host=/cloudsql/project:region:instance

# Azure Database
DATABASE_URL=postgresql://cascadia@server:secret@server.postgres.database.azure.com:5432/cascadia?sslmode=require
```

## Deployment Options

### Option 1: Docker Container (Development/Small Production)

Best for: Development, testing, small teams, single-server deployments.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: cascadia
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      PGDATA: /var/lib/postgresql/data/pgdata
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d cascadia']
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

**Pros**: Simple, portable, no external dependencies
**Cons**: Manual backup/HA setup, not managed

### Option 2: AWS RDS

Best for: AWS deployments, managed service preference, production workloads.

#### Setup Steps

1. Create RDS PostgreSQL instance (15+)
2. Configure security group for your VPC
3. Create database and user
4. Set connection string in environment

#### Configuration

```bash
# Required
DATABASE_URL=postgresql://cascadia:${DB_PASSWORD}@myinstance.region.rds.amazonaws.com:5432/cascadia?sslmode=require

# Optional: Connection pooling via RDS Proxy
DATABASE_URL=postgresql://cascadia:${DB_PASSWORD}@myproxy.proxy-abc123.us-east-1.rds.amazonaws.com:5432/cascadia
```

#### Recommended Settings

| Setting          | Development | Production    |
| ---------------- | ----------- | ------------- |
| Instance Class   | db.t3.micro | db.r6g.large+ |
| Storage          | 20GB gp3    | 100GB+ gp3    |
| Multi-AZ         | No          | Yes           |
| Backup Retention | 7 days      | 30 days       |
| Encryption       | Optional    | Required      |

**Pros**: Managed backups, automatic failover, easy scaling
**Cons**: Cost, AWS lock-in

### Option 3: Google Cloud SQL

Best for: GCP deployments, Cloud Run integration.

#### Setup Steps

1. Create Cloud SQL PostgreSQL instance
2. Configure authorized networks or Cloud SQL Auth Proxy
3. Create database and user
4. Set connection string

#### Configuration with Cloud SQL Auth Proxy

```bash
# Cloud Run (automatic socket)
DATABASE_URL=postgresql://cascadia:${DB_PASSWORD}@/cascadia?host=/cloudsql/project:region:instance

# Compute Engine (via proxy sidecar)
DATABASE_URL=postgresql://cascadia:${DB_PASSWORD}@127.0.0.1:5432/cascadia
```

#### Recommended Settings

| Setting                | Development | Production         |
| ---------------------- | ----------- | ------------------ |
| Machine Type           | db-f1-micro | db-custom-4-16384+ |
| Storage                | 10GB SSD    | 100GB+ SSD         |
| High Availability      | No          | Regional           |
| Automated Backups      | Yes         | Yes                |
| Point-in-time Recovery | No          | Yes                |

**Pros**: Cloud Run integration, IAM authentication, regional HA
**Cons**: GCP lock-in, slightly higher latency via proxy

### Option 4: Azure Database for PostgreSQL

Best for: Azure deployments, enterprise Azure subscriptions.

#### Configuration

```bash
DATABASE_URL=postgresql://cascadia@server:${DB_PASSWORD}@server.postgres.database.azure.com:5432/cascadia?sslmode=require
```

Note: Azure uses `username@server` format for the user.

#### Recommended Settings

| Setting           | Development    | Production              |
| ----------------- | -------------- | ----------------------- |
| Tier              | Burstable B1ms | General Purpose D4s_v3+ |
| Storage           | 32GB           | 256GB+                  |
| High Availability | Disabled       | Zone Redundant          |
| Backup Retention  | 7 days         | 35 days                 |

**Pros**: Azure integration, Active Directory auth
**Cons**: Username format quirk, Azure lock-in

### Option 5: Self-Managed Server

Best for: On-premises requirements, specific compliance needs, existing DBA team.

#### Installation (Ubuntu/Debian)

```bash
# Install PostgreSQL 18
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt update
sudo apt install postgresql-18

# Create database
sudo -u postgres createdb cascadia
sudo -u postgres psql -c "CREATE USER cascadia WITH PASSWORD 'secret';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE cascadia TO cascadia;"
```

#### Remote Access Configuration

Edit `postgresql.conf`:

```
listen_addresses = '*'
```

Edit `pg_hba.conf`:

```
# Allow specific network
host    cascadia    cascadia    10.0.0.0/8    scram-sha-256
```

**Pros**: Full control, no cloud costs
**Cons**: Manual HA/backup, requires DBA expertise

## Schema Management

### Initial Setup

All Cascadia services share the same database schema. Run migrations from Core App:

```bash
# Docker Compose
docker-compose exec app npx drizzle-kit push

# Kubernetes
kubectl exec -it deployment/cascadia-app -- npx drizzle-kit push

# Direct (with DATABASE_URL set)
npx drizzle-kit push
```

### Migration Strategy

```bash
# Generate migration files (development)
npm run db:generate

# Apply migrations (production)
npm run db:push

# View current schema
npm run db:studio
```

### Multi-Service Access

All services connect to the same database:

- **Core App**: Full access to all tables
- **Vault Service**: Access to vault-related tables
- **Jobs Server**: Access to jobs and item tables

Consider separate database users with limited permissions per service for enhanced security.

## Connection Pooling

For high-traffic deployments, use connection pooling:

### PgBouncer (Self-Managed)

```yaml
pgbouncer:
  image: edoburu/pgbouncer
  environment:
    DATABASE_URL: postgresql://postgres:secret@postgres:5432/cascadia
    POOL_MODE: transaction
    MAX_CLIENT_CONN: 1000
    DEFAULT_POOL_SIZE: 50
  ports:
    - '6432:5432'
```

Application connects to PgBouncer:

```bash
DATABASE_URL=postgresql://postgres:secret@pgbouncer:5432/cascadia
```

### RDS Proxy (AWS)

1. Create RDS Proxy in AWS Console
2. Configure Secrets Manager for credentials
3. Update `DATABASE_URL` to proxy endpoint

### Cloud SQL Auth Proxy (GCP)

```yaml
# Sidecar container
cloudsql-proxy:
  image: gcr.io/cloudsql-docker/gce-proxy
  command: ['/cloud_sql_proxy', '-instances=project:region:instance=tcp:5432']
```

## Backup Strategies

### Docker/Self-Managed

```bash
# Backup
pg_dump -h localhost -U postgres cascadia > backup_$(date +%Y%m%d).sql

# Automated backup script
#!/bin/bash
BACKUP_DIR=/backups
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
pg_dump -h postgres -U postgres cascadia | gzip > $BACKUP_DIR/cascadia_$TIMESTAMP.sql.gz
find $BACKUP_DIR -mtime +30 -delete  # Keep 30 days
```

### Cloud-Managed

- **RDS**: Automated backups enabled by default
- **Cloud SQL**: Automated backups + on-demand snapshots
- **Azure**: Automated backups with configurable retention

## High Availability

### Docker Compose (Patroni)

For self-managed HA, consider [Patroni](https://github.com/zalando/patroni) with etcd.

### Cloud-Managed HA

| Provider  | HA Option      | Failover Time |
| --------- | -------------- | ------------- |
| AWS RDS   | Multi-AZ       | 1-2 minutes   |
| Cloud SQL | Regional       | ~1 minute     |
| Azure     | Zone Redundant | ~1 minute     |

## Performance Tuning

### Recommended PostgreSQL Settings

```
# Memory (adjust based on available RAM)
shared_buffers = 256MB              # 25% of RAM up to 8GB
effective_cache_size = 768MB        # 75% of RAM
work_mem = 16MB
maintenance_work_mem = 128MB

# Connections
max_connections = 200

# Write Performance
wal_buffers = 16MB
checkpoint_completion_target = 0.9

# Query Planning
random_page_cost = 1.1              # For SSD storage
effective_io_concurrency = 200      # For SSD storage
```

### Monitoring Queries

```sql
-- Active connections
SELECT count(*) FROM pg_stat_activity;

-- Long-running queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state != 'idle' AND now() - pg_stat_activity.query_start > interval '5 minutes';

-- Table sizes
SELECT schemaname, relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

## Security Best Practices

1. **Use strong passwords** - Generate random 32+ character passwords
2. **Enable SSL** - Always use `sslmode=require` in production
3. **Restrict network access** - Firewall database port to application servers only
4. **Use separate users** - One user per service with minimal permissions
5. **Enable audit logging** - Track who accessed what data
6. **Encrypt at rest** - Enable storage encryption (default on managed services)
7. **Regular backups** - Test restore procedures regularly
