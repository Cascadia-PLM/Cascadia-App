/**
 * Interactive prompt definitions for the deployment installer
 */

import { confirm, input, password, select } from '@inquirer/prompts'
import type {
  CloudProvider,
  DeploymentType,
  DistributedComponent,
} from './types.js'

/**
 * Prompt for deployment type selection
 */
export async function promptDeploymentType(): Promise<DeploymentType> {
  return await select({
    message: 'Select deployment type:',
    choices: [
      {
        value: 'single-server' as const,
        name: 'Single Server - All services on one machine (dev/small teams)',
      },
      {
        value: 'distributed' as const,
        name: 'Distributed - Separate servers for high availability',
      },
      {
        value: 'cloud-database' as const,
        name: 'Cloud Database - App containers with managed PostgreSQL',
      },
      {
        value: 'kubernetes' as const,
        name: 'Kubernetes - Full K8s manifests with autoscaling',
      },
    ],
  })
}

/**
 * Prompt for common configuration (all deployment types)
 */
export async function promptCommonConfig(): Promise<{
  baseUrl: string
  appPort: number
  nodeEnv: 'production' | 'development'
}> {
  const baseUrl = await input({
    message: 'Public URL for the application:',
    default: 'http://localhost:3000',
    validate: (value) => {
      try {
        new URL(value)
        return true
      } catch {
        return 'Please enter a valid URL'
      }
    },
  })

  const appPort = await input({
    message: 'Application port:',
    default: '3000',
    validate: (value) => {
      const port = parseInt(value, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        return 'Please enter a valid port number (1-65535)'
      }
      return true
    },
  })

  const nodeEnv = await select({
    message: 'Environment mode:',
    choices: [
      { value: 'production' as const, name: 'Production' },
      { value: 'development' as const, name: 'Development' },
    ],
    default: 'production',
  })

  return {
    baseUrl,
    appPort: parseInt(appPort, 10),
    nodeEnv,
  }
}

/**
 * Prompt for single-server specific configuration
 */
export async function promptSingleServerConfig() {
  const postgresDb = await input({
    message: 'PostgreSQL database name:',
    default: 'cascadia',
  })

  const postgresUser = await input({
    message: 'PostgreSQL username:',
    default: 'postgres',
  })

  const postgresPassword = await password({
    message: 'PostgreSQL password (Enter to auto-generate):',
    mask: '*',
  })

  const postgresPort = await input({
    message: 'PostgreSQL port:',
    default: '5432',
  })

  const includePgAdmin = await confirm({
    message: 'Include pgAdmin for database management?',
    default: false,
  })

  let pgAdminEmail: string | undefined
  let pgAdminPassword: string | undefined
  let pgAdminPort = 5050

  if (includePgAdmin) {
    pgAdminEmail = await input({
      message: 'pgAdmin email:',
      default: 'admin@cascadia.local',
    })

    pgAdminPassword = await password({
      message: 'pgAdmin password (Enter to auto-generate):',
      mask: '*',
    })

    pgAdminPort = parseInt(
      await input({
        message: 'pgAdmin port:',
        default: '5050',
      }),
      10,
    )
  }

  return {
    postgresDb,
    postgresUser,
    postgresPassword: postgresPassword || undefined,
    postgresPort: parseInt(postgresPort, 10),
    includePgAdmin,
    pgAdminEmail,
    pgAdminPassword: pgAdminPassword || undefined,
    pgAdminPort,
  }
}

/**
 * Prompt for distributed deployment configuration
 */
