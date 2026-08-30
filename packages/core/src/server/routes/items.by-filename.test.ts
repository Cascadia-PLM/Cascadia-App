// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * GET /items/by-filename/:filename — program isolation
 *
 * Security gate. The route was auth-only and unscoped: a filename was enough
 * to read full item rows, and their file records, from every program in the
 * instance. Two suppliers who both upload `housing.step` could each read the
 * other's part row.
 *
 * Invariants: results are bounded by the caller's accessible designs and by
 * the types their RBAC lets them read; the counts describe the filtered set,
 * not the whole one; the exact match never points at a withheld row; and a
 * search that matches only withheld rows is answered exactly like a search
 * that matches nothing, so existence itself does not leak.
 *
 * Run: npx vitest run packages/core/src/server/routes/items.by-filename.test.ts
 */

import { randomUUID } from 'node:crypto'
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
import { Hono } from 'hono'
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { Document } from '@/lib/items/types/document'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
  insertTestUserWithRole,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { items, vaultFiles } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

const FILENAME = 'housing.step'

interface ByFilenameResponse {
  data: {
    items: Array<{ id: string; itemType: string }>
    exactMatch: { id: string } | null
    totalMatches?: number
    matchingFiles?: Array<{ itemId: string }>
    message?: string
  }
}

