/**
 * Zod schemas for validating installer configuration
 */

import { z } from 'zod'

const baseConfigSchema = z.object({
  baseUrl: z.string().url('Must be a valid URL'),
  appPort: z.coerce.number().int().min(1).max(65535),
  nodeEnv: z.enum(['production', 'development']),
  sessionSecret: z.string().min(32).optional(),
  outputDir: z.string().min(1),
  validateDb: z.boolean(),
  runDeploy: z.boolean(),
})

export const singleServerConfigSchema = baseConfigSchema.extend({
  deploymentType: z.literal('single-server'),
  postgresDb: z.string().min(1).default('cascadia'),
  postgresUser: z.string().min(1).default('postgres'),
  postgresPassword: z.string().min(8).optional(),
  postgresPort: z.coerce.number().int().default(5432),
  includePgAdmin: z.boolean().default(false),
  pgAdminEmail: z.string().email().optional(),
  pgAdminPassword: z.string().min(4).optional(),
  pgAdminPort: z.coerce.number().int().default(5050),
})

export const distributedConfigSchema = baseConfigSchema.extend({
  deploymentType: z.literal('distributed'),
  infraHost: z.string().min(1, 'Infrastructure hostname is required'),
  postgresPassword: z.string().min(8, 'Password must be at least 8 characters'),
  postgresDb: z.string().min(1).default('cascadia'),
  postgresUser: z.string().min(1).default('postgres'),
  postgresPort: z.coerce.number().int().default(5432),
  rabbitmqUser: z.string().min(1).default('cascadia'),
  rabbitmqPassword: z.string().min(8, 'Password must be at least 8 characters'),
  rabbitmqVhost: z.string().min(1).default('cascadia'),
  minioUser: z.string().min(1).default('cascadia'),
  minioPassword: z.string().min(8, 'Password must be at least 8 characters'),
  s3Bucket: z.string().min(1).default('cascadia-vault'),
  workerConcurrency: z.coerce.number().int().min(1).default(5),
  workerReplicas: z.coerce.number().int().min(1).default(2),
  distributedComponent: z
    .enum(['all', 'infrastructure', 'app', 'jobs'])
    .default('all'),
  includePgAdmin: z.boolean().default(false),
  pgAdminEmail: z.string().email().optional(),
  pgAdminPassword: z.string().min(4).optional(),
})

export const cloudDatabaseConfigSchema = baseConfigSchema.extend({
  deploymentType: z.literal('cloud-database'),
  cloudProvider: z.enum(['aws-rds', 'gcp-cloudsql', 'azure', 'other']),
  databaseUrl: z
    .string()
    .regex(/^postgresql:\/\//, 'Must be a PostgreSQL connection string'),
  vaultType: z.enum(['local', 's3']).default('local'),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3AccessKey: z.string().optional(),
  s3SecretKey: z.string().optional(),
  s3Endpoint: z.string().url().optional(),
})

export const kubernetesConfigSchema = baseConfigSchema.extend({
  deploymentType: z.literal('kubernetes'),
  namespace: z
    .string()
    .regex(
      /^[a-z0-9-]+$/,
      'Namespace must be lowercase alphanumeric with dashes',
    )
    .default('cascadia'),
  ingressHost: z.string().min(1, 'Ingress hostname is required'),
  enableTls: z.boolean().default(true),
  tlsSecretName: z.string().optional(),
  imageRepository: z.string().default('cascadia/app'),
  imageTag: z.string().default('latest'),
  replicas: z.coerce.number().int().min(1).default(2),
  databaseUrl: z
    .string()
    .regex(/^postgresql:\/\//, 'Must be a PostgreSQL connection string'),
  vaultMode: z.enum(['embedded', 'service']).default('embedded'),
  vaultType: z.enum(['local', 's3']).default('local'),
  jobsMode: z.enum(['embedded', 'service', 'disabled']).default('embedded'),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3AccessKey: z.string().optional(),
  s3SecretKey: z.string().optional(),
  s3Endpoint: z.string().url().optional(),
})

export type SingleServerConfig = z.infer<typeof singleServerConfigSchema>
export type DistributedConfig = z.infer<typeof distributedConfigSchema>
export type CloudDatabaseConfig = z.infer<typeof cloudDatabaseConfigSchema>
export type KubernetesConfig = z.infer<typeof kubernetesConfigSchema>

/**
 * Validate configuration based on deployment type
 */
export function validateConfig(config: unknown): {
  success: boolean
  data?:
    | SingleServerConfig
    | DistributedConfig
    | CloudDatabaseConfig
    | KubernetesConfig
  errors?: Array<string>
} {
  const baseResult = z.object({ deploymentType: z.string() }).safeParse(config)

  if (!baseResult.success) {
    return { success: false, errors: ['Missing deployment type'] }
  }

  const deploymentType = baseResult.data.deploymentType

  let schema
  switch (deploymentType) {
    case 'single-server':
      schema = singleServerConfigSchema
      break
    case 'distributed':
      schema = distributedConfigSchema
      break
    case 'cloud-database':
      schema = cloudDatabaseConfigSchema
      break
    case 'kubernetes':
      schema = kubernetesConfigSchema
      break
    default:
      return {
        success: false,
        errors: [`Unknown deployment type: ${deploymentType}`],
      }
  }

  const result = schema.safeParse(config)

  if (result.success) {
    return { success: true, data: result.data }
  }

  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  )
  return { success: false, errors }
}
