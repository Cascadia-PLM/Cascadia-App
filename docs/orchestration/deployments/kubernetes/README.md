# Kubernetes Deployment

Production-grade deployment on Kubernetes with auto-scaling and high availability.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Kubernetes Cluster                           │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Ingress Controller                        │  │
│  │                   (nginx-ingress / traefik)                   │  │
│  └─────────────────────────────┬─────────────────────────────────┘  │
│                                │                                    │
│    ┌───────────────────────────┼───────────────────────────────┐    │
│    │                           │                               │    │
│    ▼                           ▼                               ▼    │
│  ┌─────────────┐        ┌─────────────┐                ┌───────────┐│
│  │  cascadia   │        │  cascadia   │                │ cascadia  ││
│  │    app      │        │   vault     │                │   jobs    ││
│  │ Deployment  │        │ Deployment  │                │ Deployment││
│  │  (3 pods)   │        │  (2 pods)   │                │  (N pods) ││
│  └──────┬──────┘        └──────┬──────┘                └─────┬─────┘│
│         │                      │                              │     │
│  ┌──────┴──────┐        ┌──────┴──────┐                       │     │
│  │   Service   │        │   Service   │                       │     │
│  │  ClusterIP  │        │  ClusterIP  │                       │     │
│  └─────────────┘        └─────────────┘                       │     │
│                                                               │     │
│  ┌────────────────────────────────────────────────────────────┘     │
│  │                                                                  │
│  │  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐         │
│  │  │  PostgreSQL  │   │   RabbitMQ   │   │    Redis     │         │
│  │  │ StatefulSet  │   │ StatefulSet  │   │ StatefulSet  │         │
│  │  │   or Cloud   │   │  (optional)  │   │  (optional)  │         │
│  │  └──────────────┘   └──────────────┘   └──────────────┘         │
│  │                                                                  │
│  │  External: Cloud SQL / RDS / S3 / etc.                          │
│  └──────────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────┘
```

## When to Use

- Auto-scaling requirements
- High availability (99.9%+ uptime)
- Multi-region deployment
- DevOps-mature organization
- Cloud-native infrastructure
- Enterprise deployments

## Prerequisites

- Kubernetes cluster (1.25+)
- kubectl configured
- Helm 3 (optional, for chart installation)
- Ingress controller installed
- cert-manager (for TLS)

## Directory Structure

```
kubernetes/
├── README.md
├── namespace.yaml
├── secrets.yaml.example
├── configmap.yaml
├── app/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── hpa.yaml
├── vault/
│   ├── deployment.yaml
│   └── service.yaml
├── jobs/
│   ├── deployment.yaml
│   └── hpa.yaml
├── ingress.yaml
└── kustomization.yaml
```

## Quick Start

### 1. Create Namespace

```bash
kubectl apply -f namespace.yaml
```

### 2. Create Secrets

```bash
# Copy and edit secrets
cp secrets.yaml.example secrets.yaml
# Edit secrets.yaml with your values (base64 encoded)
kubectl apply -f secrets.yaml
```

### 3. Create ConfigMap

```bash
kubectl apply -f configmap.yaml
```

### 4. Deploy Services

```bash
kubectl apply -f app/
kubectl apply -f vault/   # Optional: if using separate vault
kubectl apply -f jobs/    # Optional: if using job workers
```

### 5. Configure Ingress

```bash
kubectl apply -f ingress.yaml
```

### Or use Kustomize

```bash
kubectl apply -k .
```

## Configuration

### Using External Database

For production, use a managed database (RDS, Cloud SQL):

```yaml
# secrets.yaml
stringData:
  database-url: 'postgresql://cascadia:pass@mydb.rds.amazonaws.com:5432/cascadia?sslmode=require'
```

### Using In-Cluster PostgreSQL

For testing or air-gapped environments:

```bash
# Install PostgreSQL via Helm
helm install postgresql bitnami/postgresql \
  --namespace cascadia \
  --set auth.postgresPassword=secretpassword \
  --set auth.database=cascadia
```

### External S3 Storage

```yaml
# configmap.yaml
data:
  VAULT_TYPE: 's3'
  S3_BUCKET: 'cascadia-vault'
  S3_REGION: 'us-east-1'

# secrets.yaml
stringData:
  s3-access-key: 'AKIA...'
  s3-secret-key: '...'
```

## Scaling

### Horizontal Pod Autoscaler

```yaml
# app/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cascadia-app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cascadia-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### Manual Scaling

```bash
kubectl scale deployment cascadia-app --replicas=5
kubectl scale deployment cascadia-jobs --replicas=10
```

## Monitoring

### Health Checks

All deployments include liveness and readiness probes:

- Liveness: Restart unhealthy pods
- Readiness: Remove from service during startup/issues

### Prometheus Metrics (Future)

```yaml
annotations:
  prometheus.io/scrape: 'true'
  prometheus.io/port: '3000'
  prometheus.io/path: '/metrics'
```

### Logging

Pods log to stdout (JSON format recommended):

```bash
kubectl logs -f deployment/cascadia-app
```

For centralized logging, use:

- ELK Stack (Elasticsearch, Logstash, Kibana)
- Loki + Grafana
- Cloud provider logging (CloudWatch, Stackdriver)

## Security

### Network Policies

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cascadia-app
spec:
  podSelector:
    matchLabels:
      app: cascadia-app
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: postgresql
```

### Pod Security

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1001
  fsGroup: 1001
  readOnlyRootFilesystem: true
```

## Troubleshooting

### Check Pod Status

```bash
kubectl get pods -n cascadia
kubectl describe pod <pod-name> -n cascadia
```

### Check Logs

```bash
kubectl logs -f deployment/cascadia-app -n cascadia
```

### Check Events

```bash
kubectl get events -n cascadia --sort-by='.lastTimestamp'
```

### Access Pod Shell

```bash
kubectl exec -it deployment/cascadia-app -n cascadia -- sh
```

### Port Forward for Testing

```bash
kubectl port-forward service/cascadia-app 3000:3000 -n cascadia
```
