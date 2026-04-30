# Kubernetes Deployment

Production-grade deployment on Kubernetes with auto-scaling, health probes, and ingress-based TLS termination.

## When to Use

- Auto-scaling requirements (HPA based on CPU/memory)
- High availability targets (99.9%+ uptime)
- Multi-region deployments
- DevOps-mature organizations with existing Kubernetes infrastructure
- Cloud-native infrastructure (EKS, GKE, AKS)
- Enterprise deployments requiring network policies and pod security

## Architecture

```
+-------------------------------------------------------------------+
|                      Kubernetes Cluster                            |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  |                   Ingress Controller                          | |
|  |                 (nginx-ingress / traefik)                     | |
|  +------------------------------+-------------------------------+ |
|                                 |                                  |
|     +--------------------------++--------------------------+       |
|     |                          |                           |       |
|     v                          v                           v       |
|  +-----------+          +-----------+              +-----------+   |
|  | cascadia  |          | cascadia  |              | cascadia  |   |
|  |   app     |          |  vault    |              |   jobs    |   |
|  | Deployment|          | Deployment|              | Deployment|   |
|  | (2+ pods) |          | (2 pods)  |              | (N pods)  |   |
|  +-----+-----+          +-----+-----+              +-----+-----+   |
|        |                       |                          |        |
|  +-----+-----+          +-----+-----+                    |        |
|  |  Service   |          |  Service   |                    |        |
|  | ClusterIP  |          | ClusterIP  |                    |        |
|  +-----------+          +-----------+                    |        |
|                                                           |        |
|  +--------------------------------------------------------+        |
|  |                                                                 |
|  |  PostgreSQL (StatefulSet or External)                           |
|  |  RabbitMQ (StatefulSet, optional)                               |
|  |  Redis (StatefulSet, optional)                                  |
|  |                                                                 |
|  |  External: Cloud SQL / RDS / S3 / etc.                         |
|  +-----------------------------------------------------------------+
+--------------------------------------------------------------------+
```

## Prerequisites

- Kubernetes cluster version 1.25+
- `kubectl` configured with cluster access
- An ingress controller installed (nginx-ingress or traefik)
- cert-manager installed (for automatic TLS certificates)
- Helm 3 (optional, for installing PostgreSQL or RabbitMQ in-cluster)
- Container images pushed to an accessible registry

## Directory Structure

The Kubernetes manifests are located at `docs/orchestration/deployments/kubernetes/`:

```
kubernetes/
+-- namespace.yaml          # cascadia namespace
+-- configmap.yaml          # Non-sensitive configuration
+-- secrets.yaml.example    # Template for sensitive data
+-- app/
|   +-- deployment.yaml     # App Deployment with health probes
|   +-- service.yaml        # ClusterIP Service
|   +-- hpa.yaml            # Horizontal Pod Autoscaler
+-- ingress.yaml            # Ingress with TLS and security headers
+-- kustomization.yaml      # Kustomize configuration
```

## Deployment Steps

### 1. Create the Namespace

```bash
kubectl apply -f namespace.yaml
```

This creates the `cascadia` namespace with appropriate labels:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cascadia
  labels:
    name: cascadia
    app.kubernetes.io/name: cascadia-plm
```

### 2. Configure Secrets

```bash
cp secrets.yaml.example secrets.yaml
```

Edit `secrets.yaml` with your actual values:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cascadia-secrets
  namespace: cascadia
type: Opaque
stringData:
  database-url: 'postgresql://cascadia:PASSWORD@db-host:5432/cascadia?sslmode=require'
  session-secret: 'your-64-character-hex-string'
  s3-access-key: 'AKIA...'
  s3-secret-key: '...'
  rabbitmq-url: 'amqp://user:pass@rabbitmq-host:5672'
  vault-service-token: ''
```

**Do not commit `secrets.yaml` to version control.** For production, consider using sealed-secrets, external-secrets, or your cloud provider's secrets manager.

Apply the secrets:

```bash
kubectl apply -f secrets.yaml
```

### 3. Configure the ConfigMap

Edit `configmap.yaml` for your environment:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cascadia-config
  namespace: cascadia
data:
  NODE_ENV: 'production'
  BASE_URL: 'https://plm.example.com'
  LOG_LEVEL: 'info'
  VAULT_MODE: 'embedded'
  VAULT_TYPE: 'local' # Change to 's3' for cloud storage
  S3_BUCKET: 'cascadia-vault'
  S3_REGION: 'us-east-1'
  JOBS_MODE: 'embedded' # Change to 'service' for separate workers
  WORKER_CONCURRENCY: '5'
  JOB_TYPES: '*'
```

Apply:

```bash
kubectl apply -f configmap.yaml
```

### 4. Deploy the Application

```bash
kubectl apply -f app/
```

This creates:

- A **Deployment** with 2 replicas, health probes, resource limits, and volume mounts
- A **ClusterIP Service** exposing port 80 (mapped to container port 3000)
- A **HorizontalPodAutoscaler** scaling between 2 and 10 pods

### 5. Configure Ingress

Edit `ingress.yaml` to set your hostname:

```yaml
spec:
  tls:
    - hosts:
        - plm.example.com
      secretName: cascadia-tls
  rules:
    - host: plm.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: cascadia-app
                port:
                  number: 80
