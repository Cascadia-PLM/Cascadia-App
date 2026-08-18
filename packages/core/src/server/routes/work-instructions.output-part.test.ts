// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Work instruction output part — data integrity tests
 *
 * A work instruction has no design of its own: it borrows the one its output
 * part lives in. That makes `items.designId` and the attachment row flagged
 * `isOutput` two halves of a single fact, and every operation that touches
 * either has to keep them agreeing. These tests pin the invariants:
 *
 *  - creating a WI with an output part sets designId from that part and writes
 *    exactly one output attachment
 *  - a create that cannot resolve an output part writes nothing at all — no
 *    orphan work instruction sitting in no design
 *  - re-pointing the output part moves the design with it, and never leaves
 *    two output attachments behind
 *  - the output attachment cannot be detached, which would strand the WI in a
 *    design nothing justifies
 *  - a WI is editable on a protected main, where an ECO-controlled type is not
 *
 * Run: npx vitest run packages/core/src/server/routes/work-instructions.output-part.test.ts
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
import { and, eq } from 'drizzle-orm'
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
  items,
  programMembers,
  programs,
  workInstructionPartAttachments,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

import '@/lib/items/registerItemTypes.server'

describe('work instruction output part', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/items', itemsRoutes)
    .route('/api/v1/work-instructions', workInstructionRoutes)

  let admin: TestUser
  let cookie: string
  let designId: string
  let otherDesignId: string

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
          name: 'WI Output Program',
          code: `PROG-WI-${Date.now()}`,
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
        name: 'WI Output Design',
        code: `DESIGN-WI-${Date.now()}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    designId = design.id

    const other = await DesignService.create(
      {
        programId: program.id,
        name: 'WI Output Design 2',
        code: `DESIGN-WI2-${Date.now()}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    otherDesignId = other.id

    cookie = `session=${(await SessionManager.createSession(admin.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(
    name: string,
    inDesign = designId,
  ): Promise<{ id: string }> {
    return ItemService.create(
      'Part',
      {
        designId: inDesign,
        revision: 'A',
        name,
        partType: 'Manufacture',
      } as never,
      admin.id,
    )
  }

  function request(path: string, method: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  function createWorkInstruction(outputPartId?: string) {
    return request('/api/v1/items', 'POST', {
      itemType: 'WorkInstruction',
      revision: 'A',
      name: 'Assemble the thing',
      outputPartId,
    })
  }

  /** Create a work instruction and return the created item, asserting success. */
  async function createdWorkInstruction(
    outputPartId: string,
  ): Promise<{ id: string; designId: string | null }> {
    const res = await createWorkInstruction(outputPartId)
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      data: { item: { id: string; designId: string | null } }
    }
    return body.data.item
  }

  function outputAttachments(workInstructionId: string) {
    return testDb.db
      .select()
      .from(workInstructionPartAttachments)
      .where(
        and(
          eq(
            workInstructionPartAttachments.workInstructionId,
            workInstructionId,
          ),
          eq(workInstructionPartAttachments.isOutput, true),
        ),
      )
  }

  it('takes its design from the output part and records exactly one output attachment', async () => {
    const part = await createPart('Motor Housing')

    const wi = await createdWorkInstruction(part.id)

    expect(wi.designId).toBe(designId)

    const outputs = await outputAttachments(wi.id)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.partId).toBe(part.id)
  })

  it('writes nothing when the output part is missing or not a part', async () => {
    const before = await testDb.db
      .select()
      .from(items)
      .where(eq(items.itemType, 'WorkInstruction'))

    expect((await createWorkInstruction(undefined)).status).toBe(400)
    expect((await createWorkInstruction(crypto.randomUUID())).status).toBe(404)

    const after = await testDb.db
      .select()
      .from(items)
      .where(eq(items.itemType, 'WorkInstruction'))
    expect(after).toHaveLength(before.length)
  })

  it('refuses a service-level create with no output part', async () => {
    // The invariant lives in the registered type schema, not only in the HTTP
    // route, so a programmatic caller cannot mint a design-less work
    // instruction either.
    await expect(
      ItemService.create(
        'WorkInstruction',
        { revision: 'A', name: 'Orphan' } as never,
        admin.id,
      ),
    ).rejects.toThrow()
  })

  it('moves the design when the output part is re-pointed, leaving one output', async () => {
    const original = await createPart('Original Output')
    const replacement = await createPart('Replacement Output', otherDesignId)

    const wi = await createdWorkInstruction(original.id)

    // The replacement has to be attached before it can become the output.
    const attach = await request(
      `/api/v1/work-instructions/${wi.id}/parts`,
      'POST',
      { partId: replacement.id },
    )
    expect(attach.status).toBe(201)

    const promote = await request(
      `/api/v1/work-instructions/${wi.id}/parts`,
      'PATCH',
      { partId: replacement.id, isOutput: true },
    )
    expect(promote.status).toBe(200)

    const outputs = await outputAttachments(wi.id)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.partId).toBe(replacement.id)

    const after = await ItemService.findById(wi.id)
    expect(after?.designId).toBe(otherDesignId)
  })

  it('refuses to detach the output part', async () => {
    const part = await createPart('Load Bearing')
    const wi = await createdWorkInstruction(part.id)

    const res = await request(
      `/api/v1/work-instructions/${wi.id}/parts?partId=${part.id}`,
      'DELETE',
    )

    expect(res.status).toBe(400)
    expect(await outputAttachments(wi.id)).toHaveLength(1)
    expect((await ItemService.findById(wi.id))?.designId).toBe(designId)
  })

  it('stays editable once the design is protected, unlike an ECO-controlled type', async () => {
    const part = await createPart('Released Part')
    const wi = await createdWorkInstruction(part.id)

    // Releasing an item is what protects main.
    await testDb.db
      .update(items)
      .set({ state: 'Released' })
      .where(eq(items.id, part.id))

    // A part cannot be created directly on a protected main...
    await expect(createPart('Too Late')).rejects.toThrow()

    // ...but the work instruction is still editable, because its content is
    // not ECO-controlled. This is the case that used to surface as
    // "cannot be edited in this context".
    const step = await request(
      `/api/v1/work-instructions/${wi.id}/steps`,
      'POST',
      { title: 'Torque to 25 ft-lbs' },
    )
    expect(step.status).toBe(201)
  })
})
