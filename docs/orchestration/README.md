# Cascadia PLM Orchestration Guide

This documentation describes Cascadia's modular, containerized architecture designed for flexible deployment across different environments.

## Documentation Index

| Document                                          | Description                                                |
| ------------------------------------------------- | ---------------------------------------------------------- |
| [**Deployment Installer**](./installer.md)        | Interactive CLI tool for generating deployment configs     |
| [Architecture Overview](./architecture.md)        | System design, service boundaries, and deployment patterns |
| [Services](./services.md)                         | Individual service descriptions and responsibilities       |
| [Database Deployment](./database.md)              | Database configuration for different hosting scenarios     |
| [Inter-Service Communication](./communication.md) | How services communicate and discover each other           |
| [Configuration](./configuration.md)               | Environment variables and runtime configuration            |
| [Deployment Examples](./deployments/)             | Ready-to-use deployment configurations                     |

## Core Principles

### 1. Modular by Design

Each component of Cascadia can run independently:

- **Core App** - Main web application (UI + API)
- **Vault Service** - File storage and management
- **Jobs Server** - Background task processing
- **Database** - PostgreSQL (self-hosted or managed)

### 2. Flexible Deployment

Deploy all components together or distribute across infrastructure:

- Single server (monolithic)
- Multiple servers (distributed)
- Cloud-managed services (RDS, Cloud SQL, S3)
- Kubernetes orchestration

### 3. Configuration-Driven

All deployment topology is controlled via environment variables—no code changes required to change deployment architecture.

## Quick Start

### Using the Installer (Recommended)

The easiest way to get started is with the interactive deployment installer:

```bash
cd CascadiaApp
npm run deploy:install
```

The installer guides you through configuration and generates all necessary files. See [Deployment Installer](./installer.md) for details.

### Manual Setup

For manual configuration, use Docker Compose directly:

```bash
cd CascadiaApp
docker-compose up -d
```

This runs PostgreSQL + Core App on one machine.

### Distributed Deployment

See [Deployment Examples](./deployments/) for configurations including:

- [Single Server](./deployments/single-server/)
- [Distributed Services](./deployments/distributed/)
- [Cloud-Managed Database](./deployments/cloud-database/)
- [Kubernetes](./deployments/kubernetes/)

## Service Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Load Balancer / Reverse Proxy               │
└──────────────────────────────┬──────────────────────────────────┘
                               │
       ┌───────────────────────┼───────────────────────┐
       │                       │                       │
       ▼                       ▼                       ▼
┌─────────────┐        ┌─────────────┐        ┌─────────────┐
│  Core App   │        │   Vault     │        │    Jobs     │
│   Server    │◄──────►│  Service    │        │   Server    │
│             │        │             │        │             │
│ - Web UI    │        │ - File I/O  │        │ - Workers   │
│ - REST API  │        │ - Versions  │        │ - Queue     │
│ - Auth      │        │ - Check-in  │        │ - Convert   │
└──────┬──────┘        └──────┬──────┘        └──────┬──────┘
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │    PostgreSQL     │
                    │                   │
                    │ - Self-hosted     │
                    │ - AWS RDS         │
                    │ - Google Cloud SQL│
                    │ - Azure Database  │
                    └───────────────────┘
```

## Build Profiles

Use Docker Compose profiles to control which services are built and deployed:

```bash
# Core app only (connects to external database)
docker-compose --profile core up -d

# Core + database
docker-compose --profile core --profile database up -d

# Full stack including jobs server
docker-compose --profile full up -d

# Development with hot reload
docker-compose --profile dev up -d
```

## Environment-Based Configuration

Each service reads configuration from environment variables. This enables:

1. **Local Development** - `.env` file with defaults
2. **Docker Compose** - `.env.docker` with container networking
3. **Kubernetes** - ConfigMaps and Secrets
4. **Cloud Services** - Environment variables or secrets managers

See [Configuration Guide](./configuration.md) for complete variable reference.
