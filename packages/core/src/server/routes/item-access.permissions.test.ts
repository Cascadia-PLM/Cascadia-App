// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * By-id item routes — program isolation
 *
 * Security gate. RBAC answers "may this user read parts"; it says nothing
 * about *which* parts, so every by-id route in the type-specific files was
 * reachable by any authenticated user holding the type permission — a viewer
 * in one program could read, and in several places write, every item in every
 * other program by knowing an id.
 *
 * `requireItemAccess` closes that, and these pin it on one route of each
 * shape rather than all sixty:
 *
 *  - a plain by-id read (GET /parts/:id)
 *  - a sub-resource read that runs through a service (GET /software/:id/tree)
 *  - a sub-resource write that hits its own tables, so AUTH-1's service-level
 *    gate never sees it (POST /work-instructions/:id/steps)
 *
 * Both users hold the same RBAC role. The only difference between them is
 * program membership, which is the whole point.
 *
 * Run: npx vitest run packages/core/src/server/routes/item-access.permissions.test.ts
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
import partsRoutes from './parts'
import softwareRoutes from './software'
import workInstructionsRoutes from './work-instructions'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { Software } from '@/lib/items/types/software'
import type { WorkInstruction } from '@/lib/items/types/work-instruction'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('by-id item routes — program isolation', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/parts', partsRoutes)
    .route('/api/v1/software', softwareRoutes)
    .route('/api/v1/work-instructions', workInstructionsRoutes)

  let member: TestUser
  let outsider: TestUser
  let partId: string
  let softwareId: string
  let workInstructionId: string

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

    // Same role for both: 'User' carries parts/software/work_instructions
    // read and update, and no programs:manage — so neither of them has the
    // cross-program bypass, and RBAC cannot be what separates them.
    member = (await insertTestUserWithRole(testDb.db, 'User')).user
    outsider = (await insertTestUserWithRole(testDb.db, 'User')).user

    // ProgramService.create enrols its creator; a direct insert does not.
    const program = await ProgramService.create(
      {
        name: 'Item Access Program',
        code: `IAP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      },
      member.id,
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Item Access Design',
        code: `IAD-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )

    // The generic argument is what types the type-specific fields: create()
    // is generic over BaseItem, and partType lives on Part.
    partId = (
      await ItemService.create<Part>(
        'Part',
        {
          itemType: 'Part',
          designId: design.id,
          revision: 'A',
          name: 'Gated Part',
          partType: 'Manufacture',
        },
        member.id,
      )
    ).id!

    softwareId = (
      await ItemService.create<Software>(
        'Software',
        {
          itemType: 'Software',
          designId: design.id,
          revision: 'A',
          name: 'Gated Firmware',
        },
        member.id,
      )
    ).id!

    // A work instruction names the part it builds.
    workInstructionId = (
      await ItemService.create<WorkInstruction>(
        'WorkInstruction',
        {
          itemType: 'WorkInstruction',
          designId: design.id,
          revision: 'A',
          name: 'Gated Instruction',
          outputPartId: partId,
        },
        member.id,
      )
    ).id!

    cookies.clear()
    for (const u of [member, outsider]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function as(user: TestUser) {
    const cookie = cookies.get(user.id)!
    return {
      get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
      post: (path: string, body: unknown) =>
        app.request(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            Origin: 'http://localhost',
          },
          body: JSON.stringify(body),
        }),
    }
  }

  async function expectDenied(response: Response) {
    expect(response.status).toBe(403)
    const payload = (await response.json()) as ErrorEnvelope
    expect(payload.error.code).toBe(ErrorCode.PERMISSION_DENIED)
  }

  it('denies a non-member the plain by-id read, and allows a member', async () => {
    await expectDenied(await as(outsider).get(`/api/v1/parts/${partId}`))

    const allowed = await as(member).get(`/api/v1/parts/${partId}`)
    expect(allowed.status).toBe(200)
  })

  it('denies a non-member a service-backed sub-resource read', async () => {
    await expectDenied(
      await as(outsider).get(`/api/v1/software/${softwareId}/tree`),
    )

    const allowed = await as(member).get(`/api/v1/software/${softwareId}/tree`)
    expect(allowed.status).toBe(200)
  })

  it('denies a non-member a sub-resource write AUTH-1 never sees', async () => {
    // The step write goes to work_instruction_steps directly, so
    // ItemService.update's design check is not in this path at all — the
    // route gate is the only one there is.
    const body = { title: 'Smuggled step', description: 'from outside' }

    await expectDenied(
      await as(outsider).post(
        `/api/v1/work-instructions/${workInstructionId}/steps`,
        body,
      ),
    )

    const allowed = await as(member).post(
      `/api/v1/work-instructions/${workInstructionId}/steps`,
      body,
    )
    expect(allowed.status).toBeLessThan(400)
  })

  it('refuses the non-member before reading the body, not after', async () => {
    // A body the route would reject as invalid: the answer must still be 403.
    // Otherwise the shape of a 400 tells an outsider what the payload should
    // have been, and confirms the id exists.
    const response = await as(outsider).post(
      `/api/v1/work-instructions/${workInstructionId}/steps`,
      {},
    )

    await expectDenied(response)
  })
})
