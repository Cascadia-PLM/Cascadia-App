// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * FileService category-override tests
 *
 * Data-integrity gate: the category a file carries decides how it is badged,
 * filtered, and counted, and it is coupled to `isPrimaryModel` — the flag the
 * 3D viewer and downstream CAD conversions follow. A wrong coupling strands a
 * "primary model" that is actually a specification.
 *
 * Invariants: a manual category is authoritative and marked as such; clearing
 * it returns the file to whatever detection says today; and the primary-model
 * flag only ever rides a file categorized as a CAD model.
 *
 * Storage is never touched — rows are inserted directly, because
 * `setFileCategory` is pure database work.
 *
 * Run: npx vitest run src/lib/vault/services/FileService.category.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { eq } from 'drizzle-orm'
import { FileService } from './FileService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { FileCategory } from '@/lib/vault/file-categories'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestDocument } from '@/__tests__/fixtures/items'
import { vaultFiles } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { ValidationError } from '@/lib/errors'

describe('FileService.setFileCategory', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let itemId: string

  beforeAll(() => testDb.setup())
  afterAll(() => testDb.teardown())
  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const { item } = await insertTestDocument(testDb.db, null, user.id)
    itemId = item.id
  })
  afterEach(() => testDb.rollback())

  /** Insert a vault row directly — no storage, no upload pipeline. */
  const addFile = async (overrides: {
    originalFileName: string
    mimeType: string
    fileCategory: string | null
    categorySource?: string
    isPrimaryModel?: boolean
  }) =>
    takeFirst(
      await testDb.db
        .insert(vaultFiles)
        .values({
          itemId,
          fileName: overrides.originalFileName,
          originalFileName: overrides.originalFileName,
          fileSize: 1024,
          mimeType: overrides.mimeType,
          fileHash: `hash-${overrides.originalFileName}`,
          storageType: 'local',
          storagePath: `test/${overrides.originalFileName}`,
          fileVersion: 1,
          isLatestVersion: true,
          isCheckedOut: false,
          uploadedBy: user.id,
          fileCategory: overrides.fileCategory,
          categorySource: overrides.categorySource ?? 'auto',
          isPrimaryModel: overrides.isPrimaryModel ?? false,
        })
        .returning(),
    )

  const reread = async (fileId: string) =>
    takeFirst(
      await testDb.db
        .select()
        .from(vaultFiles)
        .where(eq(vaultFiles.id, fileId)),
    )

  it('records a chosen category as manual', async () => {
    const file = await addFile({
      originalFileName: 'Cert_of_Conformance.pdf',
      mimeType: 'application/pdf',
      fileCategory: 'reference',
    })

    await FileService.setFileCategory(file.id, 'specification', user.id)

    const updated = await reread(file.id)
    expect(updated.fileCategory).toBe('specification')
    expect(updated.categorySource).toBe('manual')
  })

  it('returns to the detected category when the override is cleared', async () => {
    const file = await addFile({
      originalFileName: 'Cert_of_Conformance.pdf',
      mimeType: 'application/pdf',
      fileCategory: 'specification',
      categorySource: 'manual',
    })

    await FileService.setFileCategory(file.id, null, user.id)

    const updated = await reread(file.id)
    // Detection has no filename hint to go on, so it declines to guess
    expect(updated.fileCategory).toBe('reference')
    expect(updated.categorySource).toBe('auto')
  })

  it('writes an audit entry naming both categories', async () => {
    const file = await addFile({
      originalFileName: 'TDJ-25.pdf',
      mimeType: 'application/pdf',
      fileCategory: 'reference',
    })

    await FileService.setFileCategory(file.id, 'analysis', user.id)

    const history = await FileService.getFileHistory(file.id)
    const entry = history.find((h) => h.action === 'set_category')
    expect(entry).toBeDefined()
    expect(entry.details).toMatchObject({
      from: 'reference',
      to: 'analysis',
      source: 'manual',
    })
  })

  describe('primary-model coupling', () => {
    it('drops the primary flag when the file stops being a CAD model', async () => {
      const file = await addFile({
        originalFileName: 'bracket.step',
        mimeType: 'application/octet-stream',
        fileCategory: 'cad_model',
        isPrimaryModel: true,
      })

      await FileService.setFileCategory(file.id, 'reference', user.id)

      expect((await reread(file.id)).isPrimaryModel).toBe(false)
    })

    it('adopts the primary flag when the item has no primary model', async () => {
      const file = await addFile({
        originalFileName: 'bracket.pdf',
        mimeType: 'application/pdf',
        fileCategory: 'reference',
      })

      await FileService.setFileCategory(file.id, 'cad_model', user.id)

      expect((await reread(file.id)).isPrimaryModel).toBe(true)
    })

    it('leaves an existing primary model alone', async () => {
      const incumbent = await addFile({
        originalFileName: 'bracket.step',
        mimeType: 'application/octet-stream',
        fileCategory: 'cad_model',
        isPrimaryModel: true,
      })
      const newcomer = await addFile({
        originalFileName: 'bracket_alt.pdf',
        mimeType: 'application/pdf',
        fileCategory: 'reference',
      })

      await FileService.setFileCategory(newcomer.id, 'cad_model', user.id)

      expect((await reread(newcomer.id)).isPrimaryModel).toBe(false)
      expect((await reread(incumbent.id)).isPrimaryModel).toBe(true)
    })
  })

  it('refuses to recategorize a converter-generated thumbnail', async () => {
    const file = await addFile({
      originalFileName: 'bracket_thumb.png',
      mimeType: 'image/png',
      fileCategory: 'thumbnail',
    })

    await expect(
      FileService.setFileCategory(file.id, 'reference', user.id),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses to recategorize a deleted file', async () => {
    const file = await addFile({
      originalFileName: 'gone.pdf',
      mimeType: 'application/pdf',
      fileCategory: 'reference',
    })
    await testDb.db
      .update(vaultFiles)
      .set({ deletedAt: new Date(), deletedBy: user.id })
      .where(eq(vaultFiles.id, file.id))

    await expect(
      FileService.setFileCategory(file.id, 'drawing', user.id),
    ).rejects.toThrow(ValidationError)
  })

  it('accepts every category in the shared vocabulary', async () => {
    const file = await addFile({
      originalFileName: 'anything.pdf',
      mimeType: 'application/pdf',
      fileCategory: 'reference',
    })

    const categories: Array<FileCategory> = [
      'cad_model',
      'drawing',
      'specification',
      'analysis',
      'reference',
      'other',
    ]

    for (const category of categories) {
      await FileService.setFileCategory(file.id, category, user.id)
      expect((await reread(file.id)).fileCategory).toBe(category)
    }
  })
})
