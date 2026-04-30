# Deployment Installer

Cascadia includes an interactive CLI installer that generates deployment configurations for your environment.

## Quick Start

```bash
cd CascadiaApp
npm run deploy:install
```

The installer will guide you through selecting a deployment type and configuring the necessary options.

## Features

- **Interactive prompts** - Guided wizard with input validation
- **Secure secret generation** - Auto-generates SESSION_SECRET and passwords
- **Database validation** - Optional connection testing before generating files
- **Multiple output formats** - Docker Compose and Kubernetes manifests
- **Auto-deploy option** - Can run `docker compose up` after generation

## Deployment Types

### Single Server

All services on one machine. Best for development and small teams.

**Generated files:**

- `.env` - Environment variables with secrets
- `docker-compose.yml` - PostgreSQL + App + optional pgAdmin

**Example usage:**

```bash
npm run deploy:install
# Select: Single Server
# Follow prompts...
cd ./deploy/single-server
docker compose up -d
```

### Distributed

Separate infrastructure, app, and jobs servers for high availability.

**Generated files:**

- `infrastructure/.env` and `docker-compose.yml` - PostgreSQL, RabbitMQ, MinIO
- `app/.env` and `docker-compose.yml` - Application servers
- `jobs/.env` and `docker-compose.yml` - Background workers

**Example usage:**

```bash
npm run deploy:install
# Select: Distributed
# Select: All components (or specific component)
# Follow prompts...

# On infrastructure server:
cd ./deploy/distributed/infrastructure
docker compose up -d

# On app servers:
cd ./deploy/distributed/app
docker compose up -d

# On jobs servers:
cd ./deploy/distributed/jobs
docker compose up -d
```

### Cloud Database

App containers with managed PostgreSQL (AWS RDS, GCP Cloud SQL, Azure).

**Generated files:**

- `.env` - Environment variables including cloud database connection
- `docker-compose.yml` - App container only (no database)

**Supported providers:**

- AWS RDS
- Google Cloud SQL
- Azure Database for PostgreSQL
- Any PostgreSQL-compatible database

**Example usage:**

```bash
npm run deploy:install
# Select: Cloud Database
# Select your provider
# Enter connection string
# Follow prompts...
cd ./deploy/cloud-database
docker compose up -d
```

### Kubernetes

Full Kubernetes manifests with autoscaling.

**Generated files:**

- `namespace.yaml` - Kubernetes namespace
- `configmap.yaml` - Non-sensitive configuration
- `secrets.yaml` - Sensitive data (DATABASE_URL, SESSION_SECRET)
- `app/deployment.yaml` - Application deployment with health probes
- `app/service.yaml` - ClusterIP service
- `app/hpa.yaml` - Horizontal Pod Autoscaler
- `ingress.yaml` - Ingress with optional TLS
- `kustomization.yaml` - Kustomize configuration
- `README.md` - Deployment instructions

**Example usage:**

```bash
npm run deploy:install
# Select: Kubernetes
# Follow prompts...
cd ./deploy/kubernetes

# Apply with kustomize
kubectl apply -k .

# Or apply individually
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secrets.yaml
kubectl apply -f app/
kubectl apply -f ingress.yaml
```

## Configuration Options

### Common Options (All Deployment Types)

| Option           | Description                           | Default                 |
| ---------------- | ------------------------------------- | ----------------------- |
| Base URL         | Public URL for the application        | `http://localhost:3000` |
| App Port         | Application listening port            | `3000`                  |
| Environment      | Node environment mode                 | `production`            |
| Output Directory | Where to write generated files        | `./deploy/{type}`       |
| Test Database    | Validate connection before generating | `false`                 |
| Run Deploy       | Execute `docker compose up` after     | `false`                 |

### Single Server Options

| Option              | Description                   | Default        |
| ------------------- | ----------------------------- | -------------- |
| PostgreSQL Database | Database name                 | `cascadia`     |
| PostgreSQL User     | Database username             | `postgres`     |
| PostgreSQL Password | Database password             | Auto-generated |
| PostgreSQL Port     | Database port                 | `5432`         |
| Include pgAdmin     | Add pgAdmin for DB management | `false`        |

