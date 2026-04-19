import { Readable } from 'node:stream'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { S3ClientConfig } from '@aws-sdk/client-s3'

import type { S3StorageConfig, VaultStorage } from './types'

/**
 * Extended config that allows injecting a custom S3 client (for testing)
 */
export interface S3StorageConfigWithClient extends S3StorageConfig {
  client?: S3Client
}

/**
 * S3 storage implementation
 * Stores files in an S3 bucket (or S3-compatible service like MinIO)
 */
export class S3Storage implements VaultStorage {
  private client: S3Client
  private bucket: string
  private keyPrefix: string

  constructor(config: S3StorageConfigWithClient) {
    this.bucket = config.bucket
    this.keyPrefix = config.keyPrefix || ''

    // Use injected client if provided (for testing), otherwise create new one
    if (config.client) {
      this.client = config.client
      return
    }

    const clientConfig: S3ClientConfig = {
      region: config.region || process.env.AWS_REGION || 'us-east-1',
    }

    // Use explicit credentials if provided, otherwise rely on IAM role
    if (config.credentials) {
      clientConfig.credentials = {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
      }
    }

    // Support S3-compatible services (MinIO, LocalStack, etc.)
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint
      clientConfig.forcePathStyle = config.forcePathStyle ?? true
    }

    this.client = new S3Client(clientConfig)
  }

  /**
   * Get the full S3 key from a relative path
   * Normalizes path and applies optional prefix
   */
  private getS3Key(relativePath: string): string {
    // Normalize path separators to forward slashes
    const normalized = relativePath.replace(/\\/g, '/')

    // Prevent directory traversal
    if (normalized.includes('..') || normalized.startsWith('/')) {
      throw new Error('Invalid path: directory traversal detected')
    }

    // Apply prefix if configured
    if (this.keyPrefix) {
      return `${this.keyPrefix}/${normalized}`
    }

    return normalized
  }

  async store(
    relativePath: string,
    data: Buffer | ReadableStream,
  ): Promise<void> {
    const key = this.getS3Key(relativePath)

    let body: Buffer | Readable
    if (data instanceof Buffer) {
      body = data
    } else {
      // Convert Web ReadableStream to Node.js Readable
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      body = Readable.fromWeb(data as import('stream/web').ReadableStream)
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
      }),
    )
  }

  async retrieve(relativePath: string): Promise<Buffer> {
    const key = this.getS3Key(relativePath)

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )

      if (!response.Body) {
        throw new Error(`File not found: ${relativePath}`)
      }

      // Convert stream to buffer
      const chunks: Array<Uint8Array> = []
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        throw new Error(`File not found: ${relativePath}`)
      }
      throw error
    }
  }

  async createReadStream(relativePath: string): Promise<ReadableStream> {
    const key = this.getS3Key(relativePath)

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )

      if (!response.Body) {
        throw new Error(`File not found: ${relativePath}`)
      }

      // Convert AWS SDK stream to Web ReadableStream
      const nodeStream = response.Body as Readable
      return new ReadableStream({
        start(controller) {
          nodeStream.on('data', (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          nodeStream.on('end', () => {
            controller.close()
          })
          nodeStream.on('error', (err) => {
            controller.error(err)
          })
        },
        cancel() {
          nodeStream.destroy()
        },
      })
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        throw new Error(`File not found: ${relativePath}`)
      }
      throw error
    }
  }

  async delete(relativePath: string): Promise<void> {
    const key = this.getS3Key(relativePath)

    // S3 DeleteObject doesn't error if key doesn't exist
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
  }

  async exists(relativePath: string): Promise<boolean> {
    const key = this.getS3Key(relativePath)

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )
      return true
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return false
      }
      throw error
    }
  }

  async getSize(relativePath: string): Promise<number> {
    const key = this.getS3Key(relativePath)

    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )

      if (response.ContentLength === undefined) {
        throw new Error(`Unable to get size for: ${relativePath}`)
      }

      return response.ContentLength
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        throw new Error(`File not found: ${relativePath}`)
      }
      throw error
    }
  }

  /**
   * Check if an error is a "not found" error from S3
   */
  private isNotFoundError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'name' in error) {
      const name = (error as { name: string }).name
      return name === 'NotFound' || name === 'NoSuchKey'
    }
    return false
  }

  /**
   * Get bucket name (for debugging/info purposes)
   */
  getBucket(): string {
    return this.bucket
  }

  /**
   * Get key prefix (for debugging/info purposes)
   */
  getKeyPrefix(): string {
    return this.keyPrefix
  }
}
