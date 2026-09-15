// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `requireBranchAccess` — the branch gate, directly and through a body
 *
 * Security gate. A branch belongs to a design and a design belongs to a
 * program, so "may this caller touch this branch" is really "may they reach
 * the program behind it". `requireBranchAccess` is the one place that asks,
 * and until now nothing asked anything of the helper itself: it was covered
 * only transitively, by suites whose subject was something else.
 *
 * Two halves, because the helper has two call-site shapes and only one of
 * them is reachable by enumeration.
 *
 * The first half calls the helper directly — a branch id that names no row, a
 * branch in a program the caller is not in, and a branch they may have — so
 * the three scenarios are pinned as *classes*, at the seam where the routes
 * read them, rather than inferred from an HTTP status somewhere downstream.
 * The first two collapse to the same class on purpose: a missing branch and
 * an unreachable one both answer PermissionDeniedError, so neither the
 * routes above nor a caller watching responses can tell which is true.
 *
 * The second half is the shape the by-id enumeration ratchet structurally
 * cannot drive. Of the eighteen call sites, six take the branch from the path
 * — the four gated branches routes, which the ratchet now enumerates, plus
 * `workspaces.ts` and `branch-items.ts`. Ten read a `branchId` out of the
 * request *body* (`items/checkout.ts` in five places, `items/batch.ts` twice,
 * `import.ts` twice, `requirements.ts`), and two more out of the query string
 * (`GET` and `DELETE /items/:id/checkout`). Every body-carrying one of those
 * declares `body:`, so the ratchet's empty `{}` is a 400 raised in the wrapper
 * long before the handler runs — it never reaches the gate at all, which is
 * exactly why the ratchet accepts that 400 and why this case has to be
 * written by hand.
 *
 * ("The four gated branches routes", not five: `PUT /branches/:id` does not
 * call this helper. It asks `ProgramService.getUserRole` for lead or admin
 * directly, which is strictly narrower than design access, so it is not a
 * fifth instance of this gate and is not asserted here.)
 *
 * The fixture is built so the branch check is the only thing that can refuse.
 * The item named in the path is the caller's own, so `requireItemAccess` —
 * which runs first, and throws the same `PermissionDeniedError` — passes; a
 * 403 can then only have come from the branch named in the body. The control
 * request makes that argument out loud: same caller, same item, their own
 * branch, and the answer is anything but 403.
 *
 * Run: npx vitest run packages/core/src/server/routes/branches.permissions.test.ts
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
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { BranchService } from '@/lib/services/BranchService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { requireBranchAccess } from '@/lib/auth/access'
import { PermissionDeniedError } from '@/lib/errors'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface ErrorEnvelope {
  error: { code: string }
}

describe('requireBranchAccess — program isolation on branches', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/items', itemsRoutes)

  let member: TestUser
  let stranger: TestUser
  /** A design, and a branch on it, the member may reach. */
  let ownDesignId: string
  let ownBranchId: string
  /** The same, in a program the member has no membership in. */
  let foreignBranchId: string
  /** A part in the member's own design — reachable, whatever branch is named. */
  let ownPartId: string

  const cookies = new Map<string, string>()

  /**
   * A program with a design and an ordinary branch on it, all owned by one
   * user. `ProgramService.create` enrols its creator; a direct insert does
   * not, which is what makes the two programs genuinely disjoint here.
   *
   * A workspace branch rather than the design's `main`: `main` is special-
   * cased in branch protection and status, and the gate under test does not
   * care about branch type, so the ordinary case is the honest one.
   */
  async function seedProgram(owner: TestUser, tag: string) {
    const program = await ProgramService.create(
      {
        name: `Branch Gate ${tag}`,
        code: `BG${tag}-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      owner.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: `Branch Gate Design ${tag}`,
        code: `BGD${tag}-${Date.now()}`,
        designType: 'Engineering',
      },
      owner.id,
    )
    const branch = await BranchService.createWorkspaceBranch(
      design.id,
      owner.id,
      `branch-gate-${tag.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    )
    return { program, design, branch }
  }

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // The same role for both, and one without `programs:manage` — the
    // cross-program bypass `AccessControlService` honours. RBAC therefore
    // cannot be what separates them; program membership is.
    member = (await insertTestUserWithRole(testDb.db, 'User')).user
    stranger = (await insertTestUserWithRole(testDb.db, 'User')).user

    const own = await seedProgram(member, 'OWN')
    const foreign = await seedProgram(stranger, 'FGN')

    ownDesignId = own.design.id
    ownBranchId = own.branch.id
    foreignBranchId = foreign.branch.id

    ownPartId = (
      await ItemService.create<Part>(
        'Part',
        {
          itemType: 'Part',
          designId: own.design.id,
          revision: 'A',
          name: 'Branch Gate Part',
          partType: 'Manufacture',
        },
        member.id,
      )
    ).id!

    cookies.clear()
    for (const u of [member, stranger]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function postAs(user: TestUser, path: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
      },
      body: JSON.stringify(body),
    })
  }

  it('throws PermissionDeniedError for a branch id that names no row', async () => {
    // Authorization is answered without first confirming existence, so a
    // branch that is missing reads exactly like one the caller cannot
    // reach — never a distinguishable 404.
    await expect(
      requireBranchAccess(member.id, randomUUID()),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('throws PermissionDeniedError for a branch in another program', async () => {
    await expect(
      requireBranchAccess(member.id, foreignBranchId),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('returns the branch and its design to a member of the owning program', async () => {
    const { branch, designId } = await requireBranchAccess(
      member.id,
      ownBranchId,
    )

    expect(branch.id).toBe(ownBranchId)
    // The returned designId is what callers gate the rest of their work on,
    // so it has to be the branch's design and not merely truthy.
    expect(designId).toBe(ownDesignId)
    expect(branch.designId).toBe(ownDesignId)
  })

  it('refuses a checkout naming a foreign branch for an item the caller owns', async () => {
    const denied = await postAs(member, `/api/v1/items/${ownPartId}/checkout`, {
      branchId: foreignBranchId,
    })

    expect(denied.status).toBe(403)
    const payload = (await denied.json()) as ErrorEnvelope
    expect(payload.error.code).toBe(ErrorCode.PERMISSION_DENIED)

    // The control, and the reason the assertion above means anything: the
    // item gate and the branch gate raise the same error, so only a request
    // that differs *solely* in the branch shows which one fired. It lands as
    // a 201 today, but the assertion stays at "anything but 403" on purpose —
    // branch protection and lock state are not what is under test, and a
    // control that also asserted checkout semantics would fail for reasons
    // that say nothing about the gate.
    const allowed = await postAs(
      member,
      `/api/v1/items/${ownPartId}/checkout`,
      {
        branchId: ownBranchId,
      },
    )

    expect(allowed.status).not.toBe(403)
  })
})
