// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * FileService — item-number naming for native CAD files
 *
 * Data-integrity gate. Under `VAULT_NATIVE_CAD_NAMING=itemNumber` the vault,
 * not the uploader, decides what a native CAD file is called, and native CAD
 * files find each other by name: an assembly names its parts, a drawing its
 * model. Renaming the wrong file, or giving two attachments on one item the
 * same name, breaks the workspace a CAD client checks out.
 *
 * Invariants: under `preserve` nothing is renamed, on upload or check-in; a
 * native CAD file takes the item number and keeps its submitted name as
 * `sourceFileName`; a check-in keeps the item-number name for the file the
 * rule renamed and for nothing else; and the item-number name is only taken
 * while no other current file the same branch context lists already holds it.
 *
 * Bytes go to a throwaway directory under the OS temp dir, never the dev vault.
 *
 * Run: npx vitest run cascadia-api/src/vault/services/FileService.naming.test.ts
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { FileService } from './FileService'
import type { FileRecord } from '@cascadia/commons/vault/types'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'
import { branches } from '@/db/schema'
import { takeFirst } from '@/db/take-first'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { LocalFileStorage, StorageFactory } from '@/vault/storage'

const MIME = 'application/octet-stream'

describe('FileService — native CAD naming', () => {
  const testDb = new TestDatabase()

  let vaultRoot: string
  let storage: LocalFileStorage
  let user: TestUser
  let itemId: string
  /** What the item's native CAD files are named, less the extension. */
  let itemNumber: string
  let bytesWritten = 0

  beforeAll(async () => {
    await testDb.setup()
    vaultRoot = await mkdtemp(join(tmpdir(), 'cascadia-vault-naming-'))
    storage = new LocalFileStorage(vaultRoot)
  })

  afterAll(async () => {
    await testDb.teardown()
    await rm(vaultRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // Per test: `restoreMocks` restores every spy before each one.
    vi.spyOn(StorageFactory, 'createFromSettings').mockResolvedValue(storage)
    vi.stubEnv('VAULT_NATIVE_CAD_NAMING', 'itemNumber')

    user = await insertTestUser(testDb.db)
    // Dotted on purpose: the whole number has to survive as the stem.
    itemNumber = `100.200.${randomUUID().slice(0, 8)}`
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber,
    })
    itemId = item.id
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await testDb.rollback()
  })

  /** Distinct bytes per call, so no two uploads share a content hash. */
  const bytesFor = (name: string) => Buffer.from(`${name} #${++bytesWritten}`)

  async function upload(
    name: string,
    options: { branchId?: string } = {},
  ): Promise<FileRecord> {
    const file = bytesFor(name)
    return FileService.uploadFile({
      itemId,
      branchId: options.branchId,
      file,
      metadata: { originalFileName: name, mimeType: MIME, size: file.length },
      uploadedBy: user.id,
    })
  }

  async function checkIn(file: FileRecord, name: string): Promise<FileRecord> {
    await FileService.checkOutFile(file.id, user.id)
    const data = bytesFor(name)
    const next = await FileService.checkInFile(file.id, user.id, data, {
      originalFileName: name,
      mimeType: MIME,
      size: data.length,
    })
    if (!next) throw new Error('check-in with new bytes made no version')
    return next
  }

  const sourceNameOf = (file: FileRecord): unknown =>
    (file.metadata as Record<string, unknown> | null)?.sourceFileName

  describe('upload', () => {
    it('stores a native CAD file under the item number and keeps the submitted name', async () => {
      const file = await upload('bracket.SLDPRT')

      expect(file.originalFileName).toBe(`${itemNumber}.sldprt`)
      expect(sourceNameOf(file)).toBe('bracket.SLDPRT')
    })

    it('leaves exchange, mesh and non-CAD files with their submitted names', async () => {
      for (const name of [
        'housing.step',
        'housing.stl',
        'housing.glb',
        'A3_L.pdf',
        'photo.png',
      ]) {
        const file = await upload(name)
        expect(file.originalFileName).toBe(name)
        expect(sourceNameOf(file)).toBeUndefined()
      }
    })

    it('renames nothing under preserve, on upload or check-in', async () => {
      vi.stubEnv('VAULT_NATIVE_CAD_NAMING', 'preserve')

      const file = await upload('bracket.sldprt')
      expect(file.originalFileName).toBe('bracket.sldprt')
      expect(sourceNameOf(file)).toBeUndefined()

      const next = await checkIn(file, 'bracket_v2.sldprt')
      expect(next.originalFileName).toBe('bracket_v2.sldprt')
      expect(sourceNameOf(next)).toBeUndefined()
    })
  })

  describe('check-in', () => {
    it('keeps the item-number name on a new version of a renamed CAD file', async () => {
      const file = await upload('bracket.sldprt')

      const next = await checkIn(file, 'bracket_v2.sldprt')

      expect(next.fileVersion).toBe(file.fileVersion + 1)
      expect(next.originalFileName).toBe(`${itemNumber}.sldprt`)
      expect(sourceNameOf(next)).toBe('bracket_v2.sldprt')
    })

    it('lets a file the rule does not rename take its checked-in name', async () => {
      const pdf = await upload('A3_L.pdf')
      const nextPdf = await checkIn(pdf, 'A3_L_rev2.pdf')
      expect(nextPdf.originalFileName).toBe('A3_L_rev2.pdf')
      expect(sourceNameOf(nextPdf)).toBeUndefined()

      const step = await upload('housing.step')
      const nextStep = await checkIn(step, 'housing_rev2.step')
      expect(nextStep.originalFileName).toBe('housing_rev2.step')
    })
  })

  describe('name clashes', () => {
    /** Current (latest, undeleted) files on the item, by name. */
    async function currentNames(): Promise<Array<string>> {
      const files = await FileService.listItemFiles(itemId)
      return files
        .filter((f) => f.isLatestVersion)
        .map((f) => f.originalFileName)
    }

    it('lets a second native file of the same extension keep its own name', async () => {
      const first = await upload('left.sldprt')
      const second = await upload('right.sldprt')

      expect(first.originalFileName).toBe(`${itemNumber}.sldprt`)
      expect(second.originalFileName).toBe('right.sldprt')
      expect(sourceNameOf(second)).toBeUndefined()

      // Nor does checking the second one in take the name from the first.
      await checkIn(second, 'right_v2.sldprt')

      const names = await currentNames()
      expect(new Set(names).size).toBe(names.length)
      expect(names).toContain('right_v2.sldprt')
    })

    it('treats names differing only in case as the same name', async () => {
      // Uploaded before the deployment switched modes.
      vi.stubEnv('VAULT_NATIVE_CAD_NAMING', 'preserve')
      await upload(`${itemNumber}.SLDPRT`)
      vi.stubEnv('VAULT_NATIVE_CAD_NAMING', 'itemNumber')

      const file = await upload('bracket.sldprt')

      expect(file.originalFileName).toBe('bracket.sldprt')
    })

    it('does not count a deleted file as holding the name', async () => {
      const old = await upload('old.sldprt')
      await FileService.deleteFile(old.id, user.id)

      const file = await upload('new.sldprt')

      expect(file.originalFileName).toBe(`${itemNumber}.sldprt`)
    })

    it('only clashes with files the same branch context lists', async () => {
      const suffix = randomUUID().slice(0, 8).toUpperCase()
      const program = await ProgramService.create(
        { name: `Naming ${suffix}`, code: `NM-${suffix}` },
        user.id,
      )
      const design = await DesignService.create(
        {
          programId: program.id,
          name: `Naming ${suffix}`,
          code: `ND-${suffix}`,
          designType: 'Engineering',
        },
        user.id,
      )
      const mainBranchId = design.defaultBranchId
      if (!mainBranchId) throw new Error('design was created without main')

      const ecoBranch = async (name: string) =>
        takeFirst(
          await testDb.db
            .insert(branches)
            .values({
              designId: design.id,
              name: `eco/${name}-${suffix}`,
              branchType: 'eco',
              createdBy: user.id,
            })
            .returning(),
        ).id
      const ecoA = await ecoBranch('A')
      const ecoB = await ecoBranch('B')

      const canonical = `${itemNumber}.sldprt`

      // Two ECO branches never list each other's files.
      expect(
        (await upload('a.sldprt', { branchId: ecoA })).originalFileName,
      ).toBe(canonical)
      expect(
        (await upload('b.sldprt', { branchId: ecoB })).originalFileName,
      ).toBe(canonical)

      // A file on main, or on no branch, is listed on every branch, so either
      // would sit beside the ECO files that already hold the name.
      expect(
        (await upload('m.sldprt', { branchId: mainBranchId })).originalFileName,
      ).toBe('m.sldprt')
      expect((await upload('g.sldprt')).originalFileName).toBe('g.sldprt')
    })
  })
})
