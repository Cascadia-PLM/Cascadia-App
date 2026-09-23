// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Reading a design at a version context — security-gate tests
 *
 * Three reads show a design's contents at a version context the query string
 * names: the design's structure (`branch`, `tag` or `commit`), its item list
 * (`tag` or `commit`), and the item list filtered to it (`GET /items` with
 * `designId` and `tag` or `commit`). Each charged the caller against the
 * design and then resolved the context without asking whose it was. A
 * branch's rows, a commit's ancestry and a tag's commit each belong to one
 * design, so another design's context resolved to that design's contents, and
 * the read served them as this design's. A member of one program could name a
 * workspace branch in another and read its drafts back — item numbers, names,
 * revisions, states — through a design they were allowed to open.
 *
 * The invariants:
 *
 *  - a version context a design read names must be one of that design's own
 *  - another design's is answered exactly as one that does not exist, so the
 *    status is no oracle for which ids are real, and the refusal carries
 *    nothing the context holds
 *  - the rule is ownership, not reach: a caller who can read both designs is
 *    refused too, because the answer would still be the other design's
 *    contents presented as this one's
 *  - a context of the design itself still resolves
 *
 * Run: npx vitest run cascadia-api/src/server/routes/designs.version-context.permissions.test.ts
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
import designsRoutes from './designs'
import itemsRoutes from './items'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/items/services/ItemService'
import { ItemTypeRegistry } from '@/items/registry'
import { BranchService } from '@/services/BranchService'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { tags } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

// Import to register item types
import '@/items/registerItemTypes.server'

type ContextKind = 'branch' | 'tag' | 'commit'

/**
 * A design's workspace branch, holding a draft part created in a commit on
 * that branch, and a tag naming that commit. The draft is on neither design's
 * main, so a read that shows it resolved one of these contexts.
 */
interface DraftContexts {
  ids: Record<ContextKind, string>
  draft: { itemNumber: string; name: string }
  branchName: string
  tagName: string
}

