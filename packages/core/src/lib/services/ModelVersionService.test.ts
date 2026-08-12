// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ModelVersionService Tests
 *
 * Complex-algorithm gate: the service maps version contexts (released, work
 * branch, historical revision) to the CAD model each would display, across
 * two orthogonal axes — which item *row* a file hangs off, and which branch
 * the file is *visible* on. Getting the mapping wrong shows the wrong
 * geometry in the comparison overlay with no error anywhere.
 *
 * Invariants:
 * - the current entry resolves only main-visible files on the released row;
 *   branch-scoped uploads never leak into it
 * - a branch entry resolves that branch's own upload wherever it hangs
 *   (working copy row, or the base row for uploads made before the working
 *   copy was minted), and falls back to the released model when the branch
 *   hasn't touched geometry
 * - historical entries resolve only their own row's files; a metadata-only
 *   revision honestly reports no model
 * - archived branches and branch-deleted items produce no entries
 * - the pick priority matches the viewer: GLB-with-colors, then primary,
 *   then newest
 *
 * Run: npx vitest run src/lib/services/ModelVersionService.test.ts
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
import { ModelVersionService } from './ModelVersionService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  branches,
  items,
  programs,
  vaultFiles,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

describe('ModelVersionService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let mainBranchId: string
  let uniquePrefix: string

  beforeAll(() => testDb.setup())
  afterAll(() => testDb.teardown())

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `T${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Test Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!

    const mainBranch = await DesignService.getDefaultBranch(designId)
    mainBranchId = mainBranch!.id
  })

  afterEach(() => testDb.rollback())

  /** Insert an item version row directly. */
  async function addItemRow(overrides: {
    masterId?: string
    itemNumber?: string
    revision: string
    state: string
    isCurrent: boolean
    modifiedAt?: Date
  }) {
    return takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: overrides.masterId ?? crypto.randomUUID(),
          itemNumber: overrides.itemNumber ?? `PN-${uniquePrefix}`,
          revision: overrides.revision,
          itemType: 'Part',
          name: 'Bracket',
          state: overrides.state,
          isCurrent: overrides.isCurrent,
          designId,
          createdBy: user.id,
          modifiedBy: user.id,
          ...(overrides.modifiedAt ? { modifiedAt: overrides.modifiedAt } : {}),
        })
        .returning(),
    )
  }

  /** Insert a viewable CAD model file row — no storage, pure metadata. */
  async function addModelFile(
    itemId: string,
    overrides: {
      fileName: string
      branchId?: string | null
      hasColors?: boolean
      isPrimaryModel?: boolean
      uploadedAt?: Date
    },
  ) {
    return takeFirst(
      await testDb.db
        .insert(vaultFiles)
        .values({
          itemId,
          branchId: overrides.branchId ?? null,
          fileName: overrides.fileName,
          originalFileName: overrides.fileName,
          fileSize: 2048,
          mimeType: 'model/gltf-binary',
          fileHash: `hash-${overrides.fileName}-${crypto.randomUUID()}`,
          storageType: 'local',
          storagePath: `test/${overrides.fileName}`,
          fileVersion: 1,
          isLatestVersion: true,
          isCheckedOut: false,
          uploadedBy: user.id,
          fileCategory: 'cad_model',
          isPrimaryModel: overrides.isPrimaryModel ?? false,
          cadMetadata: overrides.hasColors ? { hasColors: true } : null,
          ...(overrides.uploadedAt ? { uploadedAt: overrides.uploadedAt } : {}),
        })
        .returning(),
    )
  }

  async function addBranch(overrides: {
    name: string
    branchType: string
    changeOrderItemId?: string
    isArchived?: boolean
  }) {
    return takeFirst(
      await testDb.db
        .insert(branches)
        .values({
          designId,
          name: overrides.name,
          branchType: overrides.branchType,
          changeOrderItemId: overrides.changeOrderItemId,
          isArchived: overrides.isArchived ?? false,
          createdBy: user.id,
        })
        .returning(),
    )
  }

  it('keeps branch uploads out of the current entry and resolves them on the branch entry', async () => {
    const released = await addItemRow({
      revision: 'A',
      state: 'Released',
      isCurrent: true,
    })
    // Uploaded on main: carries the main branch id, visible everywhere
    await addModelFile(released.id, {
      fileName: 'bracket-main.glb',
      branchId: mainBranchId,
    })

    // ECO branch with a working copy carrying the in-change model
    const eco = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: crypto.randomUUID(),
          itemNumber: `ECO-${uniquePrefix}`,
          revision: '-',
          itemType: 'ChangeOrder',
          name: 'Test ECO',
          state: 'Draft',
          designId,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    const ecoBranch = await addBranch({
      name: `eco/ECO-${uniquePrefix}`,
      branchType: 'eco',
      changeOrderItemId: eco.id,
    })
    const workingCopy = await addItemRow({
      masterId: released.masterId,
      revision: `-${ecoBranch.id.substring(0, 8)}`,
      state: 'Draft',
      isCurrent: false,
    })
    await testDb.db.insert(branchItems).values({
      branchId: ecoBranch.id,
      itemMasterId: released.masterId,
      currentItemId: workingCopy.id,
      baseItemId: released.id,
      changeType: 'modified',
    })
    const branchFile = await addModelFile(workingCopy.id, {
      fileName: 'bracket-eco.glb',
      branchId: ecoBranch.id,
    })

    const entries = await ModelVersionService.listForItem(released)

    const current = entries.find((e) => e.kind === 'current')
    expect(current?.itemId).toBe(released.id)
    expect(current?.file?.fileName).toBe('bracket-main.glb')

    const branchEntry = entries.find((e) => e.key === `branch:${ecoBranch.id}`)
    expect(branchEntry?.itemId).toBe(workingCopy.id)
    expect(branchEntry?.file?.id).toBe(branchFile.id)
    expect(branchEntry?.branch?.changeOrderNumber).toBe(eco.itemNumber)
  })

  it('resolves a branch upload that hangs off the base row (uploaded before the working copy existed)', async () => {
    const released = await addItemRow({
      revision: 'A',
      state: 'Released',
      isCurrent: true,
    })
    await addModelFile(released.id, { fileName: 'bracket-main.glb' })

    // Checkout without any metadata save: branch still points at the shared
    // released row, and the upload landed on that row, branch-scoped.
    const branch = await addBranch({
      name: `eco/ECO-${uniquePrefix}-pre`,
      branchType: 'eco',
    })
    await testDb.db.insert(branchItems).values({
      branchId: branch.id,
      itemMasterId: released.masterId,
      currentItemId: released.id,
      baseItemId: released.id,
      changeType: 'modified',
    })
    const preSaveUpload = await addModelFile(released.id, {
      fileName: 'bracket-eco2.glb',
      branchId: branch.id,
    })

    const entries = await ModelVersionService.listForItem(released)

    const branchEntry = entries.find((e) => e.key === `branch:${branch.id}`)
    expect(branchEntry?.file?.id).toBe(preSaveUpload.id)

    // The branch-scoped upload must not leak into the released entry even
    // though it hangs off the released row.
    const current = entries.find((e) => e.kind === 'current')
    expect(current?.file?.fileName).toBe('bracket-main.glb')
  })

  it('falls back to the released model for a branch that has not touched geometry', async () => {
    const released = await addItemRow({
      revision: 'A',
      state: 'Released',
      isCurrent: true,
    })
    const mainFile = await addModelFile(released.id, {
      fileName: 'bracket-main.glb',
    })

    const branch = await addBranch({
      name: `workspace/${uniquePrefix}`,
      branchType: 'workspace',
    })
    const workingCopy = await addItemRow({
      masterId: released.masterId,
      revision: `-${branch.id.substring(0, 8)}`,
      state: 'Draft',
      isCurrent: false,
    })
    await testDb.db.insert(branchItems).values({
      branchId: branch.id,
      itemMasterId: released.masterId,
      currentItemId: workingCopy.id,
      baseItemId: released.id,
      changeType: 'modified',
    })

    const entries = await ModelVersionService.listForItem(released)
    const branchEntry = entries.find((e) => e.key === `branch:${branch.id}`)
    expect(branchEntry?.file?.id).toBe(mainFile.id)
  })

  it('pins historical entries to their own row and reports no model for a metadata-only revision', async () => {
    const masterId = crypto.randomUUID()
    const revA = await addItemRow({
      masterId,
      revision: 'A',
      state: 'Superseded',
      isCurrent: false,
      modifiedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const oldFile = await addModelFile(revA.id, { fileName: 'bracket-a.glb' })

    // Rev B changed metadata only — no files of its own
    const revB = await addItemRow({
      masterId,
      revision: 'B',
      state: 'Superseded',
      isCurrent: false,
      modifiedAt: new Date('2026-02-01T00:00:00Z'),
    })

    const revC = await addItemRow({
      masterId,
      revision: 'C',
      state: 'Released',
      isCurrent: true,
      modifiedAt: new Date('2026-03-01T00:00:00Z'),
    })
    const newFile = await addModelFile(revC.id, { fileName: 'bracket-c.glb' })

    const entries = await ModelVersionService.listForItem(revC)

    expect(entries.at(0)?.kind).toBe('current')
    expect(entries.at(0)?.file?.id).toBe(newFile.id)

    const histB = entries.find((e) => e.key === `historical:${revB.id}`)
    expect(histB).toBeDefined()
    expect(histB?.file).toBeNull()

    const histA = entries.find((e) => e.key === `historical:${revA.id}`)
    expect(histA?.file?.id).toBe(oldFile.id)

    // Newest historical revision first
    const historicalKeys = entries
      .filter((e) => e.kind === 'historical')
      .map((e) => e.key)
    expect(historicalKeys).toEqual([
      `historical:${revB.id}`,
      `historical:${revA.id}`,
    ])
  })

  it('excludes archived branches and branch-deleted items', async () => {
    const released = await addItemRow({
      revision: 'A',
      state: 'Released',
      isCurrent: true,
    })
    await addModelFile(released.id, { fileName: 'bracket-main.glb' })

    const archived = await addBranch({
      name: `eco/ECO-${uniquePrefix}-arch`,
      branchType: 'eco',
      isArchived: true,
    })
    await testDb.db.insert(branchItems).values({
      branchId: archived.id,
      itemMasterId: released.masterId,
      currentItemId: released.id,
      baseItemId: released.id,
      changeType: 'modified',
    })

    const deleting = await addBranch({
      name: `eco/ECO-${uniquePrefix}-del`,
      branchType: 'eco',
    })
    await testDb.db.insert(branchItems).values({
      branchId: deleting.id,
      itemMasterId: released.masterId,
      currentItemId: released.id,
      baseItemId: released.id,
      changeType: 'deleted',
    })

    const entries = await ModelVersionService.listForItem(released)
    expect(entries.some((e) => e.branch?.id === archived.id)).toBe(false)
    expect(entries.some((e) => e.branch?.id === deleting.id)).toBe(false)
  })

  it('prefers GLB-with-colors, then the primary model, over newer uploads', async () => {
    const released = await addItemRow({
      revision: 'A',
      state: 'Released',
      isCurrent: true,
    })
    const colored = await addModelFile(released.id, {
      fileName: 'bracket-colored.glb',
      hasColors: true,
      uploadedAt: new Date('2026-01-01T00:00:00Z'),
    })
    await addModelFile(released.id, {
      fileName: 'bracket-newer.stl',
      uploadedAt: new Date('2026-02-01T00:00:00Z'),
    })

    let entries = await ModelVersionService.listForItem(released)
    expect(entries.at(0)?.file?.id).toBe(colored.id)

    // Without a colored GLB, the primary designation wins over recency
    const second = await addItemRow({
      itemNumber: `PN-${uniquePrefix}-2`,
      revision: 'A',
      state: 'Released',
      isCurrent: true,
    })
    const primary = await addModelFile(second.id, {
      fileName: 'bracket-primary.stl',
      isPrimaryModel: true,
      uploadedAt: new Date('2026-01-01T00:00:00Z'),
    })
    await addModelFile(second.id, {
      fileName: 'bracket-latest.stl',
      uploadedAt: new Date('2026-02-01T00:00:00Z'),
    })

    entries = await ModelVersionService.listForItem(second)
    expect(entries.at(0)?.file?.id).toBe(primary.id)
  })
})
