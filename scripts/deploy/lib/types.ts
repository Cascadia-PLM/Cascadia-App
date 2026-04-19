/**
 * Type definitions for the Cascadia PLM deployment installer
 */

export type DeploymentType =
  | 'single-server'
  | 'distributed'
  | 'cloud-database'
  | 'kubernetes'

export type CloudProvider = 'aws-rds' | 'gcp-cloudsql' | 'azure' | 'other'

export type VaultType = 'local' | 's3'

export type VaultMode = 'embedded' | 'service'

export type JobsMode = 'embedded' | 'service' | 'disabled'

export type DistributedComponent = 'all' | 'infrastructure' | 'app' | 'jobs'

export interface BaseConfig {
  deploymentType: DeploymentType
  baseUrl: string
  appPort: number
  nodeEnv: 'production' | 'development'
  sessionSecret?: string
  outputDir: string
  validateDb: boolean
  runDeploy: boolean
}

export interface SingleServerConfig extends BaseConfig {
  deploymentType: 'single-server'
  postgresDb: string
  postgresUser: string
  postgresPassword?: string
  postgresPort: number
  includePgAdmin: boolean
  pgAdminEmail?: string
  pgAdminPassword?: string
  pgAdminPort: number
}

export interface DistributedConfig extends BaseConfig {
  deploymentType: 'distributed'
  infraHost: string
  postgresPassword: string
  postgresDb: string
  postgresUser: string
  postgresPort: number
  rabbitmqUser: string
  rabbitmqPassword: string
  rabbitmqVhost: string
  minioUser: string
  minioPassword: string
  s3Bucket: string
  workerConcurrency: number
  workerReplicas: number
  distributedComponent: DistributedComponent
  includePgAdmin: boolean
  pgAdminEmail?: string
  pgAdminPassword?: string
}

export interface CloudDatabaseConfig extends BaseConfig {
  deploymentType: 'cloud-database'
  cloudProvider: CloudProvider
  databaseUrl: string
  vaultType: VaultType
  s3Bucket?: string
  s3Region?: string
  s3AccessKey?: string
  s3SecretKey?: string
  s3Endpoint?: string
}

export interface KubernetesConfig extends BaseConfig {
  deploymentType: 'kubernetes'
  namespace: string
  ingressHost: string
  enableTls: boolean
  tlsSecretName?: string
  imageRepository: string
  imageTag: string
  replicas: number
  databaseUrl: string
  vaultMode: VaultMode
  vaultType: VaultType
  jobsMode: JobsMode
  s3Bucket?: string
  s3Region?: string
  s3AccessKey?: string
  s3SecretKey?: string
  s3Endpoint?: string
}

export type InstallerConfig =
  | SingleServerConfig
  | DistributedConfig
  | CloudDatabaseConfig
  | KubernetesConfig

export interface PreFlightCheck {
  name: string
  passed: boolean
  message: string
}

export interface PreFlightResult {
  pass: boolean
  checks: Array<PreFlightCheck>
}

export interface GeneratedFile {
  path: string
  content: string
  isSecret?: boolean
}

export interface GenerationResult {
  files: Array<GeneratedFile>
  credentials: Record<string, string>
}
