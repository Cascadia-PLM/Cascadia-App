/**
 * Vault Test Utilities
 *
 * Provides utilities for testing file vault operations:
 * - Mock storage implementation for unit tests
 * - Test file helpers that bypass database operations
 * - Storage validation utilities
 *
 * @example
 * ```typescript
 * import { MockVaultStorage, createTestFile, VaultTestHelper } from '@test/helpers/vault'
 *
 * // Use mock storage for unit tests
 * const mockStorage = new MockVaultStorage()
 * await mockStorage.store('test/file.txt', Buffer.from('hello'))
 *
 * // Use test helper for integration tests that need real storage
 * const vaultHelper = new VaultTestHelper()
 * await vaultHelper.testStorageConnection()
 * await vaultHelper.uploadAndDelete('test-file.txt', testBuffer)
 * ```
 */

import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type {
  FileUploadMetadata,
  StorageConfig,
  VaultStorage,
} from '@/lib/vault/storage/types'

/**
 * Mock vault storage for unit tests
 *
 * Stores files in memory without touching the filesystem.
 */
export class MockVaultStorage implements VaultStorage {
  private files: Map<string, Buffer> = new Map()
  private streamCalls: Array<string> = []

  /**
   * Store a file in memory
   */
  async store(filePath: string, data: Buffer | ReadableStream): Promise<void> {
    if (data instanceof ReadableStream) {
      // Convert stream to buffer
      const chunks: Array<Uint8Array> = []
      const reader = data.getReader()

      let readResult = await reader.read()
      while (!readResult.done) {
        if (readResult.value) chunks.push(readResult.value)
        readResult = await reader.read()
      }

      const buffer = Buffer.concat(chunks)
      this.files.set(filePath, buffer)
    } else {
      this.files.set(filePath, data)
    }
  }

  /**
   * Retrieve a file from memory
   */
  retrieve(filePath: string): Promise<Buffer> {
    const file = this.files.get(filePath)
    if (!file) {
      return Promise.reject(new Error(`File not found: ${filePath}`))
    }
    return Promise.resolve(file)
  }

  /**
   * Create a read stream for a file
   */
  createReadStream(filePath: string): Promise<ReadableStream> {
    const file = this.files.get(filePath)
    if (!file) {
      return Promise.reject(new Error(`File not found: ${filePath}`))
    }

    this.streamCalls.push(filePath)

    return Promise.resolve(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(file))
          controller.close()
        },
      }),
    )
  }

  /**
   * Delete a file from memory
   */
  delete(filePath: string): Promise<void> {
    this.files.delete(filePath)
    return Promise.resolve()
  }

  /**
   * Check if a file exists
   */
  exists(filePath: string): Promise<boolean> {
    return Promise.resolve(this.files.has(filePath))
  }

  /**
   * Get file size
   */
  getSize(filePath: string): Promise<number> {
    const file = this.files.get(filePath)
    if (!file) {
      return Promise.reject(new Error(`File not found: ${filePath}`))
    }
    return Promise.resolve(file.length)
  }

  // Test helpers

  /**
   * Get all stored files (for assertions)
   */
  getStoredFiles(): Map<string, Buffer> {
    return new Map(this.files)
  }

  /**
   * Get paths that were streamed
   */
  getStreamCalls(): Array<string> {
    return [...this.streamCalls]
  }

  /**
   * Clear all stored files
   */
  clear(): void {
    this.files.clear()
    this.streamCalls = []
  }

  /**
   * Get file count
   */
  get fileCount(): number {
    return this.files.size
  }

  /**
   * Get total size of all stored files
   */
  get totalSize(): number {
    let total = 0
    for (const file of this.files.values()) {
      total += file.length
    }
    return total
  }
}

/**
 * Create a test file buffer with optional content
 */
