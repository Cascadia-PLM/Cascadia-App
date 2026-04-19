# Architecture Overview

Cascadia PLM uses a modular architecture where components can run together or separately depending on deployment requirements.

## Design Goals

1. **Single Codebase** - All services built from one repository
2. **Independent Deployment** - Each service has its own container image
3. **Flexible Topology** - Run everything on one server or distribute across many
4. **Cloud Agnostic** - Works with any PostgreSQL provider and any object storage
5. **Stateless Services** - All state lives in the database or object storage

## Service Boundaries

### Core App (`cascadia-app`)

The main application providing:

- Web UI (React/Vite SPA with TanStack Router)
- REST API endpoints
- Authentication and session management
- Item management (Parts, Documents, Change Orders, etc.)
- Workflow engine
- Reporting engine

**Can run standalone** with direct database connection and local file storage.

### Vault Service (`cascadia-vault`)

File storage and management:

- File upload/download
- Check-in/check-out workflow
- Version management
- Storage abstraction (local filesystem or S3-compatible)

**Separation benefit**: Scale file I/O independently, use dedicated storage servers, or integrate with enterprise content management.

### Jobs Server (`cascadia-jobs`)

Background task processing:

- File format conversions (CAD, Office documents)
- Long-running operations (BOM rollups, impact analysis)
- Scheduled tasks (cleanup, archival)
- Integration sync (ERP, external systems)

**Separation benefit**: Scale workers independently, run on dedicated hardware for conversions, isolate resource-intensive operations.

## Deployment Patterns

### Pattern 1: Monolithic (Development/Small Teams)

```
┌─────────────────────────────────────┐
│           Single Server             │
│  ┌───────────────────────────────┐  │
│  │      Cascadia App             │  │
│  │  (Core + Vault + Jobs)        │  │
│  └───────────────┬───────────────┘  │
│                  │                  │
│  ┌───────────────▼───────────────┐  │
│  │        PostgreSQL             │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

Best for:

- Development environments
- Small teams (< 20 users)
- Proof of concept deployments

### Pattern 2: Separated Database (Small/Medium)

```
┌─────────────────────────────────────┐
│          Application Server         │
│  ┌───────────────────────────────┐  │
│  │      Cascadia App             │  │
│  │  (Core + Vault + Jobs)        │  │
│  └───────────────┬───────────────┘  │
└──────────────────┼──────────────────┘
                   │ Network
┌──────────────────▼──────────────────┐
│          Database Server            │
│  ┌───────────────────────────────┐  │
│  │        PostgreSQL             │  │
│  │   (or AWS RDS, Cloud SQL)     │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

Best for:

- Production environments needing database HA
- Teams wanting managed database services
- Compliance requirements for data isolation

### Pattern 3: Distributed Services (Medium/Large)

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  App Server A   │    │  App Server B   │    │  Jobs Server    │
│  ┌───────────┐  │    │  ┌───────────┐  │    │  ┌───────────┐  │
│  │ Core App  │  │    │  │ Core App  │  │    │  │   Jobs    │  │
│  └─────┬─────┘  │    │  └─────┬─────┘  │    │  │  Workers  │  │
└────────┼────────┘    └────────┼────────┘    │  └─────┬─────┘  │
         │                      │             └────────┼────────┘
         └──────────┬───────────┘                      │
                    │                                  │
┌───────────────────▼──────────────────────────────────▼───────┐
│                        Shared Services                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │ PostgreSQL  │  │  RabbitMQ   │  │ S3/MinIO    │           │
│  │  (Primary)  │  │  (Message   │  │ (File       │           │
│  │             │  │   Broker)   │  │  Storage)   │           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
└──────────────────────────────────────────────────────────────┘
```

Best for:

- High availability requirements
- Large user base (100+ concurrent)
- Heavy file processing workloads
- Enterprise deployments

### Pattern 4: Kubernetes (Enterprise)

```
┌─────────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                      Ingress Controller                   │  │
│  └─────────────────────────────┬─────────────────────────────┘  │
│                                │                                │
│    ┌───────────────────────────┼───────────────────────────┐    │
│    │                           │                           │    │
│    ▼                           ▼                           ▼    │
│  ┌─────────┐              ┌─────────┐              ┌─────────┐  │
│  │ Core    │              │ Vault   │              │ Jobs    │  │
│  │ Deploy  │              │ Deploy  │              │ Deploy  │  │
│  │ (3 pods)│              │ (2 pods)│              │ (N pods)│  │
│  └────┬────┘              └────┬────┘              └────┬────┘  │
│       │                        │                        │       │
│       └────────────────────────┼────────────────────────┘       │
│                                │                                │
│  ┌─────────────────────────────▼─────────────────────────────┐  │
│  │                    Internal Services                       │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │  │
│  │  │ PostgreSQL  │  │  RabbitMQ   │  │   Redis     │        │  │
│  │  │ StatefulSet │  │ StatefulSet │  │  (Cache)    │        │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  External:  Cloud SQL / RDS / S3 / etc.                         │
└─────────────────────────────────────────────────────────────────┘
```

Best for:

- Auto-scaling requirements
- Multi-region deployments
- DevOps-mature organizations
- Cloud-native infrastructure

## Shared vs Isolated Components

### Always Shared

- **Database** - Single source of truth for all services
- **Message Broker** - Coordinates async work between services

### Optionally Separated

- **File Storage** - Can be local per-service or shared S3/NFS
- **Cache (Redis)** - Can be per-service or shared cluster

## Network Requirements

### Minimum Ports

| Service    | Port  | Protocol | Purpose              |
| ---------- | ----- | -------- | -------------------- |
| Core App   | 3000  | HTTP     | Web UI and API       |
| PostgreSQL | 5432  | TCP      | Database connections |
| RabbitMQ   | 5672  | AMQP     | Message broker       |
| RabbitMQ   | 15672 | HTTP     | Management UI        |

### Security Recommendations

1. **Public**: Only expose Core App through reverse proxy with TLS
2. **Private**: Keep database and message broker on internal network
3. **Encrypted**: Use TLS for all inter-service communication in production

## Scaling Considerations

### Horizontal Scaling

| Component     | Scale Strategy                                      |
| ------------- | --------------------------------------------------- |
| Core App      | Stateless - add more instances behind load balancer |
| Vault Service | Stateless with shared storage - scale freely        |
| Jobs Workers  | Scale based on queue depth                          |
| PostgreSQL    | Vertical first, then read replicas                  |
| RabbitMQ      | Cluster mode for HA                                 |

### Bottleneck Mitigation

1. **Database** - Connection pooling (PgBouncer), read replicas
2. **File I/O** - Object storage (S3), CDN for downloads
3. **CPU** - Dedicated job workers, queue priority
4. **Memory** - Caching layer (Redis)
