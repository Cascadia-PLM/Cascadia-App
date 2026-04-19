/**
 * Environment file generators for each deployment type
 */

import { generatePassword, generateSecureSecret } from '../secrets.js'
import type {
  CloudDatabaseConfig,
  DistributedConfig,
  GenerationResult,
  KubernetesConfig,
  SingleServerConfig,
} from '../types.js'

/**
 * Generate .env file for single-server deployment
 */
export function generateSingleServerEnv(
  config: SingleServerConfig,
): GenerationResult {
  const sessionSecret = config.sessionSecret || generateSecureSecret(32)
  const postgresPassword = config.postgresPassword || generatePassword(16)
  const pgAdminPassword = config.pgAdminPassword || generatePassword(12)

  const credentials: Record<string, string> = {
    SESSION_SECRET: sessionSecret,
    POSTGRES_PASSWORD: postgresPassword,
  }

  if (config.includePgAdmin) {
    credentials.PGADMIN_PASSWORD = pgAdminPassword
  }

  let content = `# Cascadia PLM - Single Server Deployment
# Generated: ${new Date().toISOString()}
# WARNING: This file contains secrets. Do not commit to version control!

# =============================================================================
# APPLICATION
# =============================================================================

NODE_ENV=${config.nodeEnv}
APP_PORT=${config.appPort}
BASE_URL=${config.baseUrl}

# =============================================================================
# SECRETS (auto-generated if not provided)
# =============================================================================

SESSION_SECRET=${sessionSecret}

# =============================================================================
# DATABASE
# =============================================================================

POSTGRES_DB=${config.postgresDb}
POSTGRES_USER=${config.postgresUser}
POSTGRES_PASSWORD=${postgresPassword}
POSTGRES_PORT=${config.postgresPort}

# Connection URL for the application (uses docker service name)
DATABASE_URL=postgresql://${config.postgresUser}:${postgresPassword}@postgres:${config.postgresPort}/${config.postgresDb}

# =============================================================================
# VAULT & JOBS (embedded mode for single server)
# =============================================================================

VAULT_MODE=embedded
VAULT_TYPE=local
VAULT_ROOT=/app/vault

JOBS_MODE=embedded
`

  if (config.includePgAdmin) {
    content += `
# =============================================================================
# pgAdmin
# =============================================================================

PGADMIN_EMAIL=${config.pgAdminEmail || 'admin@cascadia.local'}
PGADMIN_PASSWORD=${pgAdminPassword}
PGADMIN_PORT=${config.pgAdminPort}
`
  }

  return {
    files: [{ path: '.env', content, isSecret: true }],
    credentials,
  }
}

/**
 * Generate .env files for distributed deployment
 */
export function generateDistributedEnv(
  config: DistributedConfig,
): GenerationResult {
  const sessionSecret = config.sessionSecret || generateSecureSecret(32)
  const pgAdminPassword = config.pgAdminPassword || generatePassword(12)

  const credentials: Record<string, string> = {
    SESSION_SECRET: sessionSecret,
    POSTGRES_PASSWORD: config.postgresPassword,
    RABBITMQ_PASSWORD: config.rabbitmqPassword,
    MINIO_PASSWORD: config.minioPassword,
  }

  if (config.includePgAdmin) {
    credentials.PGADMIN_PASSWORD = pgAdminPassword
  }

  const files = []

  // Infrastructure .env
  if (
    config.distributedComponent === 'all' ||
    config.distributedComponent === 'infrastructure'
  ) {
    const infraContent = `# Cascadia PLM - Distributed Deployment (Infrastructure)
# Generated: ${new Date().toISOString()}
# Deploy this on your infrastructure server

# =============================================================================
# POSTGRESQL
# =============================================================================

POSTGRES_DB=${config.postgresDb}
POSTGRES_USER=${config.postgresUser}
POSTGRES_PASSWORD=${config.postgresPassword}
POSTGRES_PORT=${config.postgresPort}

# =============================================================================
# RABBITMQ
# =============================================================================

RABBITMQ_USER=${config.rabbitmqUser}
RABBITMQ_PASSWORD=${config.rabbitmqPassword}
RABBITMQ_VHOST=${config.rabbitmqVhost}

# =============================================================================
# MINIO (S3-compatible storage)
# =============================================================================

MINIO_ROOT_USER=${config.minioUser}
MINIO_ROOT_PASSWORD=${config.minioPassword}
${
  config.includePgAdmin
    ? `
# =============================================================================
# pgAdmin
# =============================================================================

PGADMIN_EMAIL=${config.pgAdminEmail || 'admin@cascadia.local'}
PGADMIN_PASSWORD=${pgAdminPassword}
`
    : ''
}
`
    files.push({
      path: 'infrastructure/.env',
      content: infraContent,
      isSecret: true,
    })
  }

  // App .env
  if (
    config.distributedComponent === 'all' ||
    config.distributedComponent === 'app'
  ) {
    const appContent = `# Cascadia PLM - Distributed Deployment (App Server)
# Generated: ${new Date().toISOString()}
# Deploy this on your app servers

# =============================================================================
# APPLICATION
# =============================================================================

NODE_ENV=${config.nodeEnv}
APP_PORT=${config.appPort}
BASE_URL=${config.baseUrl}
APP_VERSION=latest

# =============================================================================
# SECRETS
# =============================================================================

SESSION_SECRET=${sessionSecret}

# =============================================================================
# DATABASE (connect to infrastructure server)
# =============================================================================

DATABASE_URL=postgresql://${config.postgresUser}:${config.postgresPassword}@${config.infraHost}:${config.postgresPort}/${config.postgresDb}

# =============================================================================
# RABBITMQ (connect to infrastructure server)
# =============================================================================

RABBITMQ_URL=amqp://${config.rabbitmqUser}:${config.rabbitmqPassword}@${config.infraHost}:5672/${config.rabbitmqVhost}

# =============================================================================
# S3/MINIO (connect to infrastructure server)
# =============================================================================

VAULT_MODE=embedded
VAULT_TYPE=s3
S3_ENDPOINT=http://${config.infraHost}:9000
S3_ACCESS_KEY=${config.minioUser}
S3_SECRET_KEY=${config.minioPassword}
S3_BUCKET=${config.s3Bucket}

# =============================================================================
# JOBS (use service mode - jobs processed by workers)
# =============================================================================

JOBS_MODE=service
`
    files.push({ path: 'app/.env', content: appContent, isSecret: true })
  }

  // Jobs .env
  if (
    config.distributedComponent === 'all' ||
    config.distributedComponent === 'jobs'
  ) {
    const jobsContent = `# Cascadia PLM - Distributed Deployment (Jobs Server)
# Generated: ${new Date().toISOString()}
# Deploy this on your jobs worker servers

# =============================================================================
# WORKER CONFIGURATION
# =============================================================================

NODE_ENV=${config.nodeEnv}
WORKER_CONCURRENCY=${config.workerConcurrency}
WORKER_REPLICAS=${config.workerReplicas}
JOB_TYPES=*
JOB_TIMEOUT=300000
JOBS_VERSION=latest

# =============================================================================
# DATABASE (connect to infrastructure server)
# =============================================================================

DATABASE_URL=postgresql://${config.postgresUser}:${config.postgresPassword}@${config.infraHost}:${config.postgresPort}/${config.postgresDb}

# =============================================================================
# RABBITMQ (connect to infrastructure server)
# =============================================================================

RABBITMQ_URL=amqp://${config.rabbitmqUser}:${config.rabbitmqPassword}@${config.infraHost}:5672/${config.rabbitmqVhost}

# =============================================================================
# S3/MINIO (connect to infrastructure server)
# =============================================================================

S3_ENDPOINT=http://${config.infraHost}:9000
S3_ACCESS_KEY=${config.minioUser}
S3_SECRET_KEY=${config.minioPassword}
S3_BUCKET=${config.s3Bucket}
`
    files.push({ path: 'jobs/.env', content: jobsContent, isSecret: true })
  }

  return { files, credentials }
}

