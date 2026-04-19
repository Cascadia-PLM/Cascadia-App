import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { Readable, pipeline } from 'node:stream'

import type { VaultStorage } from './types'

const pipelineAsync = promisify(pipeline)

/**
 * Local file system storage implementation
 * Stores files in a directory on the server's filesystem
 */
export class LocalFileStorage implements VaultStorage {
  private rootPath: string

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath)
    this.ensureRootExists()
  }

  /**
   * Ensure the vault root directory exists
   */
  private ensureRootExists(): void {
    if (!fs.existsSync(this.rootPath)) {
      fs.mkdirSync(this.rootPath, { recursive: true, mode: 0o700 })
    }
  }

  /**
   * Get absolute path from relative vault path
   * Validates path to prevent directory traversal attacks
   */
  private getAbsolutePath(relativePath: string): string {
    // Normalize and resolve the path
    const normalized = path.normalize(relativePath)

    // Prevent directory traversal
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      throw new Error('Invalid path: directory traversal detected')
    }

    const absolutePath = path.join(this.rootPath, normalized)

    // Double-check that the resolved path is within the vault root
    if (!absolutePath.startsWith(this.rootPath)) {
      throw new Error('Invalid path: outside vault root')
    }

    return absolutePath
  }

  /**
   * Ensure parent directory exists for a file path
   */
  private ensureDirectoryExists(filePath: string): void {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }

  async store(
    relativePath: string,
    data: Buffer | ReadableStream,
  ): Promise<void> {
    const absolutePath = this.getAbsolutePath(relativePath)
    this.ensureDirectoryExists(absolutePath)

    if (data instanceof Buffer) {
      // Write buffer directly
      await fs.promises.writeFile(absolutePath, data, { mode: 0o600 })
    } else {
      // Stream the data to file
      const writeStream = fs.createWriteStream(absolutePath, { mode: 0o600 })

      // Convert Web ReadableStream to Node.js Readable if needed
      if (data instanceof ReadableStream) {
        const reader = data.getReader()
        const nodeStream = new Readable({
          async read() {
            try {
              const { done, value } = await reader.read()
              if (done) {
                this.push(null)
              } else {
                this.push(value)
              }
            } catch (err) {
              this.destroy(err as Error)
            }
          },
        })
        await pipelineAsync(nodeStream, writeStream)
      }
    }

    // Set restrictive permissions (owner read/write only)
    await fs.promises.chmod(absolutePath, 0o600)
  }

  async retrieve(relativePath: string): Promise<Buffer> {
    const absolutePath = this.getAbsolutePath(relativePath)

    if (!(await this.exists(relativePath))) {
      throw new Error(`File not found: ${relativePath}`)
    }

    return await fs.promises.readFile(absolutePath)
  }

  async createReadStream(relativePath: string): Promise<ReadableStream> {
    const absolutePath = this.getAbsolutePath(relativePath)

    if (!(await this.exists(relativePath))) {
      throw new Error(`File not found: ${relativePath}`)
    }

    const nodeStream = fs.createReadStream(absolutePath)

    // Convert Node.js Readable to Web ReadableStream
    return new ReadableStream({
      start(controller) {
        nodeStream.on('data', (chunk: string | Buffer) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          controller.enqueue(new Uint8Array(buffer))
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
  }

  async delete(relativePath: string): Promise<void> {
    const absolutePath = this.getAbsolutePath(relativePath)

    if (await this.exists(relativePath)) {
      await fs.promises.unlink(absolutePath)

      // Clean up empty parent directories (optional)
      await this.cleanupEmptyDirectories(path.dirname(absolutePath))
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const absolutePath = this.getAbsolutePath(relativePath)
      await fs.promises.access(absolutePath, fs.constants.F_OK)
      return true
    } catch {
      return false
    }
  }

  async getSize(relativePath: string): Promise<number> {
    const absolutePath = this.getAbsolutePath(relativePath)

    if (!(await this.exists(relativePath))) {
      throw new Error(`File not found: ${relativePath}`)
    }

    const stats = await fs.promises.stat(absolutePath)
    return stats.size
  }

  /**
   * Clean up empty parent directories up to the vault root
   * This keeps the vault directory structure clean
   */
  private async cleanupEmptyDirectories(dir: string): Promise<void> {
    // Don't delete the root vault directory
    if (dir === this.rootPath) {
      return
    }

    try {
      const files = await fs.promises.readdir(dir)

      // If directory is empty, delete it and check parent
      if (files.length === 0) {
        await fs.promises.rmdir(dir)
        await this.cleanupEmptyDirectories(path.dirname(dir))
      }
    } catch {
      // Ignore errors (directory might not be empty or might not exist)
    }
  }

  /**
   * Get vault root path (for debugging/info purposes)
   */
  getRootPath(): string {
    return this.rootPath
  }
}
