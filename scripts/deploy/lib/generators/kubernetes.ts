/**
 * Kubernetes manifest generators
 */

import YAML from 'yaml'
import { generateSecureSecret } from '../secrets.js'
import type { GeneratedFile, KubernetesConfig } from '../types.js'

/**
 * Generate all Kubernetes manifests
 */
export function generateKubernetesManifests(
  config: KubernetesConfig,
): Array<GeneratedFile> {
  const files: Array<GeneratedFile> = []
  const sessionSecret = config.sessionSecret || generateSecureSecret(32)

  // 1. Namespace
  files.push(generateNamespace(config))

  // 2. ConfigMap
  files.push(generateConfigMap(config))

  // 3. Secrets
  files.push(generateSecrets(config, sessionSecret))

  // 4. Deployment
  files.push(generateDeployment(config))

  // 5. Service
  files.push(generateService(config))

  // 6. HPA (Horizontal Pod Autoscaler)
  files.push(generateHPA(config))

  // 7. Ingress
  files.push(generateIngress(config))

  // 8. Kustomization
  files.push(generateKustomization(config))

  // 9. README
  files.push(generateReadme(config))

  return files
}

function generateNamespace(config: KubernetesConfig): GeneratedFile {
  const manifest = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'namespace',
      },
    },
  }

  return {
    path: 'namespace.yaml',
    content: YAML.stringify(manifest),
  }
}

function generateConfigMap(config: KubernetesConfig): GeneratedFile {
  const manifest = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'cascadia-config',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'config',
      },
    },
    data: {
      NODE_ENV: config.nodeEnv,
      BASE_URL: config.baseUrl,
      APP_PORT: String(config.appPort),
      VAULT_MODE: config.vaultMode,
      VAULT_TYPE: config.vaultType,
      JOBS_MODE: config.jobsMode,
      ...(config.vaultType === 's3' && config.s3Bucket
        ? {
            S3_BUCKET: config.s3Bucket,
            S3_REGION: config.s3Region || 'us-east-1',
            ...(config.s3Endpoint ? { S3_ENDPOINT: config.s3Endpoint } : {}),
          }
        : {}),
    },
  }

  return {
    path: 'configmap.yaml',
    content: YAML.stringify(manifest),
  }
}

function generateSecrets(
  config: KubernetesConfig,
  sessionSecret: string,
): GeneratedFile {
  const secretData: Record<string, string> = {
    'database-url': config.databaseUrl,
    'session-secret': sessionSecret,
  }

  if (config.vaultType === 's3' && config.s3AccessKey && config.s3SecretKey) {
    secretData['s3-access-key'] = config.s3AccessKey
    secretData['s3-secret-key'] = config.s3SecretKey
  }

  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'cascadia-secrets',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'secrets',
      },
    },
    type: 'Opaque',
    stringData: secretData,
  }

  return {
    path: 'secrets.yaml',
    content: `# WARNING: This file contains secrets. Do not commit to version control!\n# Consider using sealed-secrets or external-secrets in production.\n${YAML.stringify(manifest)}`,
    isSecret: true,
  }
}

function generateDeployment(config: KubernetesConfig): GeneratedFile {
  const envVars = [
    {
      name: 'NODE_ENV',
      valueFrom: {
        configMapKeyRef: { name: 'cascadia-config', key: 'NODE_ENV' },
      },
    },
    {
      name: 'BASE_URL',
      valueFrom: {
        configMapKeyRef: { name: 'cascadia-config', key: 'BASE_URL' },
      },
    },
    {
      name: 'VAULT_MODE',
      valueFrom: {
        configMapKeyRef: { name: 'cascadia-config', key: 'VAULT_MODE' },
      },
    },
    {
      name: 'VAULT_TYPE',
      valueFrom: {
        configMapKeyRef: { name: 'cascadia-config', key: 'VAULT_TYPE' },
      },
    },
    {
      name: 'JOBS_MODE',
      valueFrom: {
        configMapKeyRef: { name: 'cascadia-config', key: 'JOBS_MODE' },
      },
    },
    {
      name: 'DATABASE_URL',
      valueFrom: {
        secretKeyRef: { name: 'cascadia-secrets', key: 'database-url' },
      },
    },
    {
      name: 'SESSION_SECRET',
      valueFrom: {
        secretKeyRef: { name: 'cascadia-secrets', key: 'session-secret' },
      },
    },
  ]

  if (config.vaultType === 's3') {
    envVars.push(
      {
        name: 'S3_BUCKET',
        valueFrom: {
          configMapKeyRef: { name: 'cascadia-config', key: 'S3_BUCKET' },
        },
      },
      {
        name: 'S3_REGION',
        valueFrom: {
          configMapKeyRef: { name: 'cascadia-config', key: 'S3_REGION' },
        },
      },
      {
        name: 'S3_ACCESS_KEY',
        valueFrom: {
          secretKeyRef: { name: 'cascadia-secrets', key: 's3-access-key' },
        },
      },
      {
        name: 'S3_SECRET_KEY',
        valueFrom: {
          secretKeyRef: { name: 'cascadia-secrets', key: 's3-secret-key' },
        },
      },
    )
    if (config.s3Endpoint) {
      envVars.push({
        name: 'S3_ENDPOINT',
        valueFrom: {
          configMapKeyRef: { name: 'cascadia-config', key: 'S3_ENDPOINT' },
        },
      })
    }
  }

  const manifest = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'cascadia-app',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'app',
      },
    },
    spec: {
      replicas: config.replicas,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'cascadia',
          'app.kubernetes.io/component': 'app',
        },
      },
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'cascadia',
            'app.kubernetes.io/component': 'app',
          },
        },
        spec: {
          containers: [
            {
              name: 'app',
              image: `${config.imageRepository}:${config.imageTag}`,
              ports: [{ containerPort: 3000, name: 'http' }],
              env: envVars,
              resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '1000m', memory: '1Gi' },
              },
              livenessProbe: {
                httpGet: { path: '/api/v1/health', port: 'http' },
                initialDelaySeconds: 30,
                periodSeconds: 10,
              },
              readinessProbe: {
                httpGet: { path: '/api/v1/health', port: 'http' },
                initialDelaySeconds: 5,
                periodSeconds: 5,
              },
            },
          ],
        },
      },
    },
  }

  return {
    path: 'app/deployment.yaml',
    content: YAML.stringify(manifest),
  }
}

