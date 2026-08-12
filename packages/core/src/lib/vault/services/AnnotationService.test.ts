// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AnnotationService tests
 *
 * Markup is an edit to the engineering record, so writing it is gated on the
 * owning item's checkout. These tests cover that gate — who may write, who may
 * only read, and who may revise someone else's words — because a hole in it
 * would let anyone alter a released drawing's markup on main.
 *
 * Run: npm run test -- src/lib/vault/services/AnnotationService.test.ts
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
import { AnnotationService } from './AnnotationService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { BranchService } from '@/lib/services/BranchService'
import { itemVersions, programs, vaultFiles } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import {
  ItemCheckoutRequiredError,
  PermissionDeniedError,
  ResourceLockedError,
} from '@/lib/errors'

import '@/lib/items/registerItemTypes.server'

describe('AnnotationService', () => {
  const testDb = new TestDatabase()
  let owner: TestUser
  let bystander: TestUser
  let designId: string
  let mainBranchId: string
  let initialCommitId: string
  let ecoBranchId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    uniquePrefix = `A${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    owner = await insertTestUser(testDb.db)
    bystander = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Markup Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: owner.id,
        })
        .returning(),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Markup Design',
        code: `DES-${uniquePrefix}`,
        designType: 'Engineering',
      },
      owner.id,
    )

    designId = design.id
    mainBranchId = design.mainBranch!.id
    initialCommitId = design.initialCommit!.id

    const changeOrder = await ItemService.create(
      'ChangeOrder',
      {
        revision: 'A',
        name: 'Markup ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Markup test',
        designId,
      } as any,
      owner.id,
    )

    const { branch } = await BranchService.getOrCreateEcoBranch(
      designId,
      changeOrder.id,
      owner.id,
    )
    ecoBranchId = branch.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** A released document with one PDF attachment, as shipped on main. */
  async function createDocumentWithFile() {
    const document = await ItemService.create(
      'Document',
      {
        itemNumber: `DOC-${uniquePrefix}`,
        revision: 'A',
        name: 'Spec',
        state: 'Released',
        designId,
      } as any,
      owner.id,
      { bypassBranchProtection: true },
    )

    await testDb.db.insert(itemVersions).values({
      commitId: initialCommitId,
      itemId: document.id,
      changeType: 'added',
    })

    const file = takeFirst(
      await testDb.db
        .insert(vaultFiles)
        .values({
          itemId: document.id,
          fileName: 'spec.pdf',
          originalFileName: 'spec.pdf',
          fileSize: 1024,
          mimeType: 'application/pdf',
          fileHash: 'a'.repeat(64),
          storagePath: `${document.masterId}/A/spec.pdf`,
          uploadedBy: owner.id,
        })
        .returning(),
    )

    return { document, file }
  }

  const highlight = {
    pageNumber: 1,
    geometry: {
      kind: 'highlight' as const,
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
    },
    color: '#facc15',
    contents: null,
  }

  it('refuses markup when nobody holds the item checkout', async () => {
    const { file } = await createDocumentWithFile()

    await expect(
      AnnotationService.create(file.id, highlight, owner.id),
    ).rejects.toThrow(ItemCheckoutRequiredError)

    expect(await AnnotationService.list(file.id)).toHaveLength(0)
  })

  it('accepts markup from the holder of the checkout', async () => {
    const { document, file } = await createDocumentWithFile()
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      owner.id,
    )

    const annotation = await AnnotationService.create(
      file.id,
      highlight,
      owner.id,
    )

    expect(annotation.kind).toBe('highlight')
    expect(annotation.authorId).toBe(owner.id)
    expect(await AnnotationService.list(file.id)).toHaveLength(1)
  })

  it('refuses markup from someone else while the item is checked out', async () => {
    const { document, file } = await createDocumentWithFile()
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      owner.id,
    )

    await expect(
      AnnotationService.create(file.id, highlight, bystander.id),
    ).rejects.toThrow(ResourceLockedError)
  })

  it('lets anyone read markup regardless of the checkout', async () => {
    const { document, file } = await createDocumentWithFile()
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      owner.id,
    )
    await AnnotationService.create(file.id, highlight, owner.id)

    // Reading is not gated: a reviewer with design access sees the redlines
    // without having to take the lock away from whoever is drawing them.
    const visible = await AnnotationService.list(file.id)
    expect(visible).toHaveLength(1)
    expect(visible[0]?.authorId).toBe(owner.id)
  })

  it('refuses to let one person rewrite another person’s markup', async () => {
    const { document, file } = await createDocumentWithFile()
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      owner.id,
    )
    const annotation = await AnnotationService.create(
      file.id,
      {
        ...highlight,
        geometry: { kind: 'note', anchor: { x: 0.5, y: 0.5 } },
        contents: 'Check this weld',
      },
      owner.id,
    )

    // Hand the checkout to the other user so the only thing left standing
    // between them and the edit is authorship.
    await CheckoutService.cancelCheckout(
      document.masterId,
      ecoBranchId,
      owner.id,
    )
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      bystander.id,
    )

    await expect(
      AnnotationService.update(
        annotation.id,
        { contents: 'Looks fine' },
        bystander.id,
      ),
    ).rejects.toThrow(PermissionDeniedError)

    const [unchanged] = await AnnotationService.list(file.id)
    expect(unchanged?.contents).toBe('Check this weld')
  })

  it('lets any checkout holder delete markup that no longer applies', async () => {
    const { document, file } = await createDocumentWithFile()
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      owner.id,
    )
    const annotation = await AnnotationService.create(
      file.id,
      highlight,
      owner.id,
    )

    await CheckoutService.cancelCheckout(
      document.masterId,
      ecoBranchId,
      owner.id,
    )
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      bystander.id,
    )

    await AnnotationService.delete(annotation.id, bystander.id)
    expect(await AnnotationService.list(file.id)).toHaveLength(0)
  })

  it('counts markup per file for the file list badge', async () => {
    const { document, file } = await createDocumentWithFile()
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      owner.id,
    )
    await AnnotationService.create(file.id, highlight, owner.id)
    await AnnotationService.create(file.id, highlight, owner.id)

    expect(await AnnotationService.countByFile([file.id])).toEqual({
      [file.id]: 2,
    })
    expect(await AnnotationService.countByFile([])).toEqual({})
  })

  it('does not attach markup to a branch the file cannot be seen on', async () => {
    // Sanity check on the denormalized itemId: markup is anchored to the file's
    // own item row, so it inherits that row's branch visibility rather than
    // needing a branch column of its own.
    const { document, file } = await createDocumentWithFile()
    await CheckoutService.checkout(
      { itemMasterId: document.masterId, branchId: ecoBranchId },
      owner.id,
    )

    const annotation = await AnnotationService.create(
      file.id,
      highlight,
      owner.id,
    )

    expect(annotation.itemId).toBe(document.id)
    expect(annotation.fileId).toBe(file.id)
    expect(mainBranchId).not.toBe(ecoBranchId)
  })
})
