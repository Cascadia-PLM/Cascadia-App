import { SettingKeys, SettingsService } from '../../config/SettingsService'
import { LocalFileStorage } from './local-storage'
import { S3Storage } from './s3-storage'
import type { StorageConfig, VaultStorage } from './types'

/**
 * Information about the effective vault configuration
 */
export interface VaultConfigInfo {
  type: 'local' | 's3'
  // Local storage fields
  rootPath?: string
  // S3 storage fields
  bucket?: string
  region?: string
  keyPrefix?: string
  endpoint?: string
  forcePathStyle?: boolean
  hasCredentials: boolean
  // Source tracking for each field
  sources: {
    type: 'env' | 'default'
    rootPath?: 'env' | 'db' | 'default'
    bucket?: 'env'
    region?: 'env' | 'default'
    keyPrefix?: 'env'
    endpoint?: 'env'
  }
  // Raw environment variable presence flags
  envVars: {
    VAULT_TYPE: boolean
    VAULT_ROOT: boolean
    S3_BUCKET: boolean
    S3_REGION: boolean
    S3_KEY_PREFIX: boolean
    S3_ENDPOINT: boolean
    S3_ACCESS_KEY_ID: boolean
    S3_SECRET_ACCESS_KEY: boolean
    S3_FORCE_PATH_STYLE: boolean
  }
  // Database overrides
  dbSettings: {
    vaultRoot?: string
  }
}

/**
 * Factory for creating storage instances based on configuration
 */
export class StorageFactory {
  private static cachedStorage: VaultStorage | null = null
  private static cachedRootPath: string | null = null

  /**
   * Create a storage instance from configuration
   */
  static create(config: StorageConfig): VaultStorage {
    switch (config.type) {
      case 'local':
        if (!config.rootPath) {
          throw new Error('Local storage requires rootPath in configuration')
        }
        return new LocalFileStorage(config.rootPath)

      case 's3':
        if (!config.bucket) {
          throw new Error('S3 storage requires bucket in configuration')
        }
        return new S3Storage({
          bucket: config.bucket,
          region: config.region,
          keyPrefix: config.keyPrefix,
          credentials: config.credentials
            ? {
                accessKeyId: config.credentials.accessKeyId!,
                secretAccessKey: config.credentials.secretAccessKey!,
              }
            : undefined,
        })

      default:
        throw new Error(`Unknown storage type: ${config.type}`)
    }
  }

  /**
   * Create storage from environment variables
   * Defaults to local storage with VAULT_ROOT or ./vault
   *
   * For S3:
   * - S3_BUCKET: bucket name (required)
   * - S3_REGION: AWS region (optional, defaults to us-east-1)
   * - S3_KEY_PREFIX: optional key prefix
   * - S3_ENDPOINT: optional endpoint for S3-compatible services
   * - S3_ACCESS_KEY_ID: optional explicit credentials
   * - S3_SECRET_ACCESS_KEY: optional explicit credentials
   */
  static createFromEnv(): VaultStorage {
    const storageType = (process.env.VAULT_TYPE ||
      'local') as StorageConfig['type']

    if (storageType === 's3') {
      const bucket = process.env.S3_BUCKET
      if (!bucket) {
        throw new Error(
          'S3_BUCKET environment variable is required when VAULT_TYPE=s3',
        )
      }

      // Build credentials only if explicitly provided
      const accessKeyId = process.env.S3_ACCESS_KEY_ID
      const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
      const credentials =
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined

      return new S3Storage({
        bucket,
        region: process.env.S3_REGION,
        keyPrefix: process.env.S3_KEY_PREFIX,
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials,
      })
    }

    const rootPath = process.env.VAULT_ROOT || './vault'
    const config: StorageConfig = {
      type: storageType,
      rootPath: rootPath,
    }

    return StorageFactory.create(config)
  }