describe('reading a design at a version context', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/designs', designsRoutes)
    .route('/api/v1/items', itemsRoutes)

  let progAdmin: TestUser // created both programs, so a member of each
  let engineer: TestUser // a member of the home program only

  let homeDesignId: string
  let foreignDesignId: string
  let foreignDesignCode: string

  let home: DraftContexts
  let foreign: DraftContexts

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    progAdmin = (await insertTestUserWithRole(testDb.db, 'User')).user
    engineer = (await insertTestUserWithRole(testDb.db, 'User')).user

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    const homeProgram = await ProgramService.create(
      { name: 'Home Program', code: `VCH-${unique}` },
      progAdmin.id,
    )
    const foreignProgram = await ProgramService.create(
      { name: 'Foreign Program', code: `VCF-${unique}` },
      progAdmin.id,
    )
    await ProgramService.addMember(
      homeProgram.id,
      engineer.id,
      'engineer',
      progAdmin.id,
    )

    homeDesignId = (
      await DesignService.create(
        {
          programId: homeProgram.id,
          name: 'Home Design',
          code: `VCHOME-${unique}`,
          designType: 'Engineering',
        },
        progAdmin.id,
      )
    ).id
    foreignDesignCode = `VCFGN-${unique}`
    foreignDesignId = (
      await DesignService.create(
        {
          programId: foreignProgram.id,
          name: 'Foreign Design',
          code: foreignDesignCode,
          designType: 'Engineering',
        },
        progAdmin.id,
      )
    ).id

    home = await draftInContexts(homeDesignId, `VCHOME-${unique}`)
    foreign = await draftInContexts(foreignDesignId, `VCFGN-${unique}`)

    cookies.clear()
    for (const u of [progAdmin, engineer]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function draftInContexts(
    designId: string,
    label: string,
  ): Promise<DraftContexts> {
    const branch = await BranchService.createWorkspaceBranch(
      designId,
      progAdmin.id,
      label,
    )
    const draft = { itemNumber: `${label}-DRAFT`, name: `${label} Draft Part` }
    const { commit } = await ItemService.createOnBranch(
      'Part',
      { ...draft, designId, partType: 'Manufacture' } as never,
      branch.id,
      'Drafted on workspace',
      progAdmin.id,
    )
    // Written directly: `DesignService.createTag` always tags main's head, and
    // this tag has to name the commit holding the draft.
    const tagName = `${label}-TAG`
    const tag = takeFirst(
      await testDb.db
        .insert(tags)
        .values({
          designId,
          name: tagName,
          commitId: commit.id,
          createdBy: progAdmin.id,
        })
        .returning(),
    )
    return {
      ids: { branch: branch.id, tag: tag.id, commit: commit.id },
      draft,
      branchName: branch.name,
      tagName,
    }
  }

  async function read(user: TestUser, path: string) {
    const res = await app.request(path, {
      headers: { Cookie: cookies.get(user.id)! },
    })
    const text = await res.text()
    const body = JSON.parse(text) as { error?: { code?: string } }
    return { status: res.status, text, code: body.error?.code }
  }

  const reads: Array<{
    label: string
    kinds: Array<ContextKind>
    path: (designId: string, kind: ContextKind, id: string) => string
  }> = [
    {
      label: 'GET /designs/:id/structure',
      kinds: ['branch', 'tag', 'commit'],
      path: (designId, kind, id) =>
        `/api/v1/designs/${designId}/structure?${kind}=${id}`,
    },
    {
      // Its `branch` parameter is accepted and never read.
      label: 'GET /designs/:id/items',
      kinds: ['tag', 'commit'],
      path: (designId, kind, id) =>
        `/api/v1/designs/${designId}/items?${kind}=${id}`,
    },
    {
      // Its `branch` parameter is a name, looked up within the design.
      label: 'GET /items filtered to a design',
      kinds: ['tag', 'commit'],
      path: (designId, kind, id) =>
        `/api/v1/items?designId=${designId}&${kind}=${id}`,
    },
  ]

  for (const route of reads) {
    describe(route.label, () => {
      for (const kind of route.kinds) {
        it(`refuses another design’s ${kind} as one that does not exist, and serves nothing of it`, async () => {
          const refused = await read(
            engineer,
            route.path(homeDesignId, kind, foreign.ids[kind]),
          )
          expect(refused.status).toBe(404)
          for (const echo of [
            foreign.draft.itemNumber,
            foreign.draft.name,
            foreign.branchName,
            foreign.tagName,
            foreignDesignCode,
          ]) {
            expect(refused.text).not.toContain(echo)
          }

          const missing = await read(
            engineer,
            route.path(homeDesignId, kind, randomUUID()),
          )
          expect(missing.status).toBe(refused.status)
          expect(missing.code).toBe(refused.code)
        })

        it(`refuses another design’s ${kind} to a caller who can read both designs`, async () => {
          const refused = await read(
            progAdmin,
            route.path(homeDesignId, kind, foreign.ids[kind]),
          )
          expect(refused.status).toBe(404)
          expect(refused.text).not.toContain(foreign.draft.itemNumber)
        })

        // The over-refusal guard. A gate that refused every context would
        // satisfy both tests above and break the version picker, so what a
        // design's own context shows is pinned as hard as what another's may
        // not.
        it(`still reads the design at a ${kind} of its own`, async () => {
          const own = await read(
            engineer,
            route.path(homeDesignId, kind, home.ids[kind]),
          )
          expect(own.status).toBe(200)
          expect(own.text).toContain(home.draft.itemNumber)
        })
      }
    })
  }

  // Guards the fixture rather than the routes. The refusals prove nothing
  // unless the foreign design is out of the engineer's reach and each of its
  // contexts really holds the draft, and the own-context reads prove nothing
  // if the draft were on main, where no context is needed to see it.
  it('uses a foreign design out of the engineer’s reach, with the draft in each context and not on main', async () => {
    expect(
      (await read(engineer, `/api/v1/designs/${foreignDesignId}/structure`))
        .status,
    ).toBe(403)

    for (const kind of ['branch', 'tag', 'commit'] as const) {
      const atContext = await read(
        progAdmin,
        `/api/v1/designs/${foreignDesignId}/structure?${kind}=${foreign.ids[kind]}`,
      )
      expect(atContext.status, kind).toBe(200)
      expect(atContext.text, kind).toContain(foreign.draft.itemNumber)
    }

    const onMain = await read(
      engineer,
      `/api/v1/designs/${homeDesignId}/structure`,
    )
    expect(onMain.status).toBe(200)
    expect(onMain.text).not.toContain(home.draft.itemNumber)
  })
})