export function createTestFile(
  options: {
    content?: string | Buffer
    size?: number
    pattern?: 'text' | 'binary' | 'zeros'
  } = {},
): Buffer {
  const { content, size = 1024, pattern = 'text' } = options

  if (content) {
    return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')
  }

  switch (pattern) {
    case 'text': {
      const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
      const repeated = text.repeat(Math.ceil(size / text.length))
      return Buffer.from(repeated.slice(0, size), 'utf-8')
    }

    case 'binary': {
      const binaryBuffer = Buffer.alloc(size)
      for (let i = 0; i < size; i++) {
        binaryBuffer[i] = Math.floor(Math.random() * 256)
      }
      return binaryBuffer
    }

    case 'zeros':
      return Buffer.alloc(size, 0)

    default:
      return Buffer.alloc(size)
  }
}

/**
 * Create file metadata for testing
 */
export function createTestFileMetadata(
  overrides: Partial<FileUploadMetadata> = {},
): FileUploadMetadata {
  return {
    originalFileName: overrides.originalFileName ?? 'test-file.txt',
    mimeType: overrides.mimeType ?? 'text/plain',
    size: overrides.size ?? 1024,
    description: overrides.description ?? 'Test file for unit tests',
    ...overrides,
  }
}

/**
 * File metadata presets for common file types
 */
export const filePresets = {
  /** Plain text file */
  text: (name = 'document.txt'): FileUploadMetadata => ({
    originalFileName: name,
    mimeType: 'text/plain',
    size: 1024,
    description: 'Text document',
  }),

  /** PDF document */
  pdf: (name = 'document.pdf'): FileUploadMetadata => ({
    originalFileName: name,
    mimeType: 'application/pdf',
    size: 50 * 1024, // 50KB
    description: 'PDF document',
  }),

  /** JPEG image */
  image: (name = 'image.jpg'): FileUploadMetadata => ({
    originalFileName: name,
    mimeType: 'image/jpeg',
    size: 100 * 1024, // 100KB
    description: 'Image file',
  }),

  /** CAD file (STEP format) */
  cad: (name = 'model.step'): FileUploadMetadata => ({
    originalFileName: name,
    mimeType: 'application/step',
    size: 500 * 1024, // 500KB
    description: 'CAD model',
  }),

  /** Excel spreadsheet */
  spreadsheet: (name = 'data.xlsx'): FileUploadMetadata => ({
    originalFileName: name,
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 25 * 1024, // 25KB
    description: 'Spreadsheet',
  }),

  /** Large file (for testing size limits) */
  large: (name = 'large-file.bin', sizeInMB = 10): FileUploadMetadata => ({
    originalFileName: name,
    mimeType: 'application/octet-stream',
    size: sizeInMB * 1024 * 1024,
    description: 'Large binary file',
  }),
}

/**
 * Vault test helper for integration tests
 *
 * This helper allows testing actual vault storage operations without
 * creating the normal database records (files, history, etc.).
 * Useful for validating storage configuration and permissions.
 */
export class VaultTestHelper {
  private storage: VaultStorage | null = null
  private testFiles: Array<string> = []

  constructor(private config?: Partial<StorageConfig>) {}

  /**
   * Initialize storage connection
   * Call this in beforeAll
   */
  async setup(): Promise<void> {
    // Dynamically import to avoid circular dependencies
    const { StorageFactory } = await import('@/lib/vault/storage')

    if (this.config) {
      this.storage = StorageFactory.create({
        type: this.config.type ?? 'local',
        rootPath: this.config.rootPath,
        ...this.config,
      } as StorageConfig)
    } else {
      this.storage = StorageFactory.createFromEnv()
    }
  }

  /**
   * Clean up test files
   * Call this in afterAll or afterEach
   */
  async cleanup(): Promise<void> {
    if (!this.storage) return

    for (const filePath of this.testFiles) {
      try {
        await this.storage.delete(filePath)
      } catch {
        // Ignore errors during cleanup
      }
    }

    this.testFiles = []
  }

