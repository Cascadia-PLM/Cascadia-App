// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Unknown body fields on the generic item routes — data integrity tests
 *
 * `POST /items` and `PUT /items/:id` validate against the item type's own
 * schema, resolved per request, so they do not get the `apiHandler` body
 * check for free. A field those schemas do not declare used to be stripped:
 * the write succeeded and the field silently did not happen. The invariants:
 *
 *  - an unknown field is a 400 naming it, and nothing is written
 *  - a whole-object read echoed back to PUT still saves (the columns a read
 *    returns are accepted and ignored), on the generic and the type route
 *
 * Run: npx vitest run cascadia-api/src/server/routes/items.unknown-fields.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import itemsRoutes from './items'
import partsRoutes from './parts'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/items/services/ItemService'
import { DesignService } from '@/services/DesignService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { items, programMembers, programs } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

import '@/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string; fieldErrors?: Array<{ field: string }> }
}

const testDb = new TestDatabase()
const app = new Hono()
  .route('/api/v1/items', itemsRoutes)
  .route('/api/v1/parts', partsRoutes)

let admin: TestUser
let cookie: string
let designId: string

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

  const program = takeFirst(
    await testDb.db
      .insert(programs)
      .values({
        name: 'Unknown Fields Program',
        code: `PROG-UF-${Date.now()}`,
        createdBy: admin.id,
      })
      .returning(),
  )
  await testDb.db.insert(programMembers).values({
    programId: program.id,
    userId: admin.id,
    role: 'engineer',
  })
  // Unreleased, so main is still writable and no branch is needed.
  designId = (
    await DesignService.create(
      {
        programId: program.id,
        name: 'Unknown Fields Design',
        code: `DESIGN-UF-${Date.now()}`,
        designType: 'Engineering',
      },
      admin.id,
    )
  ).id

  cookie = `session=${(await SessionManager.createSession(admin.id)).sessionToken}`
})

afterEach(async () => {
  await testDb.rollback()
})

function request(path: string, method: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  })
}

/** A part on main named 'Before', typed with the id every created row has. */
function createPart(): Promise<{ id: string }> {
  return ItemService.create(
    'Part',
    { itemNumber: `PN-UF-${Date.now()}`, name: 'Before', designId } as never,
    admin.id,
  )
}

async function rejectedFields(res: Response): Promise<Array<string>> {
  expect(res.status).toBe(400)
  const payload = (await res.json()) as ErrorEnvelope
  return (payload.error.fieldErrors ?? []).map((e) => e.field)
}

it('POST /items rejects an unknown field and creates nothing', async () => {
  const itemNumber = `PN-UF-${Date.now()}`
  const res = await request('/api/v1/items', 'POST', {
    itemType: 'Part',
    itemNumber,
    name: 'Typo part',
    designId,
    descripton: 'misspelled',
  })

  expect(await rejectedFields(res)).toEqual(['descripton'])
  const rows = await testDb.db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.itemNumber, itemNumber), eq(items.designId, designId)))
  expect(rows).toHaveLength(0)
})

it('PUT /items/:id rejects an unknown field and changes nothing', async () => {
  const part = await createPart()

  const res = await request(`/api/v1/items/${part.id}`, 'PUT', {
    name: 'After',
    descripton: 'misspelled',
  })

  expect(await rejectedFields(res)).toEqual(['descripton'])
  const after = await ItemService.findById(part.id)
  expect(after?.name).toBe('Before')
})

it.each([
  ['/api/v1/items', 'PUT /items/:id'],
  ['/api/v1/parts', 'PUT /parts/:id'],
])(
  '%s: still saves the whole read echoed back, as the detail pages do',
  async (base) => {
    const part = await createPart()
    // Exactly what a page holds: the read as JSON, every column of both rows
    // plus the computed `usageCount`, with one field edited.
    const read = JSON.parse(
      JSON.stringify(await ItemService.findById(part.id)),
    ) as Record<string, unknown>

    const res = await request(`${base}/${part.id}`, 'PUT', {
      ...read,
      usageCount: 0,
      name: 'After',
    })

    expect(res.status).toBe(200)
    expect((await ItemService.findById(part.id))?.name).toBe('After')
  },
)

it('PUT /parts/:id rejects a field no read could have returned', async () => {
  const part = await createPart()

  const res = await request(`/api/v1/parts/${part.id}`, 'PUT', {
    name: 'After',
    materail: 'typo',
  })

  expect(await rejectedFields(res)).toEqual(['materail'])
  expect((await ItemService.findById(part.id))?.name).toBe('Before')
})
