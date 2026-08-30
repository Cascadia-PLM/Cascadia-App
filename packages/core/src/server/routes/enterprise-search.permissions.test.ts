// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Legacy enterprise-search `/` — authorization gates and query bounds
 *
 * The header typeahead reads this endpoint, and it used to fan out over
 * `ItemTypeRegistry.getAllTypes()` with only the design-level `accessScope`
 * applied: a member whose role withheld read on an item type still got that
 * type's rows back, grouped and labelled, while the `/results` sibling
 * serving the same search page refused them. These tests pin both layers
 * now that the two surfaces agree:
 *
 *  - type-level RBAC: a member with no `issues:read` gets no Issue group for
 *    a matching Issue in their own design, while a full reader does — and
 *    both still see the Part, so the miss is the withheld type and not a
 *    broken search
 *  - a caller with no item read grants at all gets nothing, rather than the
 *    whole registry
 *  - design-level scoping is unchanged: an outsider holding read on every
 *    item type sees nothing from a program they are not a member of
 *  - `limit` is bounded by the same schema `/results` uses — 1000000 and a
 *    non-numeric limit are 400s, not an unbounded query and not the silent
 *    empty groups a NaN limit used to produce
 *
 * Run: npx vitest run packages/core/src/server/routes/enterprise-search.permissions.test.ts
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
import enterpriseSearchRoutes from './enterprise-search'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
  insertTestUserWithRole,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { ITEM_TYPE_RESOURCES } from '@/lib/items/item-type-resources'