  /**
   * Test storage connection and basic operations
   * Validates that the vault is properly configured
   */
  async testStorageConnection(): Promise<{
    success: boolean
    canStore: boolean
    canRetrieve: boolean
    canDelete: boolean
    error?: string
  }> {
    if (!this.storage) {
      return {
        success: false,
        canStore: false,
        canRetrieve: false,
        canDelete: false,
        error: 'Storage not initialized',
      }
    }

    const testPath = `__test__/connection-test-${Date.now()}.txt`
    const testData = Buffer.from('Connection test')

    try {
      // Test store
      await this.storage.store(testPath, testData)

      // Test retrieve
      const retrieved = await this.storage.retrieve(testPath)
      const canRetrieve = retrieved.toString() === testData.toString()

      // Test delete
      await this.storage.delete(testPath)
      const canDelete = !(await this.storage.exists(testPath))

      return {
        success: canRetrieve && canDelete,
        canStore: true,
        canRetrieve,
        canDelete,
      }
    } catch (error) {
      // Clean up if partial success
      try {
        await this.storage.delete(testPath)
      } catch {
        // Ignore cleanup errors
      }

      return {
        success: false,
        canStore: false,
        canRetrieve: false,
        canDelete: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Upload a test file and immediately delete it
   * Useful for testing permissions and file type validation
   */
  async uploadAndDelete(
    fileName: string,
    content: Buffer,
  ): Promise<{
    uploadSuccess: boolean
    deleteSuccess: boolean
    storedSize: number
    error?: string
  }> {
    if (!this.storage) {
      return {
        uploadSuccess: false,
        deleteSuccess: false,
        storedSize: 0,
        error: 'Storage not initialized',
      }
    }

    const testPath = `__test__/${fileName}`

    try {
      // Upload
      await this.storage.store(testPath, content)
      const storedSize = await this.storage.getSize(testPath)

      // Delete
      await this.storage.delete(testPath)

      return {
        uploadSuccess: true,
        deleteSuccess: true,
        storedSize,
      }
    } catch (error) {
      // Try to clean up
      try {
        await this.storage.delete(testPath)
      } catch {
        // Ignore
      }

      return {
        uploadSuccess: false,
        deleteSuccess: false,
        storedSize: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Store a test file (will be tracked for cleanup)
   */
  async storeTestFile(relativePath: string, content: Buffer): Promise<void> {
    if (!this.storage) {
      throw new Error('Storage not initialized')
    }

    const testPath = `__test__/${relativePath}`
    await this.storage.store(testPath, content)
    this.testFiles.push(testPath)
  }

  /**
   * Retrieve a test file
   */
  async retrieveTestFile(relativePath: string): Promise<Buffer> {
    if (!this.storage) {
      throw new Error('Storage not initialized')
    }

    return this.storage.retrieve(`__test__/${relativePath}`)
  }

  /**
   * Check if a test file exists
   */
  async testFileExists(relativePath: string): Promise<boolean> {
    if (!this.storage) {
      throw new Error('Storage not initialized')
    }

    return this.storage.exists(`__test__/${relativePath}`)
  }
}

/**
 * Return type for createFileServiceMocks
 */
export interface FileServiceMocks {
  uploadFile: Mock
  downloadFile: Mock
  deleteFile: Mock
  getFileMetadata: Mock
  listItemFiles: Mock
  checkOutFile: Mock
  checkInFile: Mock
  getFileHistory: Mock
  configureUploadSuccess: (
    fileRecord?: Partial<{
      id: string
      itemId: string
      fileName: string
      fileSize: number
      mimeType: string
      fileVersion: number
    }>,
  ) => {
    id: string
    itemId: string
    fileName: string
    originalFileName: string
    fileSize: number
    mimeType: string
    fileHash: string
    storageType: string
    storagePath: string
    fileVersion: number
    isLatestVersion: boolean
    isCheckedOut: boolean
    checkedOutBy: null
    checkedOutAt: null
    uploadedBy: string
    uploadedAt: Date
    metadata: Record<string, unknown>
    deletedAt: null
    deletedBy: null
  }
  configureDownloadSuccess: (content?: Buffer | string) => Buffer
  configureError: (method: keyof FileServiceMocks, error: string) => void
  reset: () => void
}

/**
 * Create mocked FileService methods
 */
export function createFileServiceMocks(): FileServiceMocks {
  const mocks: FileServiceMocks = {
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    deleteFile: vi.fn(),
    getFileMetadata: vi.fn(),
    listItemFiles: vi.fn(),
    checkOutFile: vi.fn(),
    checkInFile: vi.fn(),
    getFileHistory: vi.fn(),

    /**
     * Configure mocks for a successful upload
     */
    configureUploadSuccess(
      fileRecord: Partial<{
        id: string
        itemId: string
        fileName: string
        fileSize: number
        mimeType: string
        fileVersion: number
      }> = {},
    ) {
      const defaultRecord = {
        id: crypto.randomUUID(),
        itemId: crypto.randomUUID(),
        fileName: 'test-file.txt',
        originalFileName: 'test-file.txt',
        fileSize: 1024,
        mimeType: 'text/plain',
        fileHash: 'abc123',
        storageType: 'local',
        storagePath: '/test/path',
        fileVersion: 1,
        isLatestVersion: true,
        isCheckedOut: false,
        checkedOutBy: null,
        checkedOutAt: null,
        uploadedBy: crypto.randomUUID(),
        uploadedAt: new Date(),
        metadata: {},
        deletedAt: null,
        deletedBy: null,
        ...fileRecord,
      }

      mocks.uploadFile.mockResolvedValue(defaultRecord)
      return defaultRecord
    },

    /**
     * Configure mocks for a successful download
     */
    configureDownloadSuccess(content: Buffer | string = 'Test file content') {
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content)
      mocks.downloadFile.mockResolvedValue(buffer)
      return buffer
    },

    /**
     * Configure mock to throw an error
     */
    configureError(method: keyof FileServiceMocks, error: string) {
      const mock = mocks[method]
      if (typeof mock === 'function' && 'mockRejectedValue' in mock) {
        mock.mockRejectedValue(new Error(error))
      }
    },

    /**
     * Reset all mocks
     */
    reset() {
      vi.clearAllMocks()
    },
  }

  return mocks
}

/**
 * Vault assertions for tests
 */
export const vaultAssertions = {
  /**
   * Assert that a file was stored correctly
   */
  async fileExists(storage: VaultStorage, path: string): Promise<void> {
    const exists = await storage.exists(path)
    if (!exists) {
      throw new Error(`Expected file to exist at ${path}`)
    }
  },

  /**
   * Assert that a file does not exist
   */
  async fileNotExists(storage: VaultStorage, path: string): Promise<void> {
    const exists = await storage.exists(path)
    if (exists) {
      throw new Error(`Expected file NOT to exist at ${path}`)
    }
  },

  /**
   * Assert file content matches expected
   */
  async fileContentEquals(
    storage: VaultStorage,
    path: string,
    expected: Buffer | string,
  ): Promise<void> {
    const actual = await storage.retrieve(path)
    const expectedBuffer = Buffer.isBuffer(expected)
      ? expected
      : Buffer.from(expected)

    if (!actual.equals(expectedBuffer)) {
      throw new Error(`File content at ${path} does not match expected content`)
    }
  },

  /**
   * Assert file size matches expected
   */
  async fileSizeEquals(
    storage: VaultStorage,
    path: string,
    expectedSize: number,
  ): Promise<void> {
    const actualSize = await storage.getSize(path)
    if (actualSize !== expectedSize) {
      throw new Error(`Expected file size ${expectedSize}, got ${actualSize}`)
    }
  },
}