function generateService(config: KubernetesConfig): GeneratedFile {
  const manifest = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'cascadia-app',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'app',
      },
    },
    spec: {
      type: 'ClusterIP',
      ports: [
        {
          port: 80,
          targetPort: 'http',
          protocol: 'TCP',
          name: 'http',
        },
      ],
      selector: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'app',
      },
    },
  }

  return {
    path: 'app/service.yaml',
    content: YAML.stringify(manifest),
  }
}

function generateHPA(config: KubernetesConfig): GeneratedFile {
  const manifest = {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: {
      name: 'cascadia-app',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'app',
      },
    },
    spec: {
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'cascadia-app',
      },
      minReplicas: config.replicas,
      maxReplicas: Math.max(config.replicas * 3, 10),
      metrics: [
        {
          type: 'Resource',
          resource: {
            name: 'cpu',
            target: {
              type: 'Utilization',
              averageUtilization: 70,
            },
          },
        },
        {
          type: 'Resource',
          resource: {
            name: 'memory',
            target: {
              type: 'Utilization',
              averageUtilization: 80,
            },
          },
        },
      ],
    },
  }

  return {
    path: 'app/hpa.yaml',
    content: YAML.stringify(manifest),
  }
}

function generateIngress(config: KubernetesConfig): GeneratedFile {
  const manifest: Record<string, unknown> = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'cascadia-ingress',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'ingress',
      },
      annotations: {
        'nginx.ingress.kubernetes.io/proxy-body-size': '100m',
        ...(config.enableTls
          ? { 'cert-manager.io/cluster-issuer': 'letsencrypt-prod' }
          : {}),
      },
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: config.ingressHost,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: 'cascadia-app',
                    port: { name: 'http' },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  }

  if (config.enableTls) {
    ;(manifest.spec as Record<string, unknown>).tls = [
      {
        hosts: [config.ingressHost],
        secretName: config.tlsSecretName || 'cascadia-tls',
      },
    ]
  }

  return {
    path: 'ingress.yaml',
    content: YAML.stringify(manifest),
  }
}

function generateKustomization(config: KubernetesConfig): GeneratedFile {
  const manifest = {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    namespace: config.namespace,
    resources: [
      'namespace.yaml',
      'configmap.yaml',
      'secrets.yaml',
      'app/deployment.yaml',
      'app/service.yaml',
      'app/hpa.yaml',
      'ingress.yaml',
    ],
    images: [
      {
        name: config.imageRepository,
        newTag: config.imageTag,
      },
    ],
    commonLabels: {
      'app.kubernetes.io/managed-by': 'kustomize',
    },
  }

  return {
    path: 'kustomization.yaml',
    content: YAML.stringify(manifest),
  }
}

function generateReadme(config: KubernetesConfig): GeneratedFile {
  const content = `# Cascadia PLM - Kubernetes Deployment

Generated: ${new Date().toISOString()}

## Quick Start

1. Review and update \`secrets.yaml\` with your actual secrets
2. Apply the manifests:

\`\`\`bash
# Using kustomize
kubectl apply -k .

# Or apply individually
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secrets.yaml
kubectl apply -f app/
kubectl apply -f ingress.yaml
\`\`\`

## Configuration

- **Namespace**: ${config.namespace}
- **Ingress Host**: ${config.ingressHost}
- **TLS**: ${config.enableTls ? 'Enabled' : 'Disabled'}
- **Replicas**: ${config.replicas} (autoscales to ${Math.max(config.replicas * 3, 10)})

## Files

| File | Description |
|------|-------------|
| \`namespace.yaml\` | Kubernetes namespace |
| \`configmap.yaml\` | Non-sensitive configuration |
| \`secrets.yaml\` | Sensitive data (DO NOT COMMIT) |
| \`app/deployment.yaml\` | Application deployment |
| \`app/service.yaml\` | Internal service |
| \`app/hpa.yaml\` | Horizontal Pod Autoscaler |
| \`ingress.yaml\` | External ingress |
| \`kustomization.yaml\` | Kustomize configuration |

## Security Notes

- \`secrets.yaml\` contains sensitive data - use sealed-secrets or external-secrets in production
- Consider using a secrets management solution (Vault, AWS Secrets Manager, etc.)
- Review resource limits before production deployment

## Monitoring

Check deployment status:
\`\`\`bash
kubectl get pods -n ${config.namespace}
kubectl logs -n ${config.namespace} -l app.kubernetes.io/name=cascadia
\`\`\`
`

  return {
    path: 'README.md',
    content,
  }
}
