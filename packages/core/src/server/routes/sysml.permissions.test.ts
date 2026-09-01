// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * SysML element-create route — item-type create RBAC and API-key scope
 *
 * Security gate. `POST /projects/:id/branches/:bid/elements` declared no
 * permission at all — `apiHandler({ body })` is auth-only — yet it creates a
 * real Cascadia item through `ItemService.createOnBranch`. Two escalations
 * followed, the same pair the import routes were fixed for:
 *
 *   - a session user whose role lacks the `create` verb (Approver, View Only)
 *     could mint items through the SysML endpoint, routing around their role;
 *   - `apiHandler` narrows API-key scope only inside its declared-permission
 *     branch, so on an undeclared route a key scoped `{ parts: ['read'] }`
 *     carried full write access.
 *
 * The check has to be in the handler because the type created depends on the
 * element's `@type`, so the last case below is the load-bearing one: the
 * permission follows the mapped type, not a single fixed tuple.
 *
 * The last three cases cover a second gate in the same file, of the same shape:
 * `GET /projects/:id/commits` authorized the **path** project and then resolved
 * a branch from the `branchId` **query** parameter without checking it belonged
 * to that project, so access to one project read any branch's commit history —
 * and its exact commit count — out of a program the caller cannot reach.
 *
 * Run: npx vitest run packages/core/src/server/routes/sysml.permissions.test.ts
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
import sysmlRoutes from './sysml'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { BranchService } from '@/lib/services/BranchService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { ErrorCode } from '@/lib/errors'
import {
  generateApiKey,
  getKeyPrefix,
  hashApiKey,
} from '@/lib/auth/api-key-utils'
import { apiKeys } from '@/lib/db/schema/api-keys'
import { items } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('SysML element-create — item-type RBAC and key scope', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/sysml', sysmlRoutes)

  let designId: string
  let branchId: string
  let programId: string
  let ownerId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // The design's owner needs create rights to exist; the route's callers
    // below are separate users enrolled into the same program.
    const owner = await insertTestUser(testDb.db)
    const ownerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`SysML Owner ${randomUUID().slice(0, 8)}`, {
        parts: ['create', 'read', 'update'],
        designs: ['create', 'read'],
        programs: ['read'],
      }),
    )
    await assignRoleToUser(testDb.db, owner.id, ownerRole.id)
    ownerId = owner.id
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'SysML Program',
        code: `SML-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      owner.id,
    )
    programId = program.id
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'SysML Design',
        code: `SMLD-${Date.now()}`,
        designType: 'Engineering',
      },
      owner.id,
    )
    designId = design.id

    const branches = await BranchService.listByDesign(design.id)
    const main = branches.find((b) => !b.isLocked) ?? branches[0]
    if (!main) throw new Error('design fixture has no branch')
    branchId = main.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** A program member holding exactly the given permissions. */
  async function memberWith(
    permissions: Record<string, Array<string>>,
  ): Promise<TestUser> {
    const user = await insertTestUser(testDb.db)
    const role = await insertTestRole(
      testDb.db,
      createCustomTestRole(
        `SysML Caller ${randomUUID().slice(0, 8)}`,
        permissions,
      ),
    )
    await assignRoleToUser(testDb.db, user.id, role.id)
    await ProgramService.addMember(programId, user.id, 'engineer', ownerId)
    permissionService.clearCache()
    return user
  }

  async function mintKey(
    userId: string,
    scope: Record<string, Array<string>> | null,
  ): Promise<string> {
    const rawKey = generateApiKey()
    await testDb.db.insert(apiKeys).values({
      userId,
      name: 'sysml test key',
      keyHash: hashApiKey(rawKey),
      keyPrefix: getKeyPrefix(rawKey),
      permissions: scope,
    })
    return rawKey
  }

  function postElement(headers: Record<string, string>, sysmlType: string) {
    return app.request(
      `/api/v1/sysml/projects/${designId}/branches/${branchId}/elements`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
          ...headers,
        },
        body: JSON.stringify({
          '@id': randomUUID(),
          '@type': sysmlType,
          declaredName: `EL-${randomUUID().slice(0, 8)}`,
          name: 'Smuggled element',
        }),
      },
    )
  }

  async function cookieFor(user: TestUser) {
    const { sessionToken } = await SessionManager.createSession(user.id)
    return { Cookie: `session=${sessionToken}` }
  }

  async function itemCount() {
    return (
      await testDb.db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.designId, designId))
    ).length
  }

  it('refuses a member whose role lacks the mapped create verb', async () => {
    // Reads parts, cannot create them — the Approver / View Only shape.
    const approver = await memberWith({
      parts: ['read'],
      designs: ['read'],
    })
    const before = await itemCount()

    const response = await postElement(await cookieFor(approver), 'PartUsage')

    expect(response.status).toBe(403)
    // The invariant: a refused request creates nothing.
    expect(await itemCount()).toBe(before)
  })

  it('serves a member who holds parts:create', async () => {
    const engineer = await memberWith({
      parts: ['create', 'read', 'update'],
      designs: ['read'],
    })

    const response = await postElement(await cookieFor(engineer), 'PartUsage')

    // Not-403 rather than 201, deliberately. The route has a separate,
    // pre-existing defect on this path: it builds `itemData` with a designId
    // and then omits it from the object handed to `ItemService.createOnBranch`,
    // so a PartUsage answers 400 on the Part schema's required `designId`
    // whoever sends it. That is out of scope here — this suite asserts the
    // permission gate, and 403-vs-not is exactly what the gate decides.
    expect(response.status).not.toBe(403)
  })

  it('refuses a read-scoped API key on a user who could otherwise create', async () => {
    const engineer = await memberWith({
      parts: ['create', 'read', 'update'],
      designs: ['read'],
    })
    const key = await mintKey(engineer.id, { parts: ['read'] })
    const before = await itemCount()

    const response = await postElement(
      { Authorization: `Bearer ${key}` },
      'PartUsage',
    )

    expect(response.status).toBe(403)
    expect(await itemCount()).toBe(before)
  })

  it('admits the same user through a key scoped to parts:create', async () => {
    const engineer = await memberWith({
      parts: ['create', 'read', 'update'],
      designs: ['read'],
    })
    const key = await mintKey(engineer.id, { parts: ['create', 'read'] })

    const response = await postElement(
      { Authorization: `Bearer ${key}` },
      'PartUsage',
    )

    // Same not-403 reasoning as above: what changed between this leg and the
    // previous one is only the key's scope.
    expect(response.status).not.toBe(403)
  })

  it('follows the element type: tasks:create posts an ActionUsage but not a PartUsage', async () => {
    // The reason the check cannot be a declared tuple. SYSML_TO_CASCADIA_MAP
    // sends ActionUsage → Task and PartUsage → Part, so one role admits one
    // and refuses the other.
    const taskAuthor = await memberWith({
      tasks: ['create', 'read'],
      parts: ['read'],
      designs: ['read'],
    })
    const headers = await cookieFor(taskAuthor)

    expect((await postElement(headers, 'ActionUsage')).status).toBe(201)
    expect((await postElement(headers, 'PartUsage')).status).toBe(403)
    // ActionUsage really did create something; the refusal above did not.
    expect(await itemCount()).toBe(1)
  })

  /**
   * A second program, with its own design and branch, that the callers built by
   * `memberWith` are never enrolled into. Created by the same owner as the
   * program above — who is a member of both — because what the cases below turn
   * on is the *caller's* reach, not the creator's.
   */
  async function foreignProject(): Promise<{
    designId: string
    branchId: string
  }> {
    const program = await ProgramService.create(
      {
        name: 'SysML Program B',
        code: `SMLB-${randomUUID().slice(0, 8).toUpperCase()}`,
      },
      ownerId,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'SysML Design B',
        code: `SMLDB-${randomUUID().slice(0, 8).toUpperCase()}`,
        designType: 'Engineering',
      },
      ownerId,
    )

    const branches = await BranchService.listByDesign(design.id)
    const main = branches.find((b) => !b.isLocked) ?? branches[0]
    if (!main) throw new Error('foreign design fixture has no branch')
    return { designId: design.id, branchId: main.id }
  }

  /** The commit collection, always addressed at the program-A project. */
  function getCommits(headers: Record<string, string>, branch?: string) {
    return app.request(
      `/api/v1/sysml/projects/${designId}/commits${
        branch === undefined ? '' : `?branchId=${branch}`
      }`,
      { headers },
    )
  }

  it('refuses a branchId belonging to a project the caller cannot reach', async () => {
    const engineer = await memberWith({
      parts: ['read'],
      designs: ['read'],
    })
    const headers = await cookieFor(engineer)
    const foreign = await foreignProject()

    // The branch is real and resolvable, so the refusal below is the ownership
    // check and not absence: without it `BranchService.getById` hands the
    // handler exactly this row and the request answers 200 with B's history.
    expect((await BranchService.getById(foreign.branchId))?.designId).toBe(
      foreign.designId,
    )

    const response = await getCommits(headers, foreign.branchId)

    // 404 rather than 403, matching the two siblings in this file: an
    // unreachable branch and a nonexistent one answer identically, so the
    // status is not an existence oracle for other programs' branches.
    expect(response.status).toBe(404)
    const body = (await response.json()) as {
      error?: { code?: string }
      data?: unknown
      totalResults?: number
    }
    expect(body.error?.code).toBe(ErrorCode.RESOURCE_NOT_FOUND)
    // The invariant: neither the foreign history nor its size crossed over.
    expect(body.data).toBeUndefined()
    expect(body.totalResults).toBeUndefined()
  })

  it('serves the same caller their own branch named explicitly', async () => {
    const engineer = await memberWith({
      parts: ['read'],
      designs: ['read'],
    })

    const response = await getCommits(await cookieFor(engineer), branchId)

    // The half that proves the guard narrowed only the cross-project case:
    // same caller, same query parameter, a branch of the project in the path.
    expect(response.status).toBe(200)
    const body = (await response.json()) as { '@type'?: string }
    expect(body['@type']).toBe('CommitCollection')
  })

  it('resolves the project default branch when branchId is omitted', async () => {
    const engineer = await memberWith({
      parts: ['read'],
      designs: ['read'],
    })

    const response = await getCommits(await cookieFor(engineer))

    // The default branch is read from the path project, so it passes the same
    // ownership check the explicit id does rather than bypassing it.
    expect(response.status).toBe(200)
    const body = (await response.json()) as { '@type'?: string }
    expect(body['@type']).toBe('CommitCollection')
  })
})
