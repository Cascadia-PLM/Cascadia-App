// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * SysML commit collection — paging bounds and the collection total
 *
 * The invariant a paging client depends on: `totalResults` describes the
 * collection, not the page. The commit collection reported
 * `sysmlCommits.length` — the size of the slice it had just fetched — so it
 * equalled `pageSize` on every full page and dropped to the remainder on the
 * last one. A client walking `pageStart` until `pageStart >= totalResults`
 * therefore never reached the end of a branch, and one that trusted the
 * number saw a branch whose history was exactly one page long.
 *
 * The paging bounds are the second half: `pageSize`/`pageStart` were read with
 * a bare `parseInt`, so garbage became NaN and a negative start was passed
 * through to the database untouched.
 *
 * Run: npx vitest run packages/core/src/server/routes/sysml.pagination.test.ts
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
import { CommitService } from '@/lib/services/CommitService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'

interface CommitCollection {
  data: Array<{ '@id': string }>
  pageSize: number
  pageStart: number
  totalResults: number
}

/** Commits on the branch: the one the design was created with, plus these. */
const EXTRA_COMMITS = 6
const PAGE_SIZE = 3

describe('GET /sysml/projects/:id/commits — paging', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/sysml', sysmlRoutes)

  let user: TestUser
  let cookie: string
  let designId: string
  let branchId: string
  let totalCommits: number

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    user = await insertTestUser(testDb.db)
    const role = await insertTestRole(
      testDb.db,
      createCustomTestRole(`SysML Pager ${randomUUID().slice(0, 8)}`, {
        designs: ['create', 'read'],
        programs: ['read'],
      }),
    )
    await assignRoleToUser(testDb.db, user.id, role.id)
    permissionService.clearCache()

    // The creator is enrolled as a program admin, which is what carries design
    // access to the route.
    const program = await ProgramService.create(
      {
        name: 'SysML Paging Program',
        code: `SMLP-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      user.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'SysML Paging Design',
        code: `SMLPD-${Date.now()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id
    const mainBranch = design.mainBranch
    if (!mainBranch) throw new Error('design fixture has no main branch')
    branchId = mainBranch.id

    // Commits carrying no item changes: this suite is about how many rows the
    // branch has, not what they contain.
    for (let i = 0; i < EXTRA_COMMITS; i++) {
      await CommitService.create(
        { branchId, message: `Paging commit ${i + 1}`, itemChanges: [] },
        user.id,
      )
    }
    totalCommits = await CommitService.countByBranch(branchId)

    const { sessionToken } = await SessionManager.createSession(user.id)
    cookie = `session=${sessionToken}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function getCommits(query: string) {
    return app.request(
      `/api/v1/sysml/projects/${designId}/commits?branchId=${branchId}&${query}`,
      {
        method: 'GET',
        headers: { Cookie: cookie, Origin: 'http://localhost' },
      },
    )
  }

  it('reports the branch total on every page, not the page length', async () => {
    // More commits than fit on a page, so the last page is a partial one.
    expect(totalCommits).toBeGreaterThan(PAGE_SIZE)

    const seen = new Set<string>()
    for (
      let pageStart = 0;
      pageStart < totalCommits + PAGE_SIZE;
      pageStart += PAGE_SIZE
    ) {
      const response = await getCommits(
        `pageSize=${PAGE_SIZE}&pageStart=${pageStart}`,
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as CommitCollection

      // The invariant: the total describes the branch, whichever page is asked
      // for — including the page past the end, which is empty.
      expect(body.totalResults).toBe(totalCommits)
      expect(body.data.length).toBe(
        Math.max(0, Math.min(PAGE_SIZE, totalCommits - pageStart)),
      )
      for (const commit of body.data) seen.add(commit['@id'])
    }

    // Walking the pages by the reported total visits every commit exactly once.
    expect(seen.size).toBe(totalCommits)
  })

  it('answers an out-of-range page empty, with the same total', async () => {
    const response = await getCommits(`pageSize=${PAGE_SIZE}&pageStart=10000`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as CommitCollection
    expect(body.data).toEqual([])
    expect(body.totalResults).toBe(totalCommits)
  })

  it('rejects unparseable and out-of-bounds paging instead of paging on NaN', async () => {
    expect((await getCommits('pageSize=abc')).status).toBe(400)
    expect((await getCommits('pageStart=-1')).status).toBe(400)
    expect((await getCommits('pageSize=0')).status).toBe(400)
    expect((await getCommits('pageSize=100000')).status).toBe(400)
  })
})