import { programMembers, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { ErrorCode } from '@/lib/errors/codes'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

interface SearchGroup {
  itemType: string
  items: Array<{ id: string }>
  total: number
}

interface SearchEnvelope {
  data: { results: Array<SearchGroup> }
}

interface ErrorEnvelope {
  error: { code: string; fieldErrors?: Array<{ field: string }> }
}

/** `read` on every item-type resource, or on all but one. */
function readGrants(except?: string): Record<string, Array<string>> {
  return Object.fromEntries(
    Object.values(ITEM_TYPE_RESOURCES)
      .filter((resource) => resource !== except)
      .map((resource) => [resource, ['read']]),
  )
}

describe('enterprise-search / — authorization gates', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route(
    '/api/v1/enterprise-search',
    enterpriseSearchRoutes,
  )

  let admin: TestUser
  let fullReader: TestUser
  let noIssueReader: TestUser
  let outsider: TestUser
  let noGrants: TestUser

  let designId: string
  let partId: string
  let issueId: string
  /** Letters only: the search takes the tsquery path at 3+ characters. */
  let token: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // Users are new each test; the permission cache is process-global.
    permissionService.clearCache()

    // Uppercase: design codes are validated against /^[A-Z0-9-]+$/.
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user

    // Three readers differing on exactly one axis each: fullReader and
    // noIssueReader differ only in `issues:read` (the type gate), fullReader
    // and outsider only in program membership (the design gate).
    const fullReadRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`Full Reader ${suffix}`, readGrants()),
    )
    const noIssueRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`No Issues ${suffix}`, readGrants('issues')),
    )
    fullReader = await insertTestUser(testDb.db)
    noIssueReader = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    noGrants = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, fullReader.id, fullReadRole.id)
    await assignRoleToUser(testDb.db, noIssueReader.id, noIssueRole.id)
    await assignRoleToUser(testDb.db, outsider.id, fullReadRole.id)
    permissionService.clearCache()

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Search Perm Program',
          code: `SPROG-${suffix}`,
          createdBy: admin.id,
        })
        .returning(),
    )
    // The outsider is deliberately not a member: they hold read on every
    // item type, so anything they see comes from the design gate failing.
    await testDb.db.insert(programMembers).values(
      [fullReader, noIssueReader, noGrants].map((u) => ({
        programId: program.id,
        userId: u.id,
        role: 'engineer',
      })),
    )

    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Search Perm Design',
        code: `SDESIGN-${suffix}`,
        designType: 'Engineering',
      },
      admin.id,
    )
    designId = design.id

    // One shared, unique term so a single query matches both fixtures and
    // the two groups can be compared against each other.
    token = `zz${Array.from({ length: 8 }, () =>
      String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    ).join('')}`

    partId = (
      (await ItemService.create(
        'Part',
        {
          designId,
          revision: 'A',
          name: `${token} Part`,
          partType: 'Manufacture',
        } as never,
        admin.id,
      )) as { id: string }
    ).id
    issueId = (
      (await ItemService.create(
        'Issue',
        {
          itemType: 'Issue',
          designId,
          revision: 'A',
          name: `${token} Issue`,
        } as never,
        admin.id,
      )) as { id: string }
    ).id

    for (const user of [admin, fullReader, noIssueReader, outsider, noGrants]) {
      cookies.set(
        user.id,
        `session=${(await SessionManager.createSession(user.id)).sessionToken}`,
      )
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function search(user: TestUser, query: string): Promise<Response> {
    return await app.request(`/api/v1/enterprise-search?${query}`, {
      headers: { Cookie: cookies.get(user.id)! },
    })
  }

  async function groupsFor(
    user: TestUser,
    query = `q=${token}`,
  ): Promise<Array<SearchGroup>> {
    const res = await search(user, query)
    expect(res.status).toBe(200)
    return ((await res.json()) as SearchEnvelope).data.results
  }

  function idsIn(groups: Array<SearchGroup>): Array<string> {
    return groups.flatMap((g) => g.items.map((i) => i.id))
  }

  describe('type-level RBAC', () => {
    it('withholding issues:read hides the Issue but keeps the Part', async () => {
      // The full reader is the control: without it, an empty Issue group
      // would be indistinguishable from a search that matched nothing.
      const full = await groupsFor(fullReader)
      expect(idsIn(full)).toEqual(expect.arrayContaining([partId, issueId]))

      const withheld = await groupsFor(noIssueReader)
      expect(idsIn(withheld)).toContain(partId)
      expect(idsIn(withheld)).not.toContain(issueId)
      // The type is absent entirely, not present-but-empty: the group is
      // built from the readable registry, so the label never reaches a
      // caller who may not read it.
      expect(withheld.map((g) => g.itemType)).not.toContain('Issue')
    })

    it('a caller with no read grants gets no groups at all', async () => {
      // Fail-closed at the extreme: an empty readable set must mean an empty
      // fan-out, never a fall-through to the whole registry.
      expect(await groupsFor(noGrants)).toEqual([])
    })
  })

  describe('design-level scoping', () => {
    it('an outsider holding every read sees nothing from the program', async () => {
      // Same role as fullReader, no membership — so the type gate admits
      // every type and only `accessScope` stands between them and the rows.
      expect(idsIn(await groupsFor(outsider))).toEqual([])
    })
  })

  describe('limit bounds', () => {
    async function errorFrom(res: Response): Promise<ErrorEnvelope['error']> {
      return ((await res.json()) as ErrorEnvelope).error
    }

    it('rejects a limit past the schema ceiling', async () => {
      const res = await search(fullReader, `q=${token}&limit=1000000`)
      expect(res.status).toBe(400)
      const error = await errorFrom(res)
      expect(error.code).toBe(ErrorCode.VALIDATION_FAILED)
      expect(error.fieldErrors?.map((f) => f.field)).toContain('limit')
    })

    it('rejects a non-numeric limit rather than answering empty groups', async () => {
      const res = await search(fullReader, `q=${token}&limit=abc`)
      expect(res.status).toBe(400)
      expect((await errorFrom(res)).code).toBe(ErrorCode.VALIDATION_FAILED)
    })

    it('rejects a zero or negative limit', async () => {
      for (const limit of ['0', '-5']) {
        const res = await search(fullReader, `q=${token}&limit=${limit}`)
        expect(res.status, `limit=${limit}`).toBe(400)
      }
    })

    it('accepts the ceiling and an omitted limit', async () => {
      expect(
        idsIn(await groupsFor(fullReader, `q=${token}&limit=100`)),
      ).toEqual(expect.arrayContaining([partId, issueId]))
      expect(idsIn(await groupsFor(fullReader))).toEqual(
        expect.arrayContaining([partId, issueId]),
      )
    })

    it('still requires a non-blank query', async () => {
      for (const query of ['', 'q=', 'q=%20%20']) {
        const res = await search(fullReader, query)
        expect(res.status, `query='${query}'`).toBe(400)
      }
    })
  })
})
