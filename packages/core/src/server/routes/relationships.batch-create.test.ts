// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Batch relationship creation — data-integrity gate
 *
 * `replaceExisting` deletes a parent's structure and rebuilds it. When the two
 * halves were not one unit, a batch that repeated a child deleted the old BOM
 * and then failed to insert the new one, leaving the parent with no structure
 * at all — and reported the collision against the first line of the batch,
 * whichever line actually collided. Invariants:
 *
 *   - a rejected batch leaves the stored structure exactly as it was
 *   - a duplicated edge is named by its own index in the request
 *   - no rejection carries the driver's query text
 *   - a valid replacement still replaces, and stored edges are still skipped
 *
 * Run: npx vitest run src/server/routes/relationships.batch-create.test.ts
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
import { eq } from 'drizzle-orm'
import relationshipsRoutes from './relationships'
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { UsageService } from '@/lib/services/UsageService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { itemRelationships, programMembers, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface BatchBody {
  created: number
  skipped: number
  errors: Array<{ error: string }>
}

interface ErrorBody {
  error: {
    code: string
    message: string
    fieldErrors?: Array<{ field: string; message: string; code?: string }>
  }
}

describe('relationships batch-create', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/relationships', relationshipsRoutes)
    .route('/api/v1/items', itemsRoutes)

  let engineer: TestUser
  let cookie: string
  let programId: string
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // The permission cache is process-global; users are new each test.
    permissionService.clearCache()

    engineer = (await insertTestUserWithRole(testDb.db, 'Administrator')).user

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Batch Program',
          code: `BATCH-${Date.now()}`,
          createdBy: engineer.id,
        })
        .returning(),
    )
    programId = program.id
    await testDb.db.insert(programMembers).values({
      programId: program.id,
      userId: engineer.id,
      role: 'engineer',
    })

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Batch Design',
        code: `BATCHD-${Date.now()}`,
        designType: 'Engineering',
      },
      engineer.id,
    )
    designId = design.id

    cookie = `session=${(await SessionManager.createSession(engineer.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(
    name: string,
    targetDesignId = designId,
  ): Promise<{ id: string }> {
    return ItemService.create(
      'Part',
      {
        designId: targetDesignId,
        revision: 'A',
        name,
        partType: 'Manufacture',
      } as never,
      engineer.id,
    )
  }

  async function createDesign(
    designType: 'Engineering' | 'Library',
    suffix: string,
  ): Promise<string> {
    const design = await DesignService.create(
      {
        programId: designType === 'Library' ? null : programId,
        name: `${suffix} Design`,
        code: `BATCH-${suffix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        designType,
      },
      engineer.id,
    )
    return design.id
  }

  function batchCreate(body: unknown) {
    return app.request('/api/v1/relationships/batch-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
  }

  function bomLine(sourceId: string, targetId: string, findNumber: number) {
    return {
      sourceId,
      targetId,
      relationshipType: 'BOM',
      quantity: 1,
      findNumber,
    }
  }

  async function storedBom(parentId: string) {
    return testDb.db
      .select({
        targetId: itemRelationships.targetId,
        findNumber: itemRelationships.findNumber,
      })
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, parentId))
  }

  it('rejects a repeated child and leaves the existing BOM standing', async () => {
    const parent = await createPart('Assembly')
    const bracket = await createPart('Bracket')
    const screw = await createPart('M4 Screw')

    // The structure that must survive a rejected rebuild.
    const seeded = await batchCreate({
      replaceExisting: true,
      relationships: [
        bomLine(parent.id, bracket.id, 10),
        bomLine(parent.id, screw.id, 20),
      ],
    })
    expect(seeded.status).toBe(201)
    expect(await storedBom(parent.id)).toHaveLength(2)

    // "4 screws here, 12 screws there" — two lines, one edge.
    const response = await batchCreate({
      replaceExisting: true,
      relationships: [
        bomLine(parent.id, bracket.id, 10),
        bomLine(parent.id, screw.id, 100),
        bomLine(parent.id, screw.id, 120),
      ],
    })

    expect(response.status).toBe(400)

    // The parent still has the BOM it had before the rejected request.
    const after = await storedBom(parent.id)
    expect(after).toHaveLength(2)
    expect(after.map((line) => line.findNumber).sort()).toEqual([10, 20])
  })

  it('blames the duplicated line, not the first line of the batch', async () => {
    const parent = await createPart('Assembly')
    const bracket = await createPart('Bracket')
    const screw = await createPart('M4 Screw')

    const response = await batchCreate({
      relationships: [
        bomLine(parent.id, bracket.id, 10),
        bomLine(parent.id, screw.id, 100),
        bomLine(parent.id, screw.id, 120),
      ],
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as ErrorBody
    expect(body.error.code).toBe('VALIDATION_FAILED')

    const fieldErrors = body.error.fieldErrors ?? []
    expect(fieldErrors).toHaveLength(1)
    expect(fieldErrors[0]?.field).toBe('relationships[2]')
    expect(fieldErrors[0]?.code).toBe('DUPLICATE_RELATIONSHIP')
    // …and points at the line it collides with, which is not line 0.
    expect(fieldErrors[0]?.message).toContain('relationships[1]')

    // Nothing was written.
    expect(await storedBom(parent.id)).toHaveLength(0)
  })

  it('keeps the driver query text out of the response', async () => {
    const parent = await createPart('Assembly')
    const screw = await createPart('M4 Screw')

    const response = await batchCreate({
      replaceExisting: true,
      relationships: [
        bomLine(parent.id, screw.id, 10),
        bomLine(parent.id, screw.id, 20),
      ],
    })

    expect(response.status).toBe(400)
    const raw = await response.text()
    expect(raw).not.toContain('Failed query')
    expect(raw).not.toContain('insert into')
    expect(raw).not.toContain('item_relationships')
  })

  it('replaces the whole structure when the batch is valid', async () => {
    const parent = await createPart('Assembly')
    const bracket = await createPart('Bracket')
    const screw = await createPart('M4 Screw')

    await batchCreate({
      relationships: [bomLine(parent.id, bracket.id, 10)],
    })

    const response = await batchCreate({
      replaceExisting: true,
      relationships: [bomLine(parent.id, screw.id, 30)],
    })

    expect(response.status).toBe(201)
    const replaced = (await response.json()) as { data: BatchBody }
    expect(replaced.data.created).toBe(1)

    const after = await storedBom(parent.id)
    expect(after).toHaveLength(1)
    expect(after[0]?.targetId).toBe(screw.id)
  })

  it('skips stored edges instead of replacing them', async () => {
    const parent = await createPart('Assembly')
    const bracket = await createPart('Bracket')
    const screw = await createPart('M4 Screw')

    await batchCreate({ relationships: [bomLine(parent.id, bracket.id, 10)] })

    const response = await batchCreate({
      relationships: [
        bomLine(parent.id, bracket.id, 99),
        bomLine(parent.id, screw.id, 20),
      ],
    })

    expect(response.status).toBe(201)
    const { data } = (await response.json()) as { data: BatchBody }
    expect(data.created).toBe(1)
    expect(data.skipped).toBe(1)

    const after = await storedBom(parent.id)
    expect(after).toHaveLength(2)
    // The stored line kept its own find number — a skip is not an update.
    expect(after.find((line) => line.targetId === bracket.id)?.findNumber).toBe(
      10,
    )
  })

  it('rejects a BOM target from another engineering design before replacing', async () => {
    const parent = await createPart('Assembly')
    const existing = await createPart('Existing child')
    const foreignDesignId = await createDesign('Engineering', 'FOREIGN')
    const foreign = await createPart('Foreign child', foreignDesignId)

    expect(
      (
        await batchCreate({
          relationships: [bomLine(parent.id, existing.id, 10)],
        })
      ).status,
    ).toBe(201)

    const response = await batchCreate({
      replaceExisting: true,
      relationships: [bomLine(parent.id, foreign.id, 20)],
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as ErrorBody
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.fieldErrors?.[0]).toMatchObject({
      field: 'relationships[0].targetId',
      code: 'BOM_TARGET_OUT_OF_SCOPE',
    })
    expect(await storedBom(parent.id)).toEqual([
      { targetId: existing.id, findNumber: 10 },
    ])
  })

  it('allows a Library part as a cross-design BOM target', async () => {
    const parent = await createPart('Assembly')
    const libraryDesignId = await createDesign('Library', 'LIBRARY')
    const libraryPart = await createPart('Library fastener', libraryDesignId)

    const response = await batchCreate({
      relationships: [bomLine(parent.id, libraryPart.id, 10)],
    })

    expect(response.status).toBe(201)
    expect(await storedBom(parent.id)).toEqual([
      { targetId: libraryPart.id, findNumber: 10 },
    ])
  })

  it('allows a pulled-in local usage without duplicating its definition', async () => {
    const parent = await createPart('Assembly')
    const foreignDesignId = await createDesign('Engineering', 'SOURCE')
    const definition = await createPart('Reusable module', foreignDesignId)
    const { usage } = await UsageService.createUsage(
      { definitionId: definition.id, targetDesignId: designId },
      engineer.id,
    )

    const response = await batchCreate({
      relationships: [bomLine(parent.id, usage.id, 10)],
    })

    expect(response.status).toBe(201)
    expect(usage.designId).toBe(designId)
    expect(usage.usageOf).toBe(definition.id)
    expect(await storedBom(parent.id)).toEqual([
      { targetId: usage.id, findNumber: 10 },
    ])
  })

  it('answers a repeated single-relationship create with a conflict, not a driver error', async () => {
    const parent = await createPart('Assembly')
    const screw = await createPart('M4 Screw')

    function addRelationship() {
      return app.request(`/api/v1/items/${parent.id}/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          targetId: screw.id,
          relationshipType: 'BOM',
          quantity: 1,
        }),
      })
    }

    expect((await addRelationship()).status).toBe(201)

    const repeat = await addRelationship()
    expect(repeat.status).toBe(409)
    const raw = await repeat.text()
    expect(raw).not.toContain('Failed query')
    expect(JSON.parse(raw).error.code).toBe('RESOURCE_ALREADY_EXISTS')

    expect(await storedBom(parent.id)).toHaveLength(1)
  })
})
