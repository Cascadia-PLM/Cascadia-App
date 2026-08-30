// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * branch-items pull/rebase — error envelope conformance (API2-2)
 *
 * Data-integrity gate: these two routes are the ECO conflict-resolution write
 * path. When one refuses, the refusal is the only thing standing between a
 * user and a working copy rewritten from the wrong base, so a client has to be
 * able to read it — and both rejections used to answer with a bare
 * `{ error: '<message>' }`, which is not the envelope
 * `docs/api/openapi.v1.json` promises for these operations. Every client reads
 * `error.code`; against a bare string it read `undefined`, so a merge conflict
 * and a missing row were indistinguishable to anything but a human.
 *
 * The invariant, and the reason these tests parse rather than poke: every
 * non-2xx body this router can produce validates against `errorResponseSchema`
 * itself. The parse *is* the assertion — `code`, `message` and `timestamp` are
 * all required by it, so a regression to a bare string fails here regardless
 * of which field a future reader happened to think of checking. On top of that
 * the 409 keeps carrying its field conflicts, in the `data` sibling, because
 * they are the whole answer to "what do I have to resolve".
 *
 * Run: npx vitest run packages/core/src/server/routes/branch-items.test.ts
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
import branchItemsRoutes from './branch-items'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { ErrorResponse } from '@/lib/errors/api'
import type { FieldConflict } from '@/lib/services/ConflictDetectionService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { errorResponseSchema } from '@/lib/api/openapi-helpers'
import { ApiError } from '@/lib/api/client'
import { ErrorCode } from '@/lib/errors/codes'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import {
  branchItems,
  itemVersions,
  items,
  programMembers,
  programs,
} from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

import '@/lib/items/registerItemTypes.server'

/** A UUID the body schema accepts and no row will ever carry. */
const ABSENT_ITEM_ID = '00000000-0000-4000-8000-00000000dead'

