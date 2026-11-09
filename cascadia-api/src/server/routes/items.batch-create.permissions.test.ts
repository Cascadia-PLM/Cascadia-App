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
 *  - The pre-flight's whole point is that it runs before anything is
 *    queued. The batch is written by a background job (`BatchCreateService`
 *    on the jobs worker) that re-checks nothing, so a refusal must leave no
 *    job behind — every refusal below counts the queue — and the mixed-batch
 *    case counts rows either side as well.
 *
 * No broker runs in CI, so `RabbitMQClient` is stubbed: `JobService.submit`
 * still writes the job row, and the admitted case runs that job's payload
 * through the service the worker runs.
 *
 * Run: npx vitest run cascadia-api/src/server/routes/items.batch-create.permissions.test.ts
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
  vi,
} from 'vitest'
import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { ErrorCode } from '@cascadia/commons/errors/codes'
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BatchCreatePayload } from '@/jobs/definitions/import/types'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { BranchService } from '@/services/BranchService'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { changeOrders, items, jobs, programMembers } from '@/db/schema'
import { BatchCreateService } from '@/items/services/BatchCreateService'
import { RabbitMQClient } from '@/jobs/rabbitmq/client'
import { BATCH_CREATE_JOB_TYPE } from '@/jobs/definitions/import/config'

// Import to register item types
import '@/items/registerItemTypes.server'

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

    // `submit` connects before it writes the row, and no broker runs in CI.
    vi.spyOn(RabbitMQClient, 'connect').mockResolvedValue(undefined)
    vi.spyOn(RabbitMQClient, 'publish').mockResolvedValue(undefined)

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
    vi.restoreAllMocks()
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

  /** Batches this suite's users queued — rows committed by anything else are not ours to count. */
  async function queuedBatches() {
    return testDb.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, BATCH_CREATE_JOB_TYPE),
          inArray(jobs.createdBy, [homeOnly.id, bothPrograms.id]),
        ),
      )
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
      expect(await queuedBatches()).toHaveLength(0)
    })

    it('refuses a non-member naming a branch of the foreign design', async () => {
      // The sharper leg: `createOnBranch` takes the design FROM the branch and
      // ignores any `designId` in the body, so a branch id alone was enough.
      const response = await batchCreate(homeOnly, {
        items: [partRow({ branchId: foreignBranchId, name: 'Trespass' })],
      })

      expect(await refusalCode(response)).toBe(ErrorCode.PERMISSION_DENIED)
      expect(await queuedBatches()).toHaveLength(0)
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

      expect(response.status).toBe(202)
      const [job, ...others] = await queuedBatches()
      expect(others).toHaveLength(0)
      expect(job?.createdBy).toBe(bothPrograms.id)

      // And the queued rows land when the job runs, as the worker runs it.
      const payload = job?.payload as BatchCreatePayload
      await BatchCreateService.run(payload.request, payload.userId)
      expect(await countItems(foreignDesignId)).toBeGreaterThan(before)
    })
  })

  describe('the pre-flight runs before the write loop', () => {
    it('refuses a mixed batch whole and queues neither row', async () => {
      // The invariant the whole placement exists for. Row 1 is one this caller
      // may write; without the pre-flight the batch is queued, and the job
      // then writes row 1 and fails row 2 — half the batch applied.
      const homeBefore = await countItems(homeDesignId)
      const foreignBefore = await countItems(foreignDesignId)

      const response = await batchCreate(homeOnly, {
        items: [
          partRow({ designId: homeDesignId, name: 'Legitimate' }),
          partRow({ designId: foreignDesignId, name: 'Trespass' }),
        ],
      })

      expect(await refusalCode(response)).toBe(ErrorCode.PERMISSION_DENIED)
      expect(await queuedBatches()).toHaveLength(0)
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

      expect(response.status).toBe(400)
      const payload = (await response.json()) as ErrorEnvelope
      expect(payload.error.code).toBe(ErrorCode.VALIDATION_FAILED)
      expect(await queuedBatches()).toHaveLength(0)
      expect((await testDb.db.select().from(changeOrders)).length).toBe(before)
    })
  })
})
