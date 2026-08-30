// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * GET /api/v1/relationships — program isolation
 *
 * Security gate. The route takes its `designId` straight from the query string
 * and answered with every edge whose source sits in that design. `parts:read`
 * was the only gate, and every authenticated user has it, so a design id was
 * enough to read another program's BOM structure — which parts a product is
 * built from, and how many of each.
 *
 * Both users hold the same role. The only difference between them is program
 * membership, so a 403 can only come from the design gate.
 *
 * Run: npx vitest run packages/core/src/server/routes/relationships.permissions.test.ts
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
import { Hono } from 'hono'
import relationshipsRoutes from './relationships'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { itemRelationships } from '@/lib/db/schema'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

interface RelationshipsEnvelope {
  data: {
    relationships: Array<{ id: string; sourceId: string; targetId: string }>
  }
}

describe('GET /api/v1/relationships — program isolation', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/relationships', relationshipsRoutes)

  let member: TestUser
  let outsider: TestUser
  let auditor: TestUser
  let memberDesignId: string
  let edgeId: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // Enough to create the fixture and read it back, and pointedly no
    // programs:manage — that is the cross-program bypass, exercised separately
    // below. Unique names because `roles` is shared and suites run in parallel.
    const engineerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Rel Engineer ${randomUUID().slice(0, 8)}`, {
        parts: ['create', 'read', 'update'],
        designs: ['create', 'read'],
      }),
    )
    const auditorRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Rel Auditor ${randomUUID().slice(0, 8)}`, {
        parts: ['read'],
        programs: ['manage'],
      }),
    )

    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    auditor = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, member.id, engineerRole.id)
    await assignRoleToUser(testDb.db, outsider.id, engineerRole.id)
    await assignRoleToUser(testDb.db, auditor.id, auditorRole.id)
    permissionService.clearCache()

    // The member's own program, with one BOM edge in it. The outsider gets a
    // program of their own so they are a normal user, not a user with nothing.
    const program = await ProgramService.create(
      {
        name: 'Rel Program',
        code: `REL-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Rel Design',
        code: `RELD-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )
    memberDesignId = design.id

    const parent = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Assembly',
        partType: 'Manufacture',
      },
      member.id,
    )
    const child = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Component',
        partType: 'Purchase',
      },
      member.id,
    )
    const [edge] = await testDb.db
      .insert(itemRelationships)
      .values({
        sourceId: parent.id!,
        targetId: child.id!,
        relationshipType: 'BOM',
        quantity: '2',
        findNumber: 1,
        createdBy: member.id,
      })
      .returning()
    edgeId = edge!.id

    await ProgramService.create(
      {
        name: 'Outsider Program',
        code: `RELO-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      outsider.id,
    )

    cookies.clear()
    for (const u of [member, outsider, auditor]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function list(user: TestUser, designId: string) {
    return app.request(`/api/v1/relationships?designId=${designId}`, {
      headers: { Cookie: cookies.get(user.id)!, Origin: 'http://localhost' },
    })
  }

  it('refuses a non-member the design’s edges', async () => {
    const response = await list(outsider, memberDesignId)

    expect(response.status).toBe(403)
    const payload = (await response.json()) as ErrorEnvelope
    expect(payload.error.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('serves the member their own design’s edges', async () => {
    const response = await list(member, memberDesignId)

    expect(response.status).toBe(200)
    const payload = (await response.json()) as RelationshipsEnvelope
    expect(payload.data.relationships.map((r) => r.id)).toEqual([edgeId])
  })

  it('serves cross-program authority any design’s edges', async () => {
    const response = await list(auditor, memberDesignId)

    expect(response.status).toBe(200)
    const payload = (await response.json()) as RelationshipsEnvelope
    expect(payload.data.relationships.map((r) => r.id)).toEqual([edgeId])
  })

  it('refuses before disclosing whether the design is empty', async () => {
    // The gate runs ahead of the items lookup, so a non-member cannot use the
    // empty-vs-populated answer as an oracle either.
    const emptyDesign = await DesignService.create(
      {
        programId: (await ProgramService.listByUser(member.id))[0]!.id,
        name: 'Rel Empty Design',
        code: `RELE-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )

    const response = await list(outsider, emptyDesign.id)

    expect(response.status).toBe(403)
  })
})
