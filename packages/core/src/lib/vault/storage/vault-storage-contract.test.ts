// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * VaultStorage contract tests
 *
 * `LocalFileStorage` and `S3Storage` must classify the same refusals the
 * same way — a crafted path is a `ValidationError`, a path the backend does
 * not hold is a `NotFoundError` from `retrieve`/`createReadStream`/`getSize`
 * — because `handleApiError` maps those classes to specific HTTP statuses
 * and anything else falls through to an opaque 500. This suite runs the
 * same assertions against both backends (S3 backed by an in-memory stand-in
 * for `S3Client`) so that contract can't drift again, and so a third
 * backend has something to satisfy.
 *
 * Run: npm run test -- src/lib/vault/storage/vault-storage-contract.test.ts
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { LocalFileStorage } from './local-storage'
import { S3Storage } from './s3-storage'
import type { S3Client } from '@aws-sdk/client-s3'
import type { VaultStorage } from './types'
import { NotFoundError, ValidationError } from '@/lib/errors'

/**
 * Minimal in-memory stand-in for `S3Client` — implements only the commands
 * `S3Storage` issues, backed by a `Map` instead of a bucket, and shaped to
 * throw the same `name`d errors the real SDK throws on a miss so
 * `S3Storage`'s `isNotFoundError` branch exercises for real.
 */
class InMemoryS3Client {
  private objects = new Map<string, Buffer>()

  async send(
    command: unknown,
  ): Promise<{ Body?: Readable; ContentLength?: number }> {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key as string
      this.objects.set(key, await toBuffer(command.input.Body))
      return {}
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key as string
      const data = this.objects.get(key)
      if (data === undefined) throw sdkNotFoundError('NoSuchKey')
      return { Body: Readable.from(data) }
    }
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key as string
      const data = this.objects.get(key)
      if (data === undefined) throw sdkNotFoundError('NotFound')
      return { ContentLength: data.length }
    }
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key as string
      this.objects.delete(key)
      return {}
    }
    throw new Error(
      `Unsupported command in InMemoryS3Client: ${(command as { constructor: { name: string } }).constructor.name}`,
    )
  }
}

function sdkNotFoundError(name: 'NoSuchKey' | 'NotFound'): Error {
  const error = new Error(name)
  error.name = name
  return error
}

async function toBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body
  const chunks: Array<Buffer> = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

interface BackendUnderTest {
  name: string
  create: () => VaultStorage
  cleanup: () => Promise<void>
}

describe.each<BackendUnderTest>(
  (() => {
    let localRoot: string
    return [
      {
        name: 'LocalFileStorage',
        create: () => {
          localRoot = path.join(
            os.tmpdir(),
            `vault-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          )
          return new LocalFileStorage(localRoot)
        },
        cleanup: async () => {
          await fs.promises.rm(localRoot, { recursive: true, force: true })
        },
      },
      {
        name: 'S3Storage',
        create: () =>
          new S3Storage({
            bucket: 'contract-test-bucket',
            client: new InMemoryS3Client() as unknown as S3Client,
          }),
        cleanup: async () => {},
      },
    ]
  })(),
)('VaultStorage contract: $name', (backend) => {
  let storage: VaultStorage

  beforeAll(() => {
    storage = backend.create()
  })

  afterAll(async () => {
    await backend.cleanup()
  })

  describe('path traversal guards', () => {
    it('rejects a relative path containing ".." with ValidationError', async () => {
      await expect(
        storage.store('../outside.txt', Buffer.from('data')),
      ).rejects.toThrow(ValidationError)
    })

    it('rejects an absolute path with ValidationError', async () => {
      await expect(
        storage.store('/etc/passwd', Buffer.from('data')),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('missing files', () => {
    it('throws NotFoundError from retrieve', async () => {
      await expect(
        storage.retrieve('contract-missing-retrieve.txt'),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws NotFoundError from createReadStream', async () => {
      await expect(
        storage.createReadStream('contract-missing-stream.txt'),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws NotFoundError from getSize', async () => {
      await expect(
        storage.getSize('contract-missing-size.txt'),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('round trip', () => {
    it('stores, retrieves, sizes, and deletes a valid path', async () => {
      const testPath = 'contract/round-trip.txt'
      const content = Buffer.from('contract test content')

      await storage.store(testPath, content)
      expect(await storage.exists(testPath)).toBe(true)
      expect(await storage.getSize(testPath)).toBe(content.length)

      const retrieved = await storage.retrieve(testPath)
      expect(retrieved.toString()).toBe(content.toString())

      await storage.delete(testPath)
      expect(await storage.exists(testPath)).toBe(false)
    })
  })
})

describe('S3Storage getSize with a HeadObject response missing ContentLength', () => {
  it('throws an untyped Error, not NotFoundError or ValidationError', async () => {
    const client = {
      send: (command: unknown) => {
        if (command instanceof HeadObjectCommand) return Promise.resolve({})
        return Promise.reject(new Error('unexpected command'))
      },
    }
    const storage = new S3Storage({
      bucket: 'contract-test-bucket',
      client: client as unknown as S3Client,
    })

    try {
      await storage.getSize('some-file.txt')
      expect.fail('expected getSize to throw')
    } catch (error) {
      expect(error).not.toBeInstanceOf(NotFoundError)
      expect(error).not.toBeInstanceOf(ValidationError)
      expect((error as Error).message).toBe(
        'Unable to get size for: some-file.txt',
      )
    }
  })
})
