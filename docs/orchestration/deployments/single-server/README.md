# Single Server Deployment

The simplest deployment - all components on one machine.

## Architecture

```
┌─────────────────────────────────────┐
│           Single Server             │
│                                     │
│  ┌───────────────────────────────┐  │
│  │        Cascadia App           │  │
│  │   (Core + Vault + Jobs)       │  │
│  │         :3000                 │  │
│  └───────────────┬───────────────┘  │
│                  │                  │
│  ┌───────────────▼───────────────┐  │
│  │        PostgreSQL             │  │
│  │           :5432               │  │
│  └───────────────────────────────┘  │
│                                     │
│  Volumes:                           │
│  - postgres_data                    │
│  - app_storage                      │
│  - app_vault                        │
└─────────────────────────────────────┘
```

## When to Use

- Development and testing
- Small teams (< 20 users)
- Proof of concept
- Low file processing workloads

## Quick Start

```bash
# 1. Copy environment file
cp .env.example .env

# 2. Edit .env and set required values
#    - SESSION_SECRET (generate random 32+ chars)
#    - POSTGRES_PASSWORD (strong password)

# 3. Start services
docker-compose up -d

# 4. Access application
open http://localhost:3000
```

## Files

- `docker-compose.yml` - Service definitions
- `.env.example` - Environment template

## Customization

### Change Ports

Edit `.env`:

```bash
APP_PORT=8080
POSTGRES_PORT=5433
```

### Enable pgAdmin

```bash
docker-compose --profile tools up -d
# Access at http://localhost:5050
```

### Persistent Storage Locations

By default, Docker manages volumes. To use specific paths:

```yaml
volumes:
  postgres_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /data/postgres
```
