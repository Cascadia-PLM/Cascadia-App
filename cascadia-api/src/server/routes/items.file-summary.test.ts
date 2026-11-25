// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `GET /items?includeFileSummary=true` — branch isolation
 *
 * Data-integrity gate: a client reads `fileSummary` to decide what an item
 * still lacks (the CAD connector asks "is there a PDF yet?"), so a file
 * counted in a context that cannot see it is a wrong answer acted on.
 *
 * Vault files are branch-scoped. One uploaded on an open change-order branch
 * can hang off the very row main lists — an unreleased item checked out to
 * the branch is still main's row there until its first save, so the upload
 * lands on that row, tagged with the branch. Counting by item id alone put
 * the file on main.
 *
 * The invariants:
 *
 *  - a file that exists only on a change-order branch is not counted on main,
 *    and is counted on that branch
 *  - in either context the summary counts exactly what
 *    `GET /items/:id/files` lists there — including what the listing leaves
 *    out (generated thumbnails, deleted files)
 *  - the list path with no design (`programId`) counts each item on its own
 *    design's main, like the design-scoped path does
 *
 * Run: npx vitest run cascadia-api/src/server/routes/items.file-summary.test.ts
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
import { Hono } from 'hono'
import itemsRoutes from './items'
import type { ItemFileSummary } from '@/vault/services/FileService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/items/services/ItemService'
import { BranchService } from '@/services/BranchService'
import { DesignService } from '@/services/DesignService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { programMembers, programs, vaultFiles } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

import '@/items/registerItemTypes.server'

interface ListResponse {
  data: { fileSummary?: Record<string, ItemFileSummary> }
}

interface FilesResponse {
  data: { count: number }
}

describe('GET /items?includeFileSummary=true', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)

  let admin: TestUser
  let cookie: string
  let programId: string
  let designId: string
  let mainBranchId: string
  let changeOrderBranch: { id: string; name: string }
  let partId: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'File Summary Program',
          code: `PROG-FS-${unique}`,
          createdBy: admin.id,
        })
        .returning(),
    )
    programId = program.id
    await testDb.db.insert(programMembers).values({
      programId,
      userId: admin.id,
      role: 'engineer',
    })

    const design = await DesignService.create(
      {
        programId,
        name: 'File Summary Design',
        code: `DESIGN-FS-${unique}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    designId = design.id
    mainBranchId = design.defaultBranchId!

    const part: { id: string } = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-FS-${unique}`,
        name: 'Bracket',
        designId,
        partType: 'Manufacture',
      } as never,
      admin.id,
    )
    partId = part.id

    const changeOrder: { id: string } = await ItemService.create(
      'ChangeOrder',
      {
        name: 'Add the bracket drawing',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'File summary test',
        designId,
      } as never,
      admin.id,
    )
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      changeOrder.id,
      admin.id,
    )
    changeOrderBranch = { id: branch.id, name: branch.name }

    // Every file hangs off the row main lists — the case the summary used to
    // get wrong. Only `branchId` says where each one is visible.
    await addFile('bracket.step', 'cad_model', null) // everywhere
    await addFile('bracket-dwg.pdf', 'drawing', mainBranchId) // main + branches
    await addFile('bracket-dwg-rev.PDF', 'drawing', changeOrderBranch.id) // the ECO only
    await addFile('bracket.png', 'thumbnail', null) // generated: never listed
    await addFile('superseded.pdf', 'reference', mainBranchId, new Date()) // deleted

    cookie = `session=${(await SessionManager.createSession(admin.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** A vault row, inserted directly: the read under test never opens storage. */
  async function addFile(
    name: string,
    fileCategory: string,
    branchId: string | null,
    deletedAt: Date | null = null,
  ) {
    await testDb.db.insert(vaultFiles).values({
      itemId: partId,
      branchId,
      fileName: name,
      originalFileName: name,
      fileSize: 1024,
      mimeType: 'application/octet-stream',
      fileHash: `hash-${name}`,
      storageType: 'local',
      storagePath: `test/${name}`,
      fileVersion: 1,
      isLatestVersion: true,
      isCheckedOut: false,
      uploadedBy: admin.id,
      fileCategory,
      categorySource: 'auto',
      deletedAt,
    })
  }

  async function get<T>(path: string): Promise<T> {
    const res = await app.request(path, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }

  async function summaryOf(query: string): Promise<ItemFileSummary> {
    const { data } = await get<ListResponse>(
      `/api/v1/items?${query}&includeFileSummary=true`,
    )
    const summary = data.fileSummary?.[partId]
    expect(summary).toBeDefined()
    return summary!
  }

  async function listedCount(query: string): Promise<number> {
    const { data } = await get<FilesResponse>(
      `/api/v1/items/${partId}/files?${query}`,
    )
    return data.count
  }

  it('does not count a change-order branch’s file on main', async () => {
    const summary = await summaryOf(`designId=${designId}`)

    expect(summary.byExtension.pdf).toBe(1)
    expect(summary.byCategory.drawing).toBe(1)
    expect(summary.total).toBe(
      await listedCount(`mainBranchId=${mainBranchId}`),
    )
  })

  it('counts that file on its own branch', async () => {
    const summary = await summaryOf(
      `designId=${designId}&branch=${encodeURIComponent(changeOrderBranch.name)}`,
    )

    expect(summary.byExtension.pdf).toBe(2)
    expect(summary.byCategory.drawing).toBe(2)
    expect(summary.total).toBe(
      await listedCount(
        `branchId=${changeOrderBranch.id}&mainBranchId=${mainBranchId}`,
      ),
    )
  })

  it('counts on the item’s own main when the list names no design', async () => {
    const unscoped = await summaryOf(`programId=${programId}&itemType=Part`)

    expect(unscoped.byExtension.pdf).toBe(1)
    expect(unscoped).toEqual(await summaryOf(`designId=${designId}`))
  })
})
