// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * batch-create — program boundary
 *
 * Security gate. `POST /api/v1/items/batch-create` charged the per-type RBAC
 * create verb and then called `ItemService.create` / `createOnBranch` with the
 * caller's own `data`, which carries `designId` and `branchId` as unvalidated
 * record keys. The type verb is instance-blind, and neither service path
 * checks membership on create — so anyone holding `parts:create` could write
 * into any program's design or branch by knowing an id.
 *
 * The axis under test is program membership, NOT the type verb, so the two
 * users here hold identical roles and differ only in which program they are a
 * member of. Neither holds `programs:manage`: that is cross-program authority
 * and would mask the very gate under test.
 *
 * Three things this suite has to get right, or it passes vacuously:
 *
 *  - The check is in-handler, so `apiHandler` parses `body:` FIRST. A body
 *    that misses `batchCreateRequestSchema` answers 400, not 403, and the
 *    permission leg proves nothing. Every body below is schema-valid.
 *  - A 403 is not by itself proof of THIS refusal: branch protection answers
 *    403/BRANCH_PROTECTED from further down. Assert on `error.code`.
 *  - The pre-flight's whole point is that it runs before the write loop, and
 *    only a row count can tell a refusal from a half-applied batch that then
 *    refused. The mixed-batch case counts rows either side.
 *
 * Run: npx vitest run packages/core/src/server/routes/items.batch-create.permissions.test.ts
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
import { eq } from 'drizzle-orm'
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { BranchService } from '@/lib/services/BranchService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { changeOrders, items, programMembers } from '@/lib/db/schema'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('batch-create — program boundary', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)

  let homeOnly: TestUser
  let bothPrograms: TestUser
  let homeDesignId: string
  let foreignDesignId: string
  let foreignBranchId: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // The permission cache is process-global; these users are new each test.
    permissionService.clearCache()

    const suffix = randomUUID().slice(0, 8)

    // ONE role, shared. Both callers can create every type this route accepts,
    // so nothing they are refused can come from the RBAC loop. `programs:read`
    // and no `programs:manage`: cross-program authority is what
    // `AccessControlService.hasCrossProgramAccess` reads, and holding it would
    // pass every design check unconditionally.
    const creatorRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Batch Creator ${suffix}`, {
        parts: ['read', 'create'],
        change_orders: ['read', 'create'],
        programs: ['read'],
      }),
    )

    homeOnly = await insertTestUser(testDb.db)
    bothPrograms = await insertTestUser(testDb.db)
    const owner = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, homeOnly.id, creatorRole.id)
    await assignRoleToUser(testDb.db, bothPrograms.id, creatorRole.id)
    permissionService.clearCache()

    const homeProgram = await ProgramService.create(
      {
        name: 'Batch Home Program',
        code: `BCH-${Date.now()}-${suffix.slice(0, 4).toUpperCase()}`,
      },
      owner.id,
    )
    const foreignProgram = await ProgramService.create(
      {
        name: 'Batch Foreign Program',
        code: `BCF-${Date.now()}-${suffix.slice(4, 8).toUpperCase()}`,
      },
      owner.id,
    )

    // The only difference between the two callers.
    await testDb.db.insert(programMembers).values([
      { programId: homeProgram.id, userId: homeOnly.id, role: 'engineer' },
      { programId: homeProgram.id, userId: bothPrograms.id, role: 'engineer' },
      {
        programId: foreignProgram.id,
        userId: bothPrograms.id,
        role: 'engineer',
      },
    ])

    const homeDesign = await DesignService.create(
      {
        programId: homeProgram.id,
        name: 'Batch Home Design',
        code: `BCHD-${Date.now()}`,
        designType: 'Engineering',
      },
      owner.id,
    )
    homeDesignId = homeDesign.id

    const foreignDesign = await DesignService.create(
      {
        programId: foreignProgram.id,
        name: 'Batch Foreign Design',
        code: `BCFD-${Date.now()}`,
        designType: 'Engineering',
      },
      owner.id,
    )
    foreignDesignId = foreignDesign.id

    const foreignBranch = await BranchService.createWorkspaceBranch(
      foreignDesignId,
      owner.id,
      'batch-foreign',
    )
    foreignBranchId = foreignBranch.id

    cookies.clear()
    for (const u of [homeOnly, bothPrograms]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function partRow(data: Record<string, unknown>) {
    return {
      itemType: 'Part',
      data: {
        revision: 'A',
        partType: 'Manufacture',
        ...data,
      },
    }
  }

  async function batchCreate(user: TestUser, body: unknown): Promise<Response> {
    return app.request('/api/v1/items/batch-create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
      },
      body: JSON.stringify(body),
    })
  }

  /**
   * The access verdict alone. Branch protection also answers 403, with
   * BRANCH_PROTECTED, from inside `ItemService.create` — and this route's own
   * RBAC loop answers 403 too. Only PERMISSION_DENIED from the pre-flight is
   * this suite's subject, and both callers hold every verb the loop charges.
   */
  async function refusalCode(response: Response): Promise<string | null> {
    if (response.status !== 403) return null
    const payload = (await response.json()) as ErrorEnvelope
    return payload.error.code
  }

  async function countItems(designId: string): Promise<number> {
    return (
      await testDb.db.select().from(items).where(eq(items.designId, designId))
    ).length
  }

  describe('a create verb does not carry across the program boundary', () => {
    it('refuses a non-member naming the foreign design directly', async () => {
      const response = await batchCreate(homeOnly, {
        items: [partRow({ designId: foreignDesignId, name: 'Trespass' })],
      })

      expect(await refusalCode(response)).toBe(ErrorCode.PERMISSION_DENIED)
    })

    it('refuses a non-member naming a branch of the foreign design', async () => {
      // The sharper leg: `createOnBranch` takes the design FROM the branch and
      // ignores any `designId` in the body, so a branch id alone was enough.
      const response = await batchCreate(homeOnly, {
        items: [partRow({ branchId: foreignBranchId, name: 'Trespass' })],
      })

      expect(await refusalCode(response)).toBe(ErrorCode.PERMISSION_DENIED)
    })

    it('admits a member of both programs to the same two rows', async () => {
      // The gate is not simply refusing everyone: identical role, identical
      // bodies, membership the only difference.
      const before = await countItems(foreignDesignId)

      const response = await batchCreate(bothPrograms, {
        items: [
          partRow({ designId: foreignDesignId, name: 'Admitted Direct' }),
          partRow({ branchId: foreignBranchId, name: 'Admitted On Branch' }),
        ],
      })

      expect(await refusalCode(response)).not.toBe(ErrorCode.PERMISSION_DENIED)
      expect(await countItems(foreignDesignId)).toBeGreaterThan(before)
    })
  })

  describe('the pre-flight runs before the write loop', () => {
    it('refuses a mixed batch whole and writes neither row', async () => {
      // The invariant the whole placement exists for. Row 1 is one this caller
      // may write; without the pre-flight it lands, the loop then throws on
      // row 2, and the call returns 207 with half the batch applied.
      const homeBefore = await countItems(homeDesignId)
      const foreignBefore = await countItems(foreignDesignId)

      const response = await batchCreate(homeOnly, {
        items: [
          partRow({ designId: homeDesignId, name: 'Legitimate' }),
          partRow({ designId: foreignDesignId, name: 'Trespass' }),
        ],
      })

      expect(await refusalCode(response)).toBe(ErrorCode.PERMISSION_DENIED)
      expect(await countItems(homeDesignId)).toBe(homeBefore)
      expect(await countItems(foreignDesignId)).toBe(foreignBefore)
    })
  })

  describe('change orders', () => {
    it('refuses a ChangeOrder row and writes no change order', async () => {
      // An ECO is defined by the designs it touches and this route cannot take
      // them, so one created here would be linked to nothing — outside every
      // program, and therefore inside no boundary at all. `POST /api/v1/items`
      // already refuses it; this was the remaining live path.
      const before = (await testDb.db.select().from(changeOrders)).length

      const response = await batchCreate(bothPrograms, {
        items: [{ itemType: 'ChangeOrder', data: { name: 'Orphan ECO' } }],
      })

      // The code, not the status: this route also answers 400 when every row
      // in the batch fails downstream, and that envelope is not an error one.
      expect(response.status).toBe(400)
      const payload = (await response.json()) as ErrorEnvelope
      expect(payload.error.code).toBe(ErrorCode.VALIDATION_FAILED)
      expect((await testDb.db.select().from(changeOrders)).length).toBe(before)
    })
  })
})
