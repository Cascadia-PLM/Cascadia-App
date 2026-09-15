// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Manufacturer-parts (AML) routes — program isolation
 *
 * Security gate. The four master-keyed routes had no instance-level access
 * check at all: `parts:read` listed any part's approved manufacturers and
 * `parts:update` attached, requalified, or detached them. Which suppliers a
 * design has qualified is that design's own commercial information, and the
 * write verbs let an outsider rewrite it.
 *
 * The two users hold the same role — every `parts` verb and nothing else, in
 * particular no `programs:manage` — so a 403 can only come from the design
 * gate.
 *
 * The catalog routes are deliberately *not* gated: a manufacturer and its part
 * number are instance-global master data, like the standard library. That
 * exception is asserted below so it reads as a decision rather than a miss.
 *
 * Run: npx vitest run packages/core/src/server/routes/manufacturer-parts.permissions.test.ts
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
import manufacturerPartsRoutes from './manufacturer-parts'
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
import { ManufacturerPartService } from '@/lib/services/ManufacturerPartService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('manufacturer-parts (AML) routes — program isolation', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route(
    '/api/v1/manufacturer-parts',
    manufacturerPartsRoutes,
  )

  let member: TestUser
  let outsider: TestUser
  let partMasterId: string
  let mappingId: string
  let catalogPartId: string
  let spareCatalogPartId: string

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

    const role = await insertTestRole(
      testDb.db,
      createCustomTestRole(`AML All Parts ${randomUUID().slice(0, 8)}`, {
        parts: ['create', 'read', 'update', 'delete', 'manage'],
        designs: ['create', 'read'],
      }),
    )

    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    for (const u of [member, outsider]) {
      await assignRoleToUser(testDb.db, u.id, role.id)
    }
    permissionService.clearCache()

    // ProgramService.create enrols its creator; the outsider gets a program of
    // their own so they are a normal user rather than a user with nothing.
    const program = await ProgramService.create(
      {
        name: 'AML Program',
        code: `AML-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'AML Design',
        code: `AMLD-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )
    await ProgramService.create(
      {
        name: 'AML Outsider Program',
        code: `AMLO-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      outsider.id,
    )

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Sourced Part',
        partType: 'Purchase',
      },
      member.id,
    )
    if (!part.masterId) throw new Error('part fixture has no masterId')
    partMasterId = part.masterId

    const catalogPart = await ManufacturerPartService.create(
      { manufacturer: 'Acme', mpn: `ACME-${Date.now()}` },
      member.id,
    )
    catalogPartId = catalogPart.id
    const spare = await ManufacturerPartService.create(
      { manufacturer: 'Globex', mpn: `GLX-${Date.now()}` },
      member.id,
    )
    spareCatalogPartId = spare.id

    const mapping = await ManufacturerPartService.attach(
      partMasterId,
      { manufacturerPartId: catalogPartId },
      member.id,
    )
    mappingId = mapping.id

    cookies.clear()
    for (const u of [member, outsider]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function request(
    user: TestUser,
    path: string,
    method = 'GET',
    body?: object,
  ) {
    return app.request(path, {
      method,
      headers: {
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }

  /** The four master-keyed routes, as (label, method, path, body?). */
  function amlRoutes(): Array<[string, string, string, object?]> {
    return [
      ['list AML', 'GET', `/api/v1/manufacturer-parts/part/${partMasterId}`],
      [
        'attach source',
        'POST',
        `/api/v1/manufacturer-parts/part/${partMasterId}`,
        { manufacturerPartId: spareCatalogPartId },
      ],
      [
        'requalify mapping',
        'PATCH',
        `/api/v1/manufacturer-parts/mappings/${mappingId}`,
        { qualificationStatus: 'approved' },
      ],
      [
        'detach mapping',
        'DELETE',
        `/api/v1/manufacturer-parts/mappings/${mappingId}`,
      ],
    ]
  }

  it('refuses a non-member every AML route', async () => {
    for (const [label, method, path, body] of amlRoutes()) {
      const response = await request(outsider, path, method, body)

      expect(response.status, label).toBe(403)
      const payload = (await response.json()) as ErrorEnvelope
      expect(payload.error.code, label).toBe(ErrorCode.PERMISSION_DENIED)
    }
  })

  it('leaves the AML byte-identical after every refused write', async () => {
    const before = await ManufacturerPartService.listForPart(partMasterId)

    for (const [, method, path, body] of amlRoutes()) {
      if (method === 'GET') continue
      await request(outsider, path, method, body)
    }

    const after = await ManufacturerPartService.listForPart(partMasterId)
    expect(after).toEqual(before)
  })

  it('serves the member every AML route', async () => {
    for (const [label, method, path, body] of amlRoutes()) {
      const response = await request(member, path, method, body)

      expect(response.status, label).not.toBe(403)
    }
  })

  it('leaves the manufacturer catalog instance-global', async () => {
    // Deliberate exception: manufacturer + MPN rows are shared master data,
    // like the standard library. An outsider reads them by design.
    expect(
      (await request(outsider, '/api/v1/manufacturer-parts?search=Acme'))
        .status,
    ).toBe(200)
    expect(
      (await request(outsider, `/api/v1/manufacturer-parts/${catalogPartId}`))
        .status,
    ).toBe(200)
  })

  it('leaves a master with no surviving part rows ungated', async () => {
    // Same rule as requirePhysicalPartAccess: no lineage row means no design
    // to draw a boundary around, so the helper passes it through.
    const orphanMaster = randomUUID()

    const response = await request(
      outsider,
      `/api/v1/manufacturer-parts/part/${orphanMaster}`,
    )

    expect(response.status).toBe(200)
  })
})