### Distributed Options

| Option                 | Description                 | Default          |
| ---------------------- | --------------------------- | ---------------- |
| Infrastructure Host    | Hostname/IP of infra server | `localhost`      |
| PostgreSQL Password    | Database password           | Required         |
| RabbitMQ User/Password | Message queue credentials   | Required         |
| MinIO User/Password    | Object storage credentials  | Required         |
| S3 Bucket              | Storage bucket name         | `cascadia-vault` |
| Worker Concurrency     | Jobs per worker             | `5`              |
| Worker Replicas        | Number of worker containers | `2`              |
| Component              | Which configs to generate   | `all`            |

### Cloud Database Options

| Option         | Description                  | Default     |
| -------------- | ---------------------------- | ----------- |
| Cloud Provider | AWS RDS, GCP, Azure, Other   | Required    |
| Database URL   | PostgreSQL connection string | Required    |
| Vault Type     | File storage backend         | `local`     |
| S3 Bucket      | Bucket for S3 storage        | -           |
| S3 Region      | AWS region                   | `us-east-1` |
| S3 Credentials | Access key and secret        | -           |

### Kubernetes Options

| Option           | Description                 | Default        |
| ---------------- | --------------------------- | -------------- |
| Namespace        | Kubernetes namespace        | `cascadia`     |
| Ingress Host     | Public hostname             | Required       |
| Enable TLS       | Configure HTTPS             | `true`         |
| TLS Secret       | Name of TLS secret          | `cascadia-tls` |
| Image Repository | Container image             | `ghcr.io/cascadia-plm/cascadia-app` |
| Image Tag        | Container version           | `latest`       |
| Replicas         | Initial pod count           | `2`            |
| Database URL     | PostgreSQL connection       | Required       |
| Vault Mode       | Embedded or service         | `embedded`     |
| Vault Type       | Local PVC or S3             | `local`        |
| Jobs Mode        | Embedded, service, disabled | `embedded`     |

## Security

### Auto-Generated Secrets

The installer automatically generates secure secrets when not provided:

- **SESSION_SECRET** - 64-character hex string (256 bits)
- **Passwords** - 16-character alphanumeric strings

Generated credentials are displayed once at the end of the installation:

```
Auto-generated credentials:
  SESSION_SECRET: a3f8...d7e9
  POSTGRES_PASSWORD: xK9m...pQ2r
```

**Save these credentials securely - they cannot be recovered!**

### Sensitive Files

Generated `.env` and `secrets.yaml` files contain sensitive data:

- Do not commit to version control
- Add to `.gitignore`
- Use secrets management in production (Vault, AWS Secrets Manager, etc.)
- For Kubernetes, consider sealed-secrets or external-secrets operators

## Troubleshooting

### Database Connection Failed

If database validation fails:

1. **ECONNREFUSED** - Database not running or wrong host/port
2. **Password authentication failed** - Check username/password
3. **Database does not exist** - Create the database first
4. **ETIMEDOUT** - Check firewall rules and network connectivity
5. **SSL error** - Add `?sslmode=require` or `?sslmode=disable` to connection string

### Docker Not Found

If `docker compose up` fails:

1. Ensure Docker Desktop is running
2. Check Docker is in PATH: `docker --version`
3. Use `--generate-only` mode and run Docker manually

### Permission Denied

If file generation fails:

1. Check write permissions on output directory
2. Try a different output location
3. Run with elevated permissions if necessary

## File Structure

```
scripts/deploy/
├── install.ts              # Main CLI entry point
└── lib/
    ├── types.ts            # TypeScript interfaces
    ├── secrets.ts          # Secure random generation
    ├── prompts.ts          # Interactive prompts
    ├── validators/
    │   ├── config.ts       # Zod validation schemas
    │   └── database.ts     # Database connection testing
    └── generators/
        ├── env.ts          # .env file generation
        ├── docker-compose.ts # Docker Compose generation
        └── kubernetes.ts   # K8s manifest generation
```
