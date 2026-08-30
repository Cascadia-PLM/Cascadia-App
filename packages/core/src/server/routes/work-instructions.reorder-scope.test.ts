// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Work instruction operations reorder — access boundary and ordering
 *
 * `PUT /api/v1/work-instructions/:id/operations` takes a caller-supplied list
 * of row ids. The handler checks access on `:id` and nothing else, so the
 * UPDATE it issues has to be scoped to that work instruction itself — a body
 * naming another work instruction's operation ids must not renumber them.
 *
 * Two invariants, both stated as facts about the persisted rows:
 *
 *  - operations belonging to a work instruction other than the one in the path
 *    keep their orderIndex, whatever ids the body names
 *  - a legitimate reorder lands every submitted orderIndex and reads back in
 *    ascending order
 *
 * Run: npx vitest run packages/core/src/server/routes/work-instructions.reorder-scope.test.ts
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
import { asc, eq } from 'drizzle-orm'
import itemsRoutes from './items'
import workInstructionRoutes from './work-instructions'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import {
  programMembers,
  programs,
  workInstructionOperations,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

import '@/lib/items/registerItemTypes.server'

describe('work instruction operations reorder', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/items', itemsRoutes)
    .route('/api/v1/work-instructions', workInstructionRoutes)

  let admin: TestUser
  let cookie: string
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'WI Reorder Program',
          code: `PROG-WIR-${Date.now()}`,
          createdBy: admin.id,
        })
        .returning(),
    )
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: admin.id,
      role: 'engineer',
    })

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'WI Reorder Design',
        code: `DESIGN-WIR-${Date.now()}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    designId = design.id

    cookie = `session=${(await SessionManager.createSession(admin.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function request(path: string, method: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  function createPart(name: string): Promise<{ id: string }> {
    return ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name,
        partType: 'Manufacture',
      } as never,
      admin.id,
    )
  }

  /** A work instruction with `titles.length` operations, indexed 0..n-1. */
  async function createWorkInstruction(
    name: string,
    titles: Array<string>,
  ): Promise<{ id: string }> {
    const part = await createPart(`${name} Output`)

    const res = await request('/api/v1/items', 'POST', {
      itemType: 'WorkInstruction',
      revision: 'A',
      name,
      outputPartId: part.id,
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { data: { item: { id: string } } }
    const wiId = created.data.item.id

    for (const title of titles) {
      const opRes = await request(
        `/api/v1/work-instructions/${wiId}/operations`,
        'POST',
        { title },
      )
      expect(opRes.status).toBe(201)
    }

    return { id: wiId }
  }

  /** The persisted (id, orderIndex) pairs for a work instruction, in order. */
  function persistedOperations(workInstructionId: string) {
    return testDb.db
      .select({
        id: workInstructionOperations.id,
        orderIndex: workInstructionOperations.orderIndex,
      })
      .from(workInstructionOperations)
      .where(eq(workInstructionOperations.workInstructionId, workInstructionId))
      .orderBy(asc(workInstructionOperations.orderIndex))
  }

  it('leaves operations belonging to another work instruction untouched', async () => {
    const a = await createWorkInstruction('WI A', ['A1', 'A2'])
    const b = await createWorkInstruction('WI B', ['B1', 'B2'])

    const bBefore = await persistedOperations(b.id)
    expect(bBefore.map((op) => op.orderIndex)).toEqual([0, 1])

    // Authorized on A, but naming B's rows with swapped indexes.
    const res = await request(
      `/api/v1/work-instructions/${a.id}/operations`,
      'PUT',
      {
        operations: [
          { id: bBefore[0]?.id, orderIndex: 1 },
          { id: bBefore[1]?.id, orderIndex: 0 },
        ],
      },
    )
    expect(res.status).toBe(200)

    // B is unchanged: same rows, same indexes, in the same order.
    const bAfter = await persistedOperations(b.id)
    expect(bAfter).toEqual(bBefore)

    // ...and A, whose rows were never named, is unchanged too.
    expect(
      (await persistedOperations(a.id)).map((op) => op.orderIndex),
    ).toEqual([0, 1])
  })

  it('applies every submitted index to its own operations', async () => {
    const a = await createWorkInstruction('WI A', ['A1', 'A2', 'A3'])

    const before = await persistedOperations(a.id)
    const [first, second, third] = before
    expect(third).toBeDefined()

    const res = await request(
      `/api/v1/work-instructions/${a.id}/operations`,
      'PUT',
      {
        operations: [
          { id: first?.id, orderIndex: 2 },
          { id: second?.id, orderIndex: 0 },
          { id: third?.id, orderIndex: 1 },
        ],
      },
    )
    expect(res.status).toBe(200)

    const expected = [second?.id, third?.id, first?.id]

    // Every submitted index landed.
    const after = await persistedOperations(a.id)
    expect(after.map((op) => op.id)).toEqual(expected)
    expect(after.map((op) => op.orderIndex)).toEqual([0, 1, 2])

    // ...and the response reports the same order the rows now hold.
    const body = (await res.json()) as {
      data: { operations: Array<{ id: string; orderIndex: number }> }
    }
    expect(body.data.operations.map((op) => op.id)).toEqual(expected)
  })
})
