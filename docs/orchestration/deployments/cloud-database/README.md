# Cloud Database Deployment

Run Cascadia with a managed cloud database (AWS RDS, Google Cloud SQL, Azure Database).

## Architecture

```
┌─────────────────────────────────────┐
│        Application Server(s)        │
│                                     │
│  ┌───────────────────────────────┐  │
│  │        Cascadia App           │  │
│  │   (Core + Vault + Jobs)       │  │
│  └───────────────┬───────────────┘  │
└──────────────────┼──────────────────┘
                   │ TLS
                   │
┌──────────────────▼──────────────────┐
│         Cloud Provider              │
│                                     │
│  ┌───────────────────────────────┐  │
│  │     Managed PostgreSQL        │  │
│  │                               │  │
│  │  - AWS RDS                    │  │
│  │  - Google Cloud SQL           │  │
│  │  - Azure Database             │  │
│  │                               │  │
│  │  Features:                    │  │
│  │  - Automated backups          │  │
│  │  - Multi-AZ failover          │  │
│  │  - Point-in-time recovery     │  │
│  │  - Automatic updates          │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

## When to Use

- Production environments
- Compliance requirements for managed backups
- Need for automated failover
- Prefer managed database operations
- Budget available for managed services

## Cloud Provider Setup

### AWS RDS

1. **Create RDS Instance**

   ```
   Engine: PostgreSQL 18+
   Instance: db.t3.medium (adjust for workload)
   Storage: 100GB gp3
   Multi-AZ: Yes (production)
   ```

2. **Security Group**
   - Allow inbound 5432 from application servers only

3. **Connection String**
   ```bash
   DATABASE_URL=postgresql://cascadia:PASSWORD@mydb.abc123.us-east-1.rds.amazonaws.com:5432/cascadia?sslmode=require
   ```

### Google Cloud SQL

1. **Create Instance**

   ```
   Engine: PostgreSQL 18
   Machine: db-custom-4-16384 (4 vCPU, 16GB)
   Storage: 100GB SSD
   High Availability: Regional
   ```

2. **Authorized Networks**
   - Add application server IPs or use Cloud SQL Proxy

3. **Connection String (via proxy)**
   ```bash
   DATABASE_URL=postgresql://cascadia:PASSWORD@127.0.0.1:5432/cascadia
   ```
   Or with Unix socket:
   ```bash
   DATABASE_URL=postgresql://cascadia:PASSWORD@/cascadia?host=/cloudsql/project:region:instance
   ```

### Azure Database for PostgreSQL

1. **Create Server**

   ```
   Tier: General Purpose
   vCores: 4
   Storage: 100GB
   High Availability: Zone Redundant
   ```

2. **Firewall Rules**
   - Add application server IPs

3. **Connection String**
   ```bash
   DATABASE_URL=postgresql://cascadia@server:PASSWORD@server.postgres.database.azure.com:5432/cascadia?sslmode=require
   ```
   Note: Azure uses `username@server` format.

## Deployment

### Step 1: Create Cloud Database

Follow your cloud provider's instructions above.

### Step 2: Create Database Schema

```bash
# From your local machine with DATABASE_URL set
cd CascadiaApp
npx drizzle-kit push
```

### Step 3: Deploy Application

```bash
# On application server
cd deployments/cloud-database
cp .env.example .env
# Edit .env with your cloud DATABASE_URL

docker-compose up -d
```

## Files

- `docker-compose.yml` - Application only (no database)
- `.env.example` - Configuration template

## Cost Optimization

### AWS RDS

- Use Reserved Instances for predictable workloads
- Consider Aurora Serverless for variable workloads
- Use read replicas for read-heavy applications

### Google Cloud SQL

- Use committed use discounts
- Consider Cloud SQL Insights for query optimization
- Scale down during off-hours (if applicable)

### Azure

- Use Reserved Capacity
- Consider Hyperscale for very large databases
- Use Flexible Server for dev/test (cost-effective)

## Security Best Practices

1. **Never expose database publicly**
   - Use VPC peering or private endpoints

2. **Use SSL/TLS**
   - Always include `sslmode=require` in connection string

3. **Rotate credentials regularly**
   - Use AWS Secrets Manager, GCP Secret Manager, or Azure Key Vault

4. **Enable audit logging**
   - Track database access for compliance

5. **Encrypt at rest**
   - Enabled by default on all major providers

## Backup and Recovery

### AWS RDS

```bash
# Automated backups: Configure retention period (1-35 days)
# Point-in-time recovery: Within backup retention window
# Manual snapshots: Keep before major changes
```

### Google Cloud SQL

```bash
# Automated backups: Daily, 7-day retention default
# Point-in-time recovery: Up to 7 days
# On-demand backups: Before migrations
```

### Azure Database

```bash
# Automated backups: 7-35 days retention
# Geo-redundant backups: For disaster recovery
# Long-term retention: Up to 10 years
```