```

Apply:

```bash
kubectl apply -f ingress.yaml
```

### Using Kustomize

Apply everything at once (except secrets, which must be created from the template):

```bash
kubectl apply -f secrets.yaml
kubectl apply -k .
```

The `kustomization.yaml` applies common labels and allows image tag overrides:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: cascadia
resources:
  - namespace.yaml
  - configmap.yaml
  - app/deployment.yaml
  - app/service.yaml
  - app/hpa.yaml
  - ingress.yaml
commonLabels:
  app.kubernetes.io/name: cascadia-plm
  app.kubernetes.io/part-of: cascadia
images:
  - name: ghcr.io/cascadia-plm/cascadia-app
    newTag: latest
```

## Deployment Details

### App Deployment

The deployment runs with security best practices:

```yaml
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
      containers:
        - name: app
          image: ghcr.io/cascadia-plm/cascadia-app:latest
          resources:
            requests:
              cpu: '250m'
              memory: '512Mi'
            limits:
              cpu: '1000m'
              memory: '1Gi'
```

### Health Probes

```yaml
livenessProbe:
  httpGet:
    path: /api/health
    port: http
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /api/health
    port: http
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
```

- **Liveness probe**: restarts the pod if the app becomes unresponsive.
- **Readiness probe**: removes the pod from the service endpoints during startup or transient issues.

### Horizontal Pod Autoscaler

Scales based on CPU and memory utilization:

```yaml
spec:
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300 # Wait 5 min before scaling down
    scaleUp:
      stabilizationWindowSeconds: 0 # Scale up immediately
      policies:
        - type: Percent
          value: 100
          periodSeconds: 15
        - type: Pods
          value: 4
          periodSeconds: 15
```

### Ingress Security Headers

The ingress includes security-hardened annotations for nginx-ingress:

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- Content Security Policy
- `Referrer-Policy: strict-origin-when-cross-origin`
- Rate limiting: 10 requests/second, 300 requests/minute per client IP

## Database Options

### External Managed Database (Recommended for Production)

Use AWS RDS, Google Cloud SQL, or Azure Database for PostgreSQL. Set the connection string in `secrets.yaml`:

```yaml
stringData:
  database-url: 'postgresql://cascadia:pass@mydb.rds.amazonaws.com:5432/cascadia?sslmode=require'
```

### Google Cloud SQL Proxy Sidecar

For GKE deployments, add the Cloud SQL Auth Proxy as a sidecar container. A commented-out example is included in the deployment manifest:

```yaml
containers:
  - name: cloudsql-proxy
    image: gcr.io/cloudsql-docker/gce-proxy
    command: ['/cloud_sql_proxy', '-instances=project:region:instance=tcp:5432']
```

### In-Cluster PostgreSQL (Testing/Air-Gapped)

Install via Helm:

```bash
helm install postgresql bitnami/postgresql \
  --namespace cascadia \
  --set auth.postgresPassword=secretpassword \
  --set auth.database=cascadia
```

## Storage Options

### S3 Storage (Recommended)

Set in `configmap.yaml`:

```yaml
data:
  VAULT_TYPE: 's3'
  S3_BUCKET: 'cascadia-vault'
  S3_REGION: 'us-east-1'
```

And credentials in `secrets.yaml`:

```yaml
stringData:
  s3-access-key: 'AKIA...'
  s3-secret-key: '...'
```

### Persistent Volume Claims (Local Storage)

For local storage, replace the `emptyDir` volumes in the deployment with PVCs:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cascadia-vault-pvc
  namespace: cascadia
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
  storageClassName: standard
```

Note that `ReadWriteOnce` PVCs cannot be shared across pods. Use S3 storage for multi-replica deployments.

## Scaling

### Manual Scaling

```bash
kubectl scale deployment cascadia-app --replicas=5 -n cascadia
kubectl scale deployment cascadia-jobs --replicas=10 -n cascadia
```

### HPA Status

```bash
kubectl get hpa -n cascadia
kubectl describe hpa cascadia-app -n cascadia
```

## Network Policies

Restrict traffic to only expected flows:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cascadia-app
  namespace: cascadia
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

## Monitoring and Logging

### View Logs

```bash
kubectl logs -f deployment/cascadia-app -n cascadia
```

### Centralized Logging

Pods log to stdout in JSON format. Collect with:

- ELK Stack (Elasticsearch, Logstash, Kibana)
- Loki + Grafana
- Cloud provider logging (CloudWatch Logs, Google Cloud Logging)

### Pod Events

```bash
kubectl get events -n cascadia --sort-by='.lastTimestamp'
```

## Troubleshooting

### Check Pod Status

```bash
kubectl get pods -n cascadia
kubectl describe pod <pod-name> -n cascadia
```

### Port Forward for Testing

```bash
kubectl port-forward service/cascadia-app 3000:80 -n cascadia
# Access at http://localhost:3000
```

### Access Pod Shell

```bash
kubectl exec -it deployment/cascadia-app -n cascadia -- sh
```

### Schema Migration

Run manually if the app does not apply migrations on startup:

```bash
kubectl exec -it deployment/cascadia-app -n cascadia -- npx drizzle-kit push
```

### Common Issues

- **ImagePullBackOff**: Verify the image exists in your registry and pull secrets are configured.
- **CrashLoopBackOff**: Check logs for missing environment variables (`DATABASE_URL`, `SESSION_SECRET`).
- **Readiness probe failing**: The app may still be starting. Check `initialDelaySeconds` and `startupProbe` if needed.
- **HPA not scaling**: Ensure metrics-server is installed in the cluster.