describe('branch-items error envelope', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/branch-items', branchItemsRoutes)

  let admin: TestUser
  let cookie: string
  let branchItemId: string
  /** The released row on main; the branch item's three-way base. */
  let releasedPart: { id: string; masterId: string; itemNumber: string }
  let designId: string

  /**
   * A released Part on main. `as never` on the type-specific payload is the
   * house idiom for `ItemService.create`, and it collapses the return type to
   * `never` unless the call is wrapped in an annotated function — hence this.
   */
  const createPart = (
    itemNumber: string,
    revision: string,
    name: string,
  ): Promise<{ id: string; masterId: string }> =>
    ItemService.create(
      'Part',
      {
        itemNumber,
        revision,
        name,
        state: 'Released',
        designId,
        partType: 'Manufacture',
      } as never,
      admin.id,
      { bypassBranchProtection: true },
    )

  beforeAll(async () => {
    await testDb.setup()
    // The revise inference behind ensureRevisionWorkingCopy reads the Part
    // lifecycle's mappings — seed the canonical link rather than trusting what
    // another suite left behind (item_type_configs is one shared row per type).
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
          name: 'Envelope Program',
          code: `PROG-BIE-${Date.now()}`,
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
        name: 'Envelope Design',
        code: `DESIGN-BIE-${Date.now()}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    designId = design.id

    // A released part on main, so checking it out to the ECO branch mints a
    // branch-local working copy — the shape both routes are written for.
    const itemNumber = `PN-BIE-${Date.now()}`
    const created = await createPart(itemNumber, 'A', 'Released Name')
    releasedPart = { ...created, itemNumber }
    await testDb.db.insert(itemVersions).values({
      commitId: design.initialCommit!.id,
      itemId: releasedPart.id,
      changeType: 'added',
    })

    const createEco = (): Promise<{ id: string }> =>
      ItemService.create(
        'ChangeOrder',
        {
          revision: 'A',
          name: 'Envelope ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Envelope conformance test',
          designId,
        } as never,
        admin.id,
      )
    const eco = await createEco()
    const { branch } = await BranchService.getOrCreateEcoBranch(
      designId,
      eco.id,
      admin.id,
    )

    // The same two calls POST /items/:id/checkout makes: mint the branch-local
    // working copy, then take the checkout row that points at it.
    const releasedRow = takeFirst(
      await testDb.db
        .select()
        .from(items)
        .where(eq(items.id, releasedPart.id))
        .limit(1),
    )
    await CheckoutService.ensureRevisionWorkingCopy(
      releasedRow,
      branch.id,
      admin.id,
    )
    const branchItem = await CheckoutService.checkout(
      { itemMasterId: releasedPart.masterId, branchId: branch.id },
      admin.id,
    )
    branchItemId = branchItem.id

    cookie = `session=${(await SessionManager.createSession(admin.id)).sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function post(path: string, body?: unknown, withCookie = true) {
    return app.request(`/api/v1/branch-items${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(withCookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /**
   * Assert the invariant on one rejection: the body IS the documented
   * envelope. `errorResponseSchema.parse` is the assertion — it requires
   * `error.code`, `error.message` and `error.timestamp`, so a bare-string
   * `error` cannot pass it — and the client's own error class is then built
   * from the result, since `ApiError.fromResponse` reading `undefined` off a
   * bare string is the concrete harm this envelope prevents.
   */
  async function expectDocumentedEnvelope(
    response: Response,
    expectedCode: ErrorCode,
  ): Promise<void> {
    expect(response.status).toBeGreaterThanOrEqual(400)
    const payload: unknown = await response.json()

    const parsed = errorResponseSchema.parse(payload)
    expect(parsed.error.code).toBe(expectedCode)
    expect(parsed.error.message).not.toBe('')

    // `errorResponseSchema` types `code` as a plain string — it documents the
    // wire, not the enum — while the client constructor takes the enum.
    const apiError = ApiError.fromResponse(
      parsed.error as ErrorResponse['error'],
      response.status,
    )
    expect(apiError.code).toBe(expectedCode)
    expect(apiError.message).toBe(parsed.error.message)
  }

  describe('pull-from-main', () => {
    it('answers a failed pull in the documented envelope, not a bare string', async () => {
      const response = await post(`/${branchItemId}/pull-from-main`, {
        mainItemId: ABSENT_ITEM_ID,
      })

      expect(response.status).toBe(400)
      await expectDocumentedEnvelope(response, ErrorCode.VALIDATION_FAILED)
    })

    it('answers an unknown branch item in the documented envelope', async () => {
      const response = await post(`/${ABSENT_ITEM_ID}/pull-from-main`, {
        mainItemId: releasedPart.id,
      })

      expect(response.status).toBe(404)
      await expectDocumentedEnvelope(response, ErrorCode.RESOURCE_NOT_FOUND)
    })

    it('answers a non-conforming body in the documented envelope', async () => {
      const response = await post(`/${branchItemId}/pull-from-main`, {
        mainItemId: 'not-a-uuid',
      })

      expect(response.status).toBe(400)
      await expectDocumentedEnvelope(response, ErrorCode.VALIDATION_FAILED)
    })

    it('answers an unauthenticated call in the documented envelope', async () => {
      const response = await post(
        `/${branchItemId}/pull-from-main`,
        { mainItemId: releasedPart.id },
        false,
      )

      expect(response.status).toBe(401)
      await expectDocumentedEnvelope(response, ErrorCode.AUTH_REQUIRED)
    })
  })

  describe('rebase', () => {
    /**
     * Move both sides off the shared base so the three-way comparison has a
     * genuine conflict to report: the branch renames its working copy, main
     * lands a different name in a new revision. Returns main's new item id,
     * which is the rebase target.
     */
    async function divergeOnName(): Promise<string> {
      const row = takeFirst(
        await testDb.db
          .select({ currentItemId: branchItems.currentItemId })
          .from(branchItems)
          .where(eq(branchItems.id, branchItemId))
          .limit(1),
      )
      const workingCopyId = row.currentItemId
      // The checkout is only a valid fixture if it actually minted a copy:
      // rebasing the released row against itself would find no conflict.
      expect(workingCopyId).toBeTruthy()
      expect(workingCopyId).not.toBe(releasedPart.id)

      await testDb.db
        .update(items)
        .set({ name: 'Renamed on the branch' })
        .where(eq(items.id, workingCopyId!))

      const theirs = await createPart(
        releasedPart.itemNumber,
        'B',
        'Renamed on main',
      )
      return theirs.id
    }

    it('answers a failed rebase in the documented envelope, not a bare string', async () => {
      const response = await post(`/${branchItemId}/rebase`, {
        newBaseItemId: ABSENT_ITEM_ID,
      })

      expect(response.status).toBe(400)
      await expectDocumentedEnvelope(response, ErrorCode.VALIDATION_FAILED)
    })

    it('answers a manual-resolution conflict in the documented envelope', async () => {
      const newBaseItemId = await divergeOnName()

      const response = await post(`/${branchItemId}/rebase`, { newBaseItemId })

      expect(response.status).toBe(409)
      await expectDocumentedEnvelope(response, ErrorCode.MERGE_CONFLICT)
    })

    it('keeps the field conflicts a resolution UI needs beside the envelope', async () => {
      const newBaseItemId = await divergeOnName()

      const response = await post(`/${branchItemId}/rebase`, { newBaseItemId })

      expect(response.status).toBe(409)
      // Making the rejection readable must not cost the caller the one thing
      // it came for: the conflicts it has to resolve.
      const payload = (await response.json()) as {
        data: {
          manualResolutionRequired: boolean
          fieldConflicts: Array<FieldConflict>
        }
      }
      expect(payload.data.manualResolutionRequired).toBe(true)
      expect(payload.data.fieldConflicts.map((c) => c.fieldName)).toContain(
        'name',
      )
    })

    it('answers an unknown branch item in the documented envelope', async () => {
      const response = await post(`/${ABSENT_ITEM_ID}/rebase`, {
        newBaseItemId: releasedPart.id,
      })

      expect(response.status).toBe(404)
      await expectDocumentedEnvelope(response, ErrorCode.RESOURCE_NOT_FOUND)
    })

    it('answers a non-conforming body in the documented envelope', async () => {
      const response = await post(`/${branchItemId}/rebase`, {
        newBaseItemId: 'not-a-uuid',
      })

      expect(response.status).toBe(400)
      await expectDocumentedEnvelope(response, ErrorCode.VALIDATION_FAILED)
    })
  })
})
