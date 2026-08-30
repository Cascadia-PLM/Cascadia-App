// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Kubernetes manifest generators
 */

import YAML from 'yaml'
import type { GeneratedFile, KubernetesConfig } from '../types.js'

/**
 * Generate all Kubernetes manifests
 */
export function generateKubernetesManifests(
  config: KubernetesConfig,
): Array<GeneratedFile> {
  const files: Array<GeneratedFile> = []

  // 1. Namespace
  files.push(generateNamespace(config))

  // 2. ConfigMap
  files.push(generateConfigMap(config))

  // 3. Secrets
  files.push(generateSecrets(config))

  // 4. Migration Job — emitted after the ConfigMap and Secret it reads, and
  //    before the Deployment it has to precede at apply time.
  files.push(generateMigrateJob(config))

  // 5. Deployment
  files.push(generateDeployment(config))

  // 6. Service
  files.push(generateService(config))

  // 7. HPA (Horizontal Pod Autoscaler)
  files.push(generateHPA(config))

  // 8. Ingress
  files.push(generateIngress(config))

  // 9. Kustomization
  files.push(generateKustomization(config))

  // 10. README
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

function generateSecrets(config: KubernetesConfig): GeneratedFile {
  const secretData: Record<string, string> = {
    'database-url': config.databaseUrl,
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

/**
 * One-shot Job that brings the database to the committed schema.
 *
 * Mirrors the committed manifest at
 * `docs/orchestration/deployments/kubernetes/migrate-job.yaml`; the two are
 * meant to stay in step, so a change to one belongs in the other.
 *
 * Nothing else in this generated bundle migrates. The Deployment overrides no
 * command, so its pods run the image's bare server entry point — the
 * migrate-on-boot wrapper is something the compose generator applies, and it
 * would race across replicas here anyway.
 *
 * Kept out of `generateKustomization()`'s resources deliberately: a Job's pod
 * template is immutable, so `kubectl apply -k .` on an upgrade would fail on
 * this object rather than re-run it. The README's Quick Start carries the
 * delete-apply-wait sequence instead.
 */
function generateMigrateJob(config: KubernetesConfig): GeneratedFile {
  const manifest = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: 'cascadia-migrate',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'cascadia',
        'app.kubernetes.io/component': 'migrate',
      },
    },
    spec: {
      // Two retries, then stop: boot-migrate.ts exits non-zero on a pre-v0.5
      // database and prints the one command that fixes it. Retrying forever
      // would bury that message.
      backoffLimit: 2,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'cascadia',
            'app.kubernetes.io/component': 'migrate',
          },
        },
        spec: {
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1001,
            fsGroup: 1001,
          },
          containers: [
            {
              name: 'migrate',
              image: `${config.imageRepository}:${config.imageTag}`,
              // Replaces the image CMD, not its ENTRYPOINT.
              command: ['npx', 'tsx', 'scripts/boot-migrate.ts'],
              env: [
                // NODE_ENV is load-bearing here, not cosmetic: with no
                // `?sslmode=` in the URL it decides whether the connection
                // requires TLS, so a Job without it can fail to reach a
                // managed database that the app pods connect to happily.
                {
                  name: 'NODE_ENV',
                  valueFrom: {
                    configMapKeyRef: {
                      name: 'cascadia-config',
                      key: 'NODE_ENV',
                    },
                  },
                },
                {
                  name: 'DATABASE_URL',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'cascadia-secrets',
                      key: 'database-url',
                    },
                  },
                },
              ],
              resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
            },
          ],
        },
      },
    },
  }

  // The warning rides in the file rather than only in the README, because the
  // file is what an operator opens when `kubectl apply -k .` did not migrate.
  const header = [
    '# Database migration Job — run this before the app Deployment, on the',
    '# first install and again on every upgrade. Nothing else here migrates.',
    '#',
    '# Deliberately NOT a kustomization.yaml resource: a Job pod template is',
    '# immutable, so an upgrade has to delete the previous run before applying',
    '# this one. That also means the kustomization `images:` tag override does',
    '# not reach this file — pin the same tag in both places.',
    '#',
    `#   kubectl delete job cascadia-migrate -n ${config.namespace} --ignore-not-found`,
    '#   kubectl apply -f migrate-job.yaml',
    `#   kubectl wait --for=condition=complete job/cascadia-migrate -n ${config.namespace} --timeout=300s`,
    '',
  ].join('\n')

  return {
    path: 'migrate-job.yaml',
    content: `${header}${YAML.stringify(manifest)}`,
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
    // migrate-job.yaml is absent on purpose — see generateMigrateJob(). It is
    // applied by hand, before this, on install and on every upgrade.
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
2. Create the namespace, config and secrets:

\`\`\`bash
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secrets.yaml
\`\`\`

3. Run the database migration Job and wait for it to complete:

\`\`\`bash
kubectl delete job cascadia-migrate -n ${config.namespace} --ignore-not-found
kubectl apply -f migrate-job.yaml
kubectl wait --for=condition=complete job/cascadia-migrate -n ${config.namespace} --timeout=300s
kubectl logs job/cascadia-migrate -n ${config.namespace}
\`\`\`

Nothing else applies migrations — the app pods run the bare server. Run this on
the first install **and on every upgrade**, before the new image serves traffic,
and delete the previous run first because a Job's pod template is immutable.
The Job is not a kustomize resource, so \`kustomization.yaml\`'s image tag
override does not reach it: pin the same tag in both places.

4. Apply the rest of the manifests:

\`\`\`bash
# Using kustomize
kubectl apply -k .

# Or apply individually
kubectl apply -f app/
kubectl apply -f ingress.yaml
\`\`\`

The app's health endpoint reports process liveness only — it does not touch the
database — so pods started against an unmigrated database pass their readiness
probe, join the Service, and serve 500s. Step 3 is what prevents that; the
probes will not.

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
| \`migrate-job.yaml\` | One-shot database migration Job — run before the app, on install and every upgrade (not a kustomize resource) |
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