describe('GET /items/by-filename — program isolation', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)

  let memberA: TestUser
  let crossProgram: TestUser
  let programA: string
  let designB: string
  let partA: string
  let partB: string
  let documentA: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  async function attachFile(itemId: string, name: string) {
    await testDb.db.insert(vaultFiles).values({
      itemId,
      fileName: name,
      originalFileName: name,
      fileSize: 2048,
      mimeType: 'application/step',
      fileHash: randomUUID().replace(/-/g, ''),
      storagePath: `vault/${randomUUID()}/${name}`,
      fileCategory: 'cad_model',
      uploadedBy: memberA.id,
    })
  }

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    memberA = (await insertTestUserWithRole(testDb.db, 'User')).user
    // Administrator carries programs:manage, which is the cross-program
    // bypass — the scope this route must still hand everything to.
    crossProgram = (await insertTestUserWithRole(testDb.db, 'Administrator'))
      .user

    const designs: Array<string> = []
    for (const suffix of ['A', 'B']) {
      const owner = suffix === 'A' ? memberA : crossProgram
      const program = await ProgramService.create(
        {
          name: `Filename Program ${suffix}`,
          code: `FP${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        },
        owner.id,
      )
      const design = await DesignService.create(
        {
          programId: program.id,
          name: `Filename Design ${suffix}`,
          code: `FD${suffix}-${Date.now()}`,
          designType: 'Engineering',
        },
        owner.id,
      )
      designs.push(design.id)
      if (suffix === 'A') programA = program.id
    }
    const [designA, designBId] = designs as [string, string]
    designB = designBId

    // The generic argument is what types the type-specific fields: create()
    // is generic over BaseItem, and partType lives on Part.
    partA = (
      await ItemService.create<Part>(
        'Part',
        {
          itemType: 'Part',
          designId: designA,
          revision: 'A',
          name: 'Housing A',
          partType: 'Manufacture',
        },
        memberA.id,
      )
    ).id!
    partB = (
      await ItemService.create<Part>(
        'Part',
        {
          itemType: 'Part',
          designId: designBId,
          revision: 'A',
          name: 'Housing B',
          partType: 'Manufacture',
        },
        crossProgram.id,
      )
    ).id!
    documentA = (
      await ItemService.create<Document>(
        'Document',
        {
          itemType: 'Document',
          designId: designA,
          revision: 'A',
          name: 'Housing Drawing',
        },
        memberA.id,
      )
    ).id!

    // The same filename in both programs, plus one on a type the caller may
    // or may not be allowed to read.
    await attachFile(partA, FILENAME)
    await attachFile(partB, FILENAME)
    await attachFile(documentA, FILENAME)

    cookies.clear()
    for (const u of [memberA, crossProgram]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function searchFor(
    user: TestUser,
    filename: string,
  ): Promise<ByFilenameResponse['data']> {
    const response = await app.request(
      `/api/v1/items/by-filename/${encodeURIComponent(filename)}`,
      { headers: { Cookie: cookies.get(user.id)! } },
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as ByFilenameResponse).data
  }

  async function search(user: TestUser): Promise<ByFilenameResponse['data']> {
    return searchFor(user, FILENAME)
  }

  it('returns only rows from the programs the caller reaches', async () => {
    const result = await search(memberA)

    const ids = result.items.map((i) => i.id)
    expect(ids).toContain(partA)
    expect(ids).toContain(documentA)
    expect(ids).not.toContain(partB)

    // The count and the file list are filtered too: three files match the
    // name, and a total of 3 would size the program the caller cannot open.
    expect(result.totalMatches).toBe(2)
    expect(result.matchingFiles?.map((f) => f.itemId)).not.toContain(partB)
    expect(result.exactMatch?.id).not.toBe(partB)
  })

  it('hands everything to cross-program authority', async () => {
    const result = await search(crossProgram)

    const ids = result.items.map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining([partA, partB, documentA]))
    expect(result.totalMatches).toBe(3)
  })

  it('drops rows of a type the caller cannot read', async () => {
    // A member of the same program whose role reads parts and nothing else.
    // The design check would admit the document; RBAC is what withholds it.
    const partsOnly = await insertTestUser(testDb.db)
    // Unique name: `roles` is a shared table and suites run in parallel, so a
    // fixed name is a collision waiting for the day another suite wants one.
    const role = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Parts Only ${randomUUID().slice(0, 8)}`, {
        parts: ['read'],
      }),
    )
    await assignRoleToUser(testDb.db, partsOnly.id, role.id)
    await ProgramService.addMember(
      programA,
      partsOnly.id,
      'engineer',
      memberA.id,
    )
    permissionService.clearCache()

    const { sessionToken } = await SessionManager.createSession(partsOnly.id)
    cookies.set(partsOnly.id, `session=${sessionToken}`)

    const result = await search(partsOnly)

    const ids = result.items.map((i) => i.id)
    expect(ids).toContain(partA)
    expect(ids).not.toContain(documentA)
    expect(result.totalMatches).toBe(1)
  })

  it('answers a search it may not see like a search that found nothing', async () => {
    const outsider = (await insertTestUserWithRole(testDb.db, 'User')).user
    const { sessionToken } = await SessionManager.createSession(outsider.id)
    cookies.set(outsider.id, `session=${sessionToken}`)

    const result = await search(outsider)

    expect(result.items).toEqual([])
    expect(result.exactMatch).toBeNull()
    // Same body as a filename that matches nothing at all: no count, no file
    // list, nothing that says these files exist.
    expect(result.message).toBe('No items found with matching filename')
    expect(result.totalMatches).toBeUndefined()
    expect(result.matchingFiles).toBeUndefined()
  })

  // The two `like()` operands take the caller's raw path segment. `_` and `%`
  // are SQL wildcards, so `A_1` matched `AB1`, and a lone `%` matched every
  // vault row in the instance before the access filter had a chance to trim
  // it — a full scan any authenticated caller could ask for.
  it('treats a wildcard character in the filename as a literal', async () => {
    await attachFile(partA, 'A_1.step')
    await attachFile(documentA, 'AB1.step')

    const result = await searchFor(memberA, 'A_1')

    expect(result.matchingFiles?.map((f) => f.itemId)).toEqual([partA])
    expect(result.items.map((i) => i.id)).toEqual([partA])
  })

  it('does not let a bare percent return every file', async () => {
    const result = await searchFor(memberA, '%')

    expect(result.items).toEqual([])
    expect(result.exactMatch).toBeNull()
    expect(result.totalMatches).toBeUndefined()
  })

  // Scoping this route used to be an in-memory filter over already-fetched
  // rows, and it admitted anything with `designId === null`. Every ECO the
  // application creates has exactly that shape — its designs hang off
  // `change_order_designs` — so an ECO with an attached file was reachable by
  // filename from any program. The shared predicate scopes it through the
  // link table instead.
  it('does not hand over an ECO just because it has no design of its own', async () => {
    const eco = await ChangeOrderService.create(
      {
        revision: 'A',
        changeType: 'ECO',
        name: 'Housing rework',
        description: 'by-filename isolation',
      },
      [designB],
      crossProgram.id,
    )
    await attachFile(eco.id!, FILENAME)

    expect((await search(memberA)).items.map((i) => i.id)).not.toContain(eco.id)
    expect((await search(crossProgram)).items.map((i) => i.id)).toContain(
      eco.id,
    )
  })

  // Aligns the route with its sibling read `GET /items/:id`, which goes
  // through `ItemService.findById` and so never answers for a deleted row.
  it('does not answer a filename search with a soft-deleted item', async () => {
    await testDb.db
      .update(items)
      .set({ isDeleted: true })
      .where(eq(items.id, partA))

    expect((await search(memberA)).items.map((i) => i.id)).not.toContain(partA)
  })
})
