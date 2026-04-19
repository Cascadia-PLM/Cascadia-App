/**
 * Vault storage interface - abstracts the underlying storage mechanism
 * Implementations: LocalFileStorage, S3Storage (Phase 2), etc.
 */
export interface VaultStorage {
  /**
   * Store a file in the vault
   * @param path Relative path from vault root
   * @param data File data as Buffer or ReadableStream
   * @returns Promise that resolves when file is stored
   */
  store: (path: string, data: Buffer | ReadableStream) => Promise<void>

  /**
   * Retrieve a file from the vault
   * @param path Relative path from vault root
   * @returns Promise that resolves to file data as Buffer
   */
  retrieve: (path: string) => Promise<Buffer>

  /**
   * Stream a file from the vault (for large files)
   * @param path Relative path from vault root
   * @returns Promise that resolves to ReadableStream
   */
  createReadStream: (path: string) => Promise<ReadableStream>

  /**
   * Delete a file from the vault
   * @param path Relative path from vault root
   * @returns Promise that resolves when file is deleted
   */
  delete: (path: string) => Promise<void>

  /**
   * Check if a file exists in the vault
   * @param path Relative path from vault root
   * @returns Promise that resolves to true if file exists
   */
  exists: (path: string) => Promise<boolean>

  /**
   * Get file size in bytes
   * @param path Relative path from vault root
   * @returns Promise that resolves to file size in bytes
   */
  getSize: (path: string) => Promise<number>
}

/**
 * File metadata for uploads
 */
export interface FileUploadMetadata {
  originalFileName: string
  mimeType: string
  size: number
  description?: string
  [key: string]: any // Allow additional metadata
}

/**
 * Storage configuration
 */
export interface StorageConfig {
  type: 'local' | 's3' // Storage type (Azure planned for Phase 2)
  rootPath?: string // For local storage
  bucket?: string // For S3
  region?: string // For S3/Azure
  keyPrefix?: string // For S3 - optional prefix for all keys
  credentials?: {
    accessKeyId?: string
    secretAccessKey?: string
  }
}

/**
 * S3-specific storage configuration
 */
export interface S3StorageConfig {
  bucket: string
  region?: string
  keyPrefix?: string
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
  }
  endpoint?: string // For S3-compatible services like MinIO
  forcePathStyle?: boolean // For S3-compatible services
}