export async function promptDistributedConfig() {
  const distributedComponent = await select<DistributedComponent>({
    message: 'Which component configuration to generate?',
    choices: [
      { value: 'all', name: 'All components (infrastructure, app, jobs)' },
      {
        value: 'infrastructure',
        name: 'Infrastructure only (postgres, rabbitmq, minio)',
      },
      { value: 'app', name: 'App server only' },
      { value: 'jobs', name: 'Jobs server only' },
    ],
  })

  const infraHost = await input({
    message: 'Infrastructure server hostname/IP:',
    default: 'localhost',
    validate: (value) => value.length > 0 || 'Required',
  })

  // PostgreSQL
  const postgresDb = await input({
    message: 'PostgreSQL database name:',
    default: 'cascadia',
  })

  const postgresUser = await input({
    message: 'PostgreSQL username:',
    default: 'postgres',
  })

  const postgresPassword = await password({
    message: 'PostgreSQL password (min 8 chars):',
    mask: '*',
    validate: (value) =>
      value.length >= 8 || 'Password must be at least 8 characters',
  })

  const postgresPort = await input({
    message: 'PostgreSQL port:',
    default: '5432',
  })

  // RabbitMQ
  const rabbitmqUser = await input({
    message: 'RabbitMQ username:',
    default: 'cascadia',
  })

  const rabbitmqPassword = await password({
    message: 'RabbitMQ password (min 8 chars):',
    mask: '*',
    validate: (value) =>
      value.length >= 8 || 'Password must be at least 8 characters',
  })

  const rabbitmqVhost = await input({
    message: 'RabbitMQ virtual host:',
    default: 'cascadia',
  })

  // MinIO
  const minioUser = await input({
    message: 'MinIO username:',
    default: 'cascadia',
  })

  const minioPassword = await password({
    message: 'MinIO password (min 8 chars):',
    mask: '*',
    validate: (value) =>
      value.length >= 8 || 'Password must be at least 8 characters',
  })

  const s3Bucket = await input({
    message: 'S3/MinIO bucket name:',
    default: 'cascadia-vault',
  })

  // Workers
  const workerConcurrency = await input({
    message: 'Worker concurrency (jobs per worker):',
    default: '5',
  })

  const workerReplicas = await input({
    message: 'Number of worker replicas:',
    default: '2',
  })

  // pgAdmin
  const includePgAdmin = await confirm({
    message: 'Include pgAdmin for database management?',
    default: false,
  })

  let pgAdminEmail: string | undefined
  let pgAdminPassword: string | undefined

  if (includePgAdmin) {
    pgAdminEmail = await input({
      message: 'pgAdmin email:',
      default: 'admin@cascadia.local',
    })

    pgAdminPassword = await password({
      message: 'pgAdmin password:',
      mask: '*',
    })
  }

  return {
    distributedComponent,
    infraHost,
    postgresDb,
    postgresUser,
    postgresPassword,
    postgresPort: parseInt(postgresPort, 10),
    rabbitmqUser,
    rabbitmqPassword,
    rabbitmqVhost,
    minioUser,
    minioPassword,
    s3Bucket,
    workerConcurrency: parseInt(workerConcurrency, 10),
    workerReplicas: parseInt(workerReplicas, 10),
    includePgAdmin,
    pgAdminEmail,
    pgAdminPassword: pgAdminPassword || undefined,
  }
}

/**
 * Prompt for cloud database configuration
 */
export async function promptCloudDatabaseConfig() {
  const cloudProvider = await select<CloudProvider>({
    message: 'Cloud database provider:',
    choices: [
      { value: 'aws-rds', name: 'AWS RDS' },
      { value: 'gcp-cloudsql', name: 'Google Cloud SQL' },
      { value: 'azure', name: 'Azure Database for PostgreSQL' },
      { value: 'other', name: 'Other (custom connection string)' },
    ],
  })

  // Provider-specific hints
  const providerHints: Record<CloudProvider, string> = {
    'aws-rds':
      'Format: postgresql://user:password@hostname.region.rds.amazonaws.com:5432/database',
    'gcp-cloudsql':
      'Format: postgresql://user:password@/database?host=/cloudsql/project:region:instance',
    azure:
      'Format: postgresql://user@servername:password@servername.postgres.database.azure.com:5432/database?sslmode=require',
    other: 'Format: postgresql://user:password@hostname:5432/database',
  }

  console.log(`  ${providerHints[cloudProvider]}`)

  const databaseUrl = await input({
    message: 'Database connection string:',
    validate: (value) => {
      if (!value.startsWith('postgresql://')) {
        return 'Must be a PostgreSQL connection string starting with postgresql://'
      }
      return true
    },
  })

  const vaultType = await select({
    message: 'File storage backend:',
    choices: [
      { value: 'local' as const, name: 'Local storage (Docker volume)' },
      { value: 's3' as const, name: 'AWS S3 / S3-compatible storage' },
    ],
  })

  let s3Bucket: string | undefined
  let s3Region: string | undefined
  let s3AccessKey: string | undefined
  let s3SecretKey: string | undefined
  let s3Endpoint: string | undefined

  if (vaultType === 's3') {
    s3Bucket = await input({
      message: 'S3 bucket name:',
      default: 'cascadia-vault',
    })

    s3Region = await input({
      message: 'S3 region:',
      default: 'us-east-1',
    })

    const useCustomEndpoint = await confirm({
      message: 'Use custom S3 endpoint (MinIO, etc)?',
      default: false,
    })

    if (useCustomEndpoint) {
      s3Endpoint = await input({
        message: 'S3 endpoint URL:',
        validate: (value) => {
          try {
            new URL(value)
            return true
          } catch {
            return 'Must be a valid URL'
          }
        },
      })
    }

    s3AccessKey = await input({
      message: 'S3 access key:',
    })

    s3SecretKey = await password({
      message: 'S3 secret key:',
      mask: '*',
    })
  }

  return {
    cloudProvider,
    databaseUrl,
    vaultType,
    s3Bucket,
    s3Region,
    s3AccessKey,
    s3SecretKey,
    s3Endpoint,
  }
}