  /**
   * Create storage from database settings, falling back to environment variables.
   * This is the preferred method for production use.
   */
  static async createFromSettings(): Promise<VaultStorage> {
    const storageType = (process.env.VAULT_TYPE ||
      'local') as StorageConfig['type']

    // For S3 storage, use createFromEnv (no database settings support yet)
    if (storageType === 's3') {
      // Generate cache key for S3
      const cacheKey = `s3:${process.env.S3_BUCKET}:${process.env.S3_KEY_PREFIX || ''}`
      if (this.cachedStorage && this.cachedRootPath === cacheKey) {
        return this.cachedStorage
      }

      this.cachedStorage = StorageFactory.createFromEnv()
      this.cachedRootPath = cacheKey
      return this.cachedStorage
    }

    // Try to get vault root from database settings
    const dbVaultRoot = await SettingsService.getValue(SettingKeys.VAULT_ROOT)

    // Use database setting if available, otherwise fall back to env
    const rootPath = dbVaultRoot || process.env.VAULT_ROOT || './vault'

    // Check if we can reuse cached storage
    if (this.cachedStorage && this.cachedRootPath === rootPath) {
      return this.cachedStorage
    }

    const config: StorageConfig = {
      type: storageType,
      rootPath: rootPath,
    }

    // Cache the storage instance
    this.cachedStorage = StorageFactory.create(config)
    this.cachedRootPath = rootPath

    return this.cachedStorage
  }

  /**
   * Clear the cached storage instance.
   * Call this when settings change to force recreation.
   */
  static clearCache(): void {
    this.cachedStorage = null
    this.cachedRootPath = null
  }

  /**
   * Get the current vault root path from settings or environment
   */
  static async getVaultRoot(): Promise<string> {
    const dbVaultRoot = await SettingsService.getValue(SettingKeys.VAULT_ROOT)
    return dbVaultRoot || process.env.VAULT_ROOT || './vault'
  }

  /**
   * Get configuration info without creating a storage instance.
   * Returns the effective configuration with source tracking.
   */
  static async getConfigInfo(): Promise<VaultConfigInfo> {
    // Check environment variables
    const envVars = {
      VAULT_TYPE: !!process.env.VAULT_TYPE,
      VAULT_ROOT: !!process.env.VAULT_ROOT,
      S3_BUCKET: !!process.env.S3_BUCKET,
      S3_REGION: !!process.env.S3_REGION,
      S3_KEY_PREFIX: !!process.env.S3_KEY_PREFIX,
      S3_ENDPOINT: !!process.env.S3_ENDPOINT,
      S3_ACCESS_KEY_ID: !!process.env.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: !!process.env.S3_SECRET_ACCESS_KEY,
      S3_FORCE_PATH_STYLE: !!process.env.S3_FORCE_PATH_STYLE,
    }

    // Get database settings
    const dbVaultRoot = await SettingsService.getValue(SettingKeys.VAULT_ROOT)
    const dbSettings = {
      vaultRoot: dbVaultRoot || undefined,
    }

    // Determine storage type
    const storageType = (process.env.VAULT_TYPE || 'local') as 'local' | 's3'

    if (storageType === 's3') {
      // S3 configuration
      const hasCredentials =
        !!process.env.S3_ACCESS_KEY_ID && !!process.env.S3_SECRET_ACCESS_KEY

      return {
        type: 's3',
        bucket: process.env.S3_BUCKET,
        region: process.env.S3_REGION || 'us-east-1',
        keyPrefix: process.env.S3_KEY_PREFIX,
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        hasCredentials,
        sources: {
          type: envVars.VAULT_TYPE ? 'env' : 'default',
          bucket: envVars.S3_BUCKET ? 'env' : undefined,
          region: envVars.S3_REGION ? 'env' : 'default',
          keyPrefix: envVars.S3_KEY_PREFIX ? 'env' : undefined,
          endpoint: envVars.S3_ENDPOINT ? 'env' : undefined,
        },
        envVars,
        dbSettings,
      }
    }

    // Local storage configuration
    // Priority: database > environment > default
    let rootPath: string
    let rootPathSource: 'env' | 'db' | 'default'

    if (dbVaultRoot) {
      rootPath = dbVaultRoot
      rootPathSource = 'db'
    } else if (process.env.VAULT_ROOT) {
      rootPath = process.env.VAULT_ROOT
      rootPathSource = 'env'
    } else {
      rootPath = './vault'
      rootPathSource = 'default'
    }

    return {
      type: 'local',
      rootPath,
      hasCredentials: false,
      sources: {
        type: envVars.VAULT_TYPE ? 'env' : 'default',
        rootPath: rootPathSource,
      },
      envVars,
      dbSettings,
    }
  }
}
