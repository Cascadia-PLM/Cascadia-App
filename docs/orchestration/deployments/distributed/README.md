# Distributed Services Deployment

Multiple services running on separate servers with shared infrastructure.

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  App Server A   │    │  App Server B   │    │  Jobs Server    │
│  ┌───────────┐  │    │  ┌───────────┐  │    │  ┌───────────┐  │
│  │ Core App  │  │    │  │ Core App  │  │    │  │   Jobs    │  │
│  │   :3000   │  │    │  │   :3000   │  │    │  │  Workers  │  │
│  └─────┬─────┘  │    │  └─────┬─────┘  │    │  └─────┬─────┘  │
└────────┼────────┘    └────────┼────────┘    └────────┼────────┘
         │                      │                      │
         └──────────┬───────────┴──────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────────────┐
│                    Shared Services                          │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ PostgreSQL  │  │  RabbitMQ   │  │  MinIO/S3   │         │
│  │   :5432     │  │   :5672     │  │   :9000     │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
│  Infrastructure Server                                      │
└─────────────────────────────────────────────────────────────┘
```

## When to Use

- High availability requirements
- Need to scale app and jobs independently
- 50+ concurrent users
- Heavy file processing workloads
- Geographic distribution

## Components

### Infrastructure Server

Hosts shared stateful services:

- PostgreSQL database
- RabbitMQ message broker
- MinIO object storage (optional)

### App Servers (1-N)

Run the Core App behind a load balancer:

- Stateless - can scale horizontally
- Connect to shared database
- Submit jobs to RabbitMQ

### Jobs Servers (1-N)

Process background tasks:

- Scale based on queue depth
- Can specialize by job type
- Access files via S3/MinIO

## Deployment

### Step 1: Infrastructure Server

```bash
# On infrastructure server
cd deployments/distributed/infrastructure
cp .env.example .env
# Edit .env with passwords

docker-compose up -d
```

### Step 2: App Servers

```bash
# On each app server
cd deployments/distributed/app
cp .env.example .env
# Edit .env with:
#   - DATABASE_URL pointing to infrastructure server
#   - RABBITMQ_URL pointing to infrastructure server
#   - S3 credentials for MinIO

docker-compose up -d
```

### Step 3: Jobs Servers

```bash
# On jobs server(s)
cd deployments/distributed/jobs
cp .env.example .env
# Edit .env similarly

docker-compose up -d
```

### Step 4: Load Balancer

Configure your load balancer (Nginx, HAProxy, cloud LB) to distribute traffic across app servers.

Example Nginx config:

```nginx
upstream cascadia_app {
    server app-server-1:3000;
    server app-server-2:3000;
}

server {
    listen 443 ssl;
    server_name plm.example.com;

    location / {
        proxy_pass http://cascadia_app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Files

```
distributed/
├── infrastructure/
│   ├── docker-compose.yml   # PostgreSQL, RabbitMQ, MinIO
│   └── .env.example
├── app/
│   ├── docker-compose.yml   # Core App only
│   └── .env.example
├── jobs/
│   ├── docker-compose.yml   # Jobs workers only
│   └── .env.example
└── README.md
```

## Scaling

### Add App Servers

```bash
# On new server, deploy app compose
docker-compose up -d
# Add to load balancer
```

### Add Jobs Workers

```bash
# On new/existing server
# Option 1: Add more containers
docker-compose up -d --scale worker=3

# Option 2: Specialized workers
JOB_TYPES=conversion.cad docker-compose up -d
```

### Database Scaling

For read-heavy workloads, add PostgreSQL read replicas:

1. Set up streaming replication
2. Configure app for read/write splitting (future feature)
