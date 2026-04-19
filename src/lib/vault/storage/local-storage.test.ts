/**
 * LocalFileStorage Tests
 *
 * Unit tests for the local file system storage implementation.
 *
 * Run: npm run test -- src/lib/vault/storage/local-storage.test.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LocalFileStorage } from './local-storage'

describe('LocalFileStorage', () => {
  let storage: LocalFileStorage
  let testRoot: string

  beforeAll(() => {
    // Create a unique temp directory for tests
    testRoot = path.join(
      os.tmpdir(),
      `vault-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    storage = new LocalFileStorage(testRoot)
  })

  afterAll(async () => {
    // Clean up test directory
    try {
      await fs.promises.rm(testRoot, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('constructor', () => {
    it('creates root directory if it does not exist', () => {
      const newRoot = path.join(
        os.tmpdir(),
        `vault-constructor-test-${Date.now()}`,
      )
      try {
        expect(fs.existsSync(newRoot)).toBe(false)
        const newStorage = new LocalFileStorage(newRoot)
        expect(fs.existsSync(newRoot)).toBe(true)
        expect(newStorage.getRootPath()).toBe(path.resolve(newRoot))
      } finally {
        fs.rmSync(newRoot, { recursive: true, force: true })
      }
    })

    it('resolves relative paths to absolute', () => {
      const relativeRoot = './test-vault-relative'
      const newStorage = new LocalFileStorage(relativeRoot)
      expect(path.isAbsolute(newStorage.getRootPath())).toBe(true)
      // Clean up
      fs.rmSync(newStorage.getRootPath(), { recursive: true, force: true })
    })
  })

  describe('path validation', () => {
    it('rejects paths with directory traversal (..)', async () => {
      await expect(
        storage.store('../outside.txt', Buffer.from('data')),
      ).rejects.toThrow('Invalid path: directory traversal detected')
      await expect(storage.retrieve('../outside.txt')).rejects.toThrow(
        'Invalid path: directory traversal detected',
      )
      // exists() catches the error and returns false instead of throwing
      expect(await storage.exists('../outside.txt')).toBe(false)
      await expect(storage.delete('../outside.txt')).rejects.toThrow(
        'Invalid path: directory traversal detected',
      )
    })

    it('rejects paths with embedded directory traversal', async () => {
      await expect(
        storage.store('foo/../../../etc/passwd', Buffer.from('data')),
      ).rejects.toThrow('Invalid path')
      await expect(
        storage.store(
          'foo/bar/../../baz/../../../etc/passwd',
          Buffer.from('data'),
        ),
      ).rejects.toThrow('Invalid path')
    })

    it('rejects absolute paths', async () => {
      // Unix-style absolute path (works on both platforms after normalization)
      await expect(
        storage.store('/etc/passwd', Buffer.from('data')),
      ).rejects.toThrow('Invalid path: directory traversal detected')

      // Windows-style absolute path - only test on Windows since path.isAbsolute() is platform-specific
      if (process.platform === 'win32') {
        await expect(
          storage.store('C:\\Windows\\System32\\config', Buffer.from('data')),
        ).rejects.toThrow('Invalid path')
      }
    })

    it('allows valid nested paths', async () => {
      const validPath = 'designs/123/files/document.pdf'
      await storage.store(validPath, Buffer.from('test content'))
      expect(await storage.exists(validPath)).toBe(true)
      await storage.delete(validPath)
    })
  })

  describe('store', () => {
    it('stores a buffer to a file', async () => {
      const testPath = 'test-buffer.txt'
      const testData = Buffer.from('Hello, World!')

      await storage.store(testPath, testData)

      expect(await storage.exists(testPath)).toBe(true)
      const retrieved = await storage.retrieve(testPath)
      expect(retrieved.toString()).toBe('Hello, World!')

      await storage.delete(testPath)
    })

    it('stores binary data correctly', async () => {
      const testPath = 'test-binary.bin'
      const testData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])

      await storage.store(testPath, testData)

      const retrieved = await storage.retrieve(testPath)
      expect(Buffer.compare(retrieved, testData)).toBe(0)

      await storage.delete(testPath)
    })

    it('creates nested directories automatically', async () => {
      const nestedPath = 'level1/level2/level3/deep-file.txt'
      const testData = Buffer.from('deep content')

      await storage.store(nestedPath, testData)

      expect(await storage.exists(nestedPath)).toBe(true)
      const retrieved = await storage.retrieve(nestedPath)
      expect(retrieved.toString()).toBe('deep content')

      await storage.delete(nestedPath)
    })

    it('overwrites existing files', async () => {
      const testPath = 'overwrite-test.txt'

      await storage.store(testPath, Buffer.from('original'))
      await storage.store(testPath, Buffer.from('updated'))

      const retrieved = await storage.retrieve(testPath)
      expect(retrieved.toString()).toBe('updated')

      await storage.delete(testPath)
    })

    it('stores data from a ReadableStream', async () => {
      const testPath = 'stream-test.txt'
      const testData = 'Stream content here'

      // Create a ReadableStream from the test data
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(testData))
          controller.close()
        },
      })

      await storage.store(testPath, stream)

      expect(await storage.exists(testPath)).toBe(true)
      const retrieved = await storage.retrieve(testPath)
      expect(retrieved.toString()).toBe(testData)

      await storage.delete(testPath)
    })

    it('stores large data from a ReadableStream in chunks', async () => {
      const testPath = 'large-stream-test.bin'
      const chunkSize = 1024
      const numChunks = 10
      const chunks: Array<Uint8Array> = []

      // Generate random chunks
      for (let i = 0; i < numChunks; i++) {
        const chunk = new Uint8Array(chunkSize)
        for (let j = 0; j < chunkSize; j++) {
          chunk[j] = Math.floor(Math.random() * 256)
        }
        chunks.push(chunk)
      }

      // Create a ReadableStream that yields chunks
      let chunkIndex = 0
      const stream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < chunks.length) {
            controller.enqueue(chunks[chunkIndex])
            chunkIndex++
          } else {
            controller.close()
          }
        },
      })

      await storage.store(testPath, stream)

      const retrieved = await storage.retrieve(testPath)
      expect(retrieved.length).toBe(chunkSize * numChunks)

      // Verify content
      const expectedBuffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      expect(Buffer.compare(retrieved, expectedBuffer)).toBe(0)

      await storage.delete(testPath)
    })

    it('sets restrictive file permissions (0o600)', async () => {
      const testPath = 'permissions-test.txt'
      await storage.store(testPath, Buffer.from('secret'))

      const absolutePath = path.join(testRoot, testPath)
      const stats = await fs.promises.stat(absolutePath)

      // On Unix-like systems, check the mode
      // Windows doesn't have the same permission model
      if (process.platform !== 'win32') {
        const mode = stats.mode & 0o777
        expect(mode).toBe(0o600)
      }

      await storage.delete(testPath)
    })
  })

  describe('retrieve', () => {
    it('retrieves stored file content', async () => {
      const testPath = 'retrieve-test.txt'
      const testData = Buffer.from('Content to retrieve')

      await storage.store(testPath, testData)
      const retrieved = await storage.retrieve(testPath)

      expect(retrieved.toString()).toBe('Content to retrieve')

      await storage.delete(testPath)
    })

    it('throws error for non-existent file', async () => {
      await expect(storage.retrieve('non-existent-file.txt')).rejects.toThrow(
        'File not found',
      )
    })

    it('retrieves files from nested directories', async () => {
      const nestedPath = 'a/b/c/nested-retrieve.txt'
      await storage.store(nestedPath, Buffer.from('nested content'))

      const retrieved = await storage.retrieve(nestedPath)
      expect(retrieved.toString()).toBe('nested content')

      await storage.delete(nestedPath)
    })
  })

  describe('createReadStream', () => {
    it('creates a readable stream for a file', async () => {
      const testPath = 'stream-read-test.txt'
      const testData = 'Content for streaming'
      await storage.store(testPath, Buffer.from(testData))

      const stream = await storage.createReadStream(testPath)

      // Read from stream
      const reader = stream.getReader()
      const chunks: Array<Uint8Array> = []

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- deliberate infinite loop pattern for streams
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const result = Buffer.concat(chunks).toString()
      expect(result).toBe(testData)

      await storage.delete(testPath)
    })

    it('throws error for non-existent file', async () => {
      await expect(
        storage.createReadStream('non-existent-stream.txt'),
      ).rejects.toThrow('File not found')
    })

    it('streams large files correctly', async () => {
      const testPath = 'large-stream-read.bin'
      // Create a 100KB buffer
      const largeData = Buffer.alloc(100 * 1024)
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256
      }

      await storage.store(testPath, largeData)

      const stream = await storage.createReadStream(testPath)
      const reader = stream.getReader()
      const chunks: Array<Uint8Array> = []

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- deliberate infinite loop pattern for streams
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const result = Buffer.concat(chunks)
      expect(result.length).toBe(largeData.length)
      expect(Buffer.compare(result, largeData)).toBe(0)

      await storage.delete(testPath)
    })
  })

  describe('delete', () => {
    it('deletes an existing file', async () => {
      const testPath = 'delete-test.txt'
      await storage.store(testPath, Buffer.from('to delete'))

      expect(await storage.exists(testPath)).toBe(true)
      await storage.delete(testPath)
      expect(await storage.exists(testPath)).toBe(false)
    })

    it('does not throw for non-existent file', async () => {
      await expect(storage.delete('already-deleted.txt')).resolves.not.toThrow()
    })

    it('cleans up empty parent directories', async () => {
      const nestedPath = 'cleanup/nested/deep/file.txt'
      await storage.store(nestedPath, Buffer.from('data'))

      await storage.delete(nestedPath)

      // Check that parent directories were cleaned up
      const cleanupDir = path.join(testRoot, 'cleanup')
      expect(fs.existsSync(cleanupDir)).toBe(false)
    })

    it('does not delete non-empty parent directories', async () => {
      const path1 = 'shared-parent/file1.txt'
      const path2 = 'shared-parent/file2.txt'

      await storage.store(path1, Buffer.from('content 1'))
      await storage.store(path2, Buffer.from('content 2'))

      await storage.delete(path1)

      // Parent should still exist because file2 is there
      const parentDir = path.join(testRoot, 'shared-parent')
      expect(fs.existsSync(parentDir)).toBe(true)
      expect(await storage.exists(path2)).toBe(true)

      await storage.delete(path2)
    })
  })

  describe('exists', () => {
    it('returns true for existing file', async () => {
      const testPath = 'exists-test.txt'
      await storage.store(testPath, Buffer.from('data'))

      expect(await storage.exists(testPath)).toBe(true)

      await storage.delete(testPath)
    })

    it('returns false for non-existent file', async () => {
      expect(await storage.exists('does-not-exist.txt')).toBe(false)
    })

    it('returns false for deleted file', async () => {
      const testPath = 'was-deleted.txt'
      await storage.store(testPath, Buffer.from('data'))
      await storage.delete(testPath)

      expect(await storage.exists(testPath)).toBe(false)
    })
  })

  describe('getSize', () => {
    it('returns correct size for a file', async () => {
      const testPath = 'size-test.txt'
      const content = 'Hello, World!'
      await storage.store(testPath, Buffer.from(content))

      const size = await storage.getSize(testPath)
      expect(size).toBe(content.length)

      await storage.delete(testPath)
    })

    it('returns correct size for binary files', async () => {
      const testPath = 'binary-size-test.bin'
      const binaryData = Buffer.alloc(1024 * 5) // 5KB
      await storage.store(testPath, binaryData)

      const size = await storage.getSize(testPath)
      expect(size).toBe(1024 * 5)

      await storage.delete(testPath)
    })

    it('throws error for non-existent file', async () => {
      await expect(storage.getSize('no-size.txt')).rejects.toThrow(
        'File not found',
      )
    })

    it('returns 0 for empty file', async () => {
      const testPath = 'empty-file.txt'
      await storage.store(testPath, Buffer.from(''))

      const size = await storage.getSize(testPath)
      expect(size).toBe(0)

      await storage.delete(testPath)
    })
  })

  describe('getRootPath', () => {
    it('returns the absolute root path', () => {
      const rootPath = storage.getRootPath()
      expect(path.isAbsolute(rootPath)).toBe(true)
      expect(rootPath).toBe(testRoot)
    })
  })

  describe('concurrent operations', () => {
    it('handles multiple concurrent stores', async () => {
      const files = Array.from({ length: 10 }, (_, i) => ({
        path: `concurrent/file-${i}.txt`,
        content: `Content for file ${i}`,
      }))

      // Store all files concurrently
      await Promise.all(
        files.map((f) => storage.store(f.path, Buffer.from(f.content))),
      )

      // Verify all files exist and have correct content
      for (const f of files) {
        expect(await storage.exists(f.path)).toBe(true)
        const content = await storage.retrieve(f.path)
        expect(content.toString()).toBe(f.content)
      }

      // Cleanup
      await Promise.all(files.map((f) => storage.delete(f.path)))
    })

    it('handles concurrent reads of same file', async () => {
      const testPath = 'concurrent-read.txt'
      const testContent = 'Shared content for concurrent reads'
      await storage.store(testPath, Buffer.from(testContent))

      // Read the same file 10 times concurrently
      const results = await Promise.all(
        Array.from({ length: 10 }, () => storage.retrieve(testPath)),
      )

      for (const result of results) {
        expect(result.toString()).toBe(testContent)
      }

      await storage.delete(testPath)
    })
  })
})