/**
 * Generate .env file for cloud database deployment
 */
export function generateCloudDatabaseEnv(
  config: CloudDatabaseConfig,
): GenerationResult {
  const sessionSecret = config.sessionSecret || generateSecureSecret(32)

  const credentials: Record<string, string> = {
    SESSION_SECRET: sessionSecret,
  }

  let content = `# Cascadia PLM - Cloud Database Deployment
# Generated: ${new Date().toISOString()}
# Provider: ${config.cloudProvider}
# WARNING: This file contains secrets. Do not commit to version control!

# =============================================================================
# APPLICATION
# =============================================================================

NODE_ENV=${config.nodeEnv}
APP_PORT=${config.appPort}
BASE_URL=${config.baseUrl}
APP_VERSION=latest

# =============================================================================
# SECRETS
# =============================================================================

SESSION_SECRET=${sessionSecret}

# =============================================================================
# DATABASE (managed cloud database)
# =============================================================================

DATABASE_URL=${config.databaseUrl}

# =============================================================================
# VAULT & JOBS (embedded mode)
# =============================================================================

VAULT_MODE=embedded
JOBS_MODE=embedded
`

  if (config.vaultType === 'local') {
    content += `
# Local file storage
VAULT_TYPE=local
VAULT_ROOT=/app/vault
`
  } else {
    content += `
# S3 file storage
VAULT_TYPE=s3
S3_BUCKET=${config.s3Bucket}
S3_REGION=${config.s3Region}
${config.s3Endpoint ? `S3_ENDPOINT=${config.s3Endpoint}` : ''}
S3_ACCESS_KEY=${config.s3AccessKey}
S3_SECRET_KEY=${config.s3SecretKey}
`
    if (config.s3AccessKey) credentials.S3_ACCESS_KEY = config.s3AccessKey
    if (config.s3SecretKey) credentials.S3_SECRET_KEY = config.s3SecretKey
  }

  return {
    files: [{ path: '.env', content, isSecret: true }],
    credentials,
  }
}

/**
 * Generate environment variables for Kubernetes (used in secrets.yaml)
 */
export function generateKubernetesEnv(
  config: KubernetesConfig,
): GenerationResult {
  const sessionSecret = config.sessionSecret || generateSecureSecret(32)

  const credentials: Record<string, string> = {
    SESSION_SECRET: sessionSecret,
  }

  if (config.s3AccessKey) credentials.S3_ACCESS_KEY = config.s3AccessKey
  if (config.s3SecretKey) credentials.S3_SECRET_KEY = config.s3SecretKey

  // For K8s, we don't generate a .env file - secrets go in secrets.yaml
  // But we return the credentials for display
  return {
    files: [],
    credentials,
  }
}
