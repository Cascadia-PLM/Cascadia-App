// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Items named in a request *body* are program-scoped too
 *
 * The by-id sweep closed the gap where knowing an id was enough — every route
 * that names an item in its **path** now checks reach. This is the other half:
 * a route that links, allocates or relates one item to another names the far
 * end in its body, and the body is not the path.
 *
 * That distinction is structural, not incidental. `apiHandler`'s `access:`
 * gate runs *before the body is read*, so it can only ever charge path
 * parameters; a route wanting the far end checked has to do it itself, and
 * none of these did. The service layer does not compensate — it verifies the
 * referenced item *exists*, never that the caller may reach it.
 *
 * So a caller holding the RBAC verb in their own program could name any item
 * id on the instance as the other end of a write: link a foreign part as
 * satisfying their requirement, allocate to it, attach a foreign test case,
 * or relate to it. Each wrote a real edge across a program boundary, and the
 * response distinguished a real id from a fabricated one.
 *
 * The relationship-by-id routes are the sharpest case: `PUT` and `DELETE
 * /relationships/:relationshipId` address an edge by an id that names neither
 * end, so the blanket `parts` tuple was the entire gate — any holder could
 * edit or delete any edge in the instance.
 *
 * Pinned here, per route: an outsider naming an in-program item in the body is
 * refused, and the edge is not written. The in-program caller doing the same
 * thing is not refused, so the gates bound reach rather than the feature.
 *
 * Run: npx vitest run packages/core/src/server/routes/body-item-access.permissions.test.ts
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
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import itemsRoutes from './items'
import partsRoutes from './parts'
import requirementsRoutes from './requirements'
import relationshipsRoutes from './relationships'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { itemRelationships } from '@/lib/db/schema'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('program isolation — items named in request bodies', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/items', itemsRoutes)
    .route('/api/v1/parts', partsRoutes)
    .route('/api/v1/requirements', requirementsRoutes)
    .route('/api/v1/relationships', relationshipsRoutes)

  /** Owns "home": a program the outsider is not a member of. */
  let owner: TestUser
  /** Holds the same RBAC verbs, in their own program only. */
  let outsider: TestUser

  let homeDesignId: string
  let awayDesignId: string

  /** Items in the owner's program — the ones an outsider must not reach. */
  let homePartId: string
  let homeTestCaseId: string

  /** An item in the outsider's own program, to name as the near end. */
  let awayRequirementId: string
  let awayPartId: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  async function makeProgramWithDesign(user: TestUser, label: string) {
    const program = await ProgramService.create(
      {
        name: `${label} Program`,
        code: `${label.toUpperCase()}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
      },
      user.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: `${label} Design`,
        code: `${label.toUpperCase()}D-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    return design.id
  }

  async function makeItem(
    designId: string,
    itemType: string,
    name: string,
    userId: string,
  ): Promise<string> {
    const extra =
      itemType === 'Part' ? { partType: 'Manufacture' as const } : {}
    const item = (await ItemService.create(
      itemType,
      { designId, revision: 'A', name, ...extra } as never,
      userId,
    )) as { id: string }
    return item.id
  }

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    // Power User rather than Administrator: an Administrator holds the
    // cross-program bypass, which would make every case below pass for the
    // wrong reason.
    owner = (await insertTestUserWithRole(testDb.db, 'Power User')).user
    outsider = (await insertTestUserWithRole(testDb.db, 'Power User')).user

    homeDesignId = await makeProgramWithDesign(owner, 'home')
    awayDesignId = await makeProgramWithDesign(outsider, 'away')

    homePartId = await makeItem(homeDesignId, 'Part', 'Home Part', owner.id)
    homeTestCaseId = await makeItem(
      homeDesignId,
      'TestCase',
      'Home Test Case',
      owner.id,
    )

    awayRequirementId = await makeItem(
      awayDesignId,
      'Requirement',
      'Away Requirement',
      outsider.id,
    )
    awayPartId = await makeItem(awayDesignId, 'Part', 'Away Part', outsider.id)

    cookies.clear()
    for (const u of [owner, outsider]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function as(user: TestUser) {
    const cookie = cookies.get(user.id)!
    const send = (method: string) => (path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    return {
      post: send('POST'),
      put: send('PUT'),
      del: send('DELETE'),
    }
  }

  /** Is there any stored edge touching this item? */
  async function edgeCount(itemId: string): Promise<number> {
    const asSource = await testDb.db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, itemId))
    const asTarget = await testDb.db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.targetId, itemId))
    return asSource.length + asTarget.length
  }

  const denied = (status: number) => status === 403 || status === 404

  describe('a foreign item named in the body is refused', () => {
    it('POST /requirements/:id/satisfy', async () => {
      const before = await edgeCount(homePartId)

      const res = await as(outsider).post(
        `/api/v1/requirements/${awayRequirementId}/satisfy`,
        { itemIds: [homePartId] },
      )

      expect(denied(res.status)).toBe(true)
      expect(await edgeCount(homePartId)).toBe(before)
    })

    it('POST /requirements/:id/allocate', async () => {
      const before = await edgeCount(homePartId)

      const res = await as(outsider).post(
        `/api/v1/requirements/${awayRequirementId}/allocate`,
        { itemIds: [homePartId] },
      )

      expect(denied(res.status)).toBe(true)
      expect(await edgeCount(homePartId)).toBe(before)
    })

    it('POST /requirements/:id/verify', async () => {
      const before = await edgeCount(homeTestCaseId)

      const res = await as(outsider).post(
        `/api/v1/requirements/${awayRequirementId}/verify`,
        { testCaseIds: [homeTestCaseId] },
      )

      expect(denied(res.status)).toBe(true)
      expect(await edgeCount(homeTestCaseId)).toBe(before)
    })

    it('POST /parts/:id/validate', async () => {
      const before = await edgeCount(homeTestCaseId)

      const res = await as(outsider).post(
        `/api/v1/parts/${awayPartId}/validate`,
        { testCaseIds: [homeTestCaseId] },
      )

      expect(denied(res.status)).toBe(true)
      expect(await edgeCount(homeTestCaseId)).toBe(before)
    })

    it('POST /items/:id/relationships', async () => {
      const before = await edgeCount(homePartId)

      const res = await as(outsider).post(
        `/api/v1/items/${awayPartId}/relationships`,
        { targetId: homePartId, relationshipType: 'BOM' },
      )

      expect(denied(res.status)).toBe(true)
      expect(await edgeCount(homePartId)).toBe(before)
    })

    it('POST /relationships/batch-create', async () => {
      const before = await edgeCount(homePartId)

      const res = await as(outsider).post(
        '/api/v1/relationships/batch-create',
        {
          relationships: [
            {
              sourceId: awayPartId,
              targetId: homePartId,
              relationshipType: 'BOM',
            },
          ],
        },
      )

      expect(denied(res.status)).toBe(true)
      expect(await edgeCount(homePartId)).toBe(before)
    })
  })

  describe('an edge addressed by its own id', () => {
    /** An edge wholly inside the owner's program. */
    async function homeEdgeId(): Promise<string> {
      const child = await makeItem(homeDesignId, 'Part', 'Home Child', owner.id)
      await ItemService.addRelationship(homePartId, child, 'BOM', owner.id, {})
      const [edge] = await testDb.db
        .select()
        .from(itemRelationships)
        .where(
          and(
            eq(itemRelationships.sourceId, homePartId),
            eq(itemRelationships.targetId, child),
          ),
        )
      return edge!.id
    }

    it('is not editable by an outsider', async () => {
      const edgeId = await homeEdgeId()

      const res = await as(outsider).put(`/api/v1/relationships/${edgeId}`, {
        quantity: '999',
      })

      expect(denied(res.status)).toBe(true)

      const [after] = await testDb.db
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.id, edgeId))
      expect(after?.quantity ?? null).not.toBe('999')
    })

    it('is not deletable by an outsider', async () => {
      const edgeId = await homeEdgeId()

      const res = await as(outsider).del(`/api/v1/relationships/${edgeId}`)

      expect(denied(res.status)).toBe(true)

      const rows = await testDb.db
        .select()
        .from(itemRelationships)
        .where(eq(itemRelationships.id, edgeId))
      expect(rows).toHaveLength(1)
    })
  })

  describe('the same writes inside the caller’s own program', () => {
    it('are not refused for reach', async () => {
      const res = await as(outsider).post(
        `/api/v1/requirements/${awayRequirementId}/satisfy`,
        { itemIds: [awayPartId] },
      )

      // The point is the *absence* of a reach refusal — the route may still
      // answer for its own reasons, but never 403/404.
      expect(denied(res.status)).toBe(false)
    })
  })
})