/**
 * Prompt for Kubernetes configuration
 */
export async function promptKubernetesConfig() {
  const namespace = await input({
    message: 'Kubernetes namespace:',
    default: 'cascadia',
    validate: (value) => {
      if (!/^[a-z0-9-]+$/.test(value)) {
        return 'Namespace must be lowercase alphanumeric with dashes only'
      }
      return true
    },
  })

  const ingressHost = await input({
    message: 'Ingress hostname (e.g., plm.example.com):',
    validate: (value) => value.length > 0 || 'Required',
  })

  const enableTls = await confirm({
    message: 'Enable TLS (requires cert-manager or manual cert)?',
    default: true,
  })

  let tlsSecretName: string | undefined
  if (enableTls) {
    tlsSecretName = await input({
      message: 'TLS secret name:',
      default: 'cascadia-tls',
    })
  }

  const imageRepository = await input({
    message: 'Container image repository:',
    default: 'cascadia/app',
  })

  const imageTag = await input({
    message: 'Container image tag:',
    default: 'latest',
  })

  const replicas = await input({
    message: 'Number of app replicas:',
    default: '2',
  })

  const databaseUrl = await input({
    message: 'PostgreSQL connection string:',
    validate: (value) => {
      if (!value.startsWith('postgresql://')) {
        return 'Must be a PostgreSQL connection string'
      }
      return true
    },
  })

  const vaultMode = await select({
    message: 'Vault mode:',
    choices: [
      { value: 'embedded' as const, name: 'Embedded - Vault runs in app pod' },
      {
        value: 'service' as const,
        name: 'Service - Separate vault deployment',
      },
    ],
  })

  const vaultType = await select({
    message: 'Vault storage type:',
    choices: [
      { value: 'local' as const, name: 'Local - PersistentVolumeClaim' },
      { value: 's3' as const, name: 'S3 - Object storage' },
    ],
  })

  const jobsMode = await select({
    message: 'Jobs processing mode:',
    choices: [
      { value: 'embedded' as const, name: 'Embedded - Jobs run in app pod' },
      { value: 'service' as const, name: 'Service - Separate job workers' },
      { value: 'disabled' as const, name: 'Disabled - No job processing' },
    ],
  })

  let s3Bucket: string | undefined
  let s3Region: string | undefined
  let s3AccessKey: string | undefined
  let s3SecretKey: string | undefined
  let s3Endpoint: string | undefined

  if (vaultType === 's3') {
    s3Bucket = await input({
      message: 'S3 bucket name:',
      default: 'cascadia-vault',
    })

    s3Region = await input({
      message: 'S3 region:',
      default: 'us-east-1',
    })

    const useCustomEndpoint = await confirm({
      message: 'Use custom S3 endpoint?',
      default: false,
    })

    if (useCustomEndpoint) {
      s3Endpoint = await input({
        message: 'S3 endpoint URL:',
      })
    }

    s3AccessKey = await input({
      message: 'S3 access key:',
    })

    s3SecretKey = await password({
      message: 'S3 secret key:',
      mask: '*',
    })
  }

  return {
    namespace,
    ingressHost,
    enableTls,
    tlsSecretName,
    imageRepository,
    imageTag,
    replicas: parseInt(replicas, 10),
    databaseUrl,
    vaultMode,
    vaultType,
    jobsMode,
    s3Bucket,
    s3Region,
    s3AccessKey,
    s3SecretKey,
    s3Endpoint,
  }
}

/**
 * Prompt for output options (all deployment types)
 */
export async function promptOutputOptions(
  deploymentType: DeploymentType,
): Promise<{
  outputDir: string
  validateDb: boolean
  runDeploy: boolean
}> {
  const outputDir = await input({
    message: 'Output directory:',
    default: `./deploy/${deploymentType}`,
  })

  const validateDb = await confirm({
    message: 'Test database connection before generating?',
    default: false,
  })

  let runDeploy = false
  if (deploymentType !== 'kubernetes') {
    runDeploy = await confirm({
      message: 'Run docker compose up after generating?',
      default: false,
    })
  }

  return {
    outputDir,
    validateDb,
    runDeploy,
  }
}
