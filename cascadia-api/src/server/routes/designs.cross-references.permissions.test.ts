// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Bringing another design's item into a design — security-gate tests
 *
 * A design takes in items from elsewhere three ways: a cross-design reference
 * (`PUT /cross-references`, or `POST /items` with `mode: 'cross_design_ref'`),
 * a usage copy (`POST /items`), and a pull-in, which turns a referenced chain
 * into usage copies (`POST /cross-references`). Each one charged the caller
 * against the design in the path and nothing else. A member of one program who
 * knew an item's id in another could bring it in, then read it back through
 * the design they could open: its number, name, revision and state, and its
 * design's code and name, from the references list; its BOM subtree from the
 * structure; every field of it from a usage copy.
 *
 * The invariants:
 *
 *  - every item a request names, and every item a usage copy would copy, must
 *    be one the caller can read
 *  - an id that names nothing is refused exactly as an unreadable item is, so
 *    the answer is no oracle for what exists in a program the caller cannot
 *    open: 403 to everyone but cross-program authority, which could read the
 *    item if it existed and so is told 404 — the rule an unknown change-order
 *    id already follows in `program-isolation.permissions.test.ts`
 *  - a refusal writes nothing, and echoes nothing of the item it refused
 *  - the other ids these requests carry — a reference to remove, a BOM line to
 *    re-point, a branch — must name this design's own rows, and another
 *    design's answers as one that does not exist
 *
 * Run: npx vitest run cascadia-api/src/server/routes/designs.cross-references.permissions.test.ts
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
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import designsRoutes from './designs'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/items/services/ItemService'
import { ItemTypeRegistry } from '@/items/registry'
import { BranchService } from '@/services/BranchService'
import { CrossDesignReferenceService } from '@/services/CrossDesignReferenceService'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import {
  branchItems,
  designCrossReferences,
  itemRelationships,
  items,
} from '@/db/schema'
import { takeFirst } from '@/db/take-first'

// Import to register item types
import '@/items/registerItemTypes.server'

interface Part {
  id: string
  itemNumber: string
  name: string
}

describe('bringing another design’s item into a design', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/designs', designsRoutes)

  let sysAdmin: TestUser // cross-program authority
  let progAdmin: TestUser // created both programs, so a member of each
  let engineer: TestUser // a member of the home program only

  let homeDesignId: string
  let foreignDesignId: string
  let foreignDesignCode: string

  let foreignPart: Part // the foreign program, with a BOM child
  let foreignChild: Part
  let foreignLineId: string // foreignPart → foreignChild
  let siblingPart: Part // the home program, in another of its designs
  let libraryPart: Part // a design with no program, which everyone reads
  let mixedAssembly: Part // the home program, with a line into the foreign one

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

    sysAdmin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    progAdmin = (await insertTestUserWithRole(testDb.db, 'User')).user
    engineer = (await insertTestUserWithRole(testDb.db, 'User')).user

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    const homeProgram = await ProgramService.create(
      { name: 'Home Program', code: `XRH-${unique}` },
      progAdmin.id,
    )
    const foreignProgram = await ProgramService.create(
      { name: 'Foreign Program', code: `XRF-${unique}` },
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
          code: `XRHOME-${unique}`,
          designType: 'Engineering',
        },
        progAdmin.id,
      )
    ).id
    const siblingDesignId = (
      await DesignService.create(
        {
          programId: homeProgram.id,
          name: 'Sibling Design',
          code: `XRSIB-${unique}`,
          designType: 'Engineering',
        },
        progAdmin.id,
      )
    ).id
    foreignDesignCode = `XRFGN-${unique}`
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
    const libraryDesignId = (
      await DesignService.create(
        {
          programId: null,
          name: 'Shared Library',
          code: `XRLIB-${unique}`,
          designType: 'Library',
        },
        progAdmin.id,
      )
    ).id

    const mkPart = async (designId: string, label: string): Promise<Part> => {
      const itemNumber = `${label}-${unique}`
      const name = `${label} Part ${unique}`
      const part = (await ItemService.create(
        'Part',
        {
          designId,
          revision: 'A',
          name,
          itemNumber,
          partType: 'Manufacture',
        } as never,
        progAdmin.id,
      )) as { id: string }
      return { id: part.id, itemNumber, name }
    }

    foreignPart = await mkPart(foreignDesignId, 'FGNPART')
    foreignChild = await mkPart(foreignDesignId, 'FGNCHILD')
    siblingPart = await mkPart(siblingDesignId, 'SIBPART')
    libraryPart = await mkPart(libraryDesignId, 'LIBPART')
    mixedAssembly = await mkPart(siblingDesignId, 'MIXASSY')

    // Written directly: what matters is that such lines exist, not who wrote
    // them. The second is one only someone reaching both programs could make.
    foreignLineId = (await bomLine(foreignPart.id, foreignChild.id)).id
    await bomLine(mixedAssembly.id, foreignPart.id)

    cookies.clear()
    for (const u of [sysAdmin, progAdmin, engineer]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function bomLine(sourceId: string, targetId: string) {
    return takeFirst(
      await testDb.db
        .insert(itemRelationships)
        .values({
          sourceId,
          targetId,
          relationshipType: 'BOM',
          quantity: '1',
          createdBy: progAdmin.id,
          modifiedBy: progAdmin.id,
        })
        .returning(),
    )
  }

  function as(user: TestUser) {
    const cookie = cookies.get(user.id)!
    return {
      get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
      post: (path: string, body: unknown) =>
        app.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify(body),
        }),
      put: (path: string, body: unknown) =>
        app.request(path, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify(body),
        }),
      del: (path: string) =>
        app.request(path, { method: 'DELETE', headers: { Cookie: cookie } }),
    }
  }

  const homePath = (path: string) => `/api/v1/designs/${homeDesignId}${path}`

  async function errorCode(res: Response) {
    const body = (await res.json()) as { error?: { code?: string } }
    return body.error?.code
  }

  /** What a request into the home design can leave behind there. */
  async function homeFootprint() {
    const references = await testDb.db
      .select({ id: designCrossReferences.id })
      .from(designCrossReferences)
      .where(eq(designCrossReferences.referencingDesignId, homeDesignId))
    const homeItems = await testDb.db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.designId, homeDesignId))
    return { references: references.length, items: homeItems.length }
  }

  // ==========================================================================
  // The item a request names
  // ==========================================================================

  const bringIn = [
    {
      label: 'PUT /cross-references',
      send: (user: TestUser, itemId: string) =>
        as(user).put(homePath('/cross-references'), {
          referencedItemId: itemId,
        }),
    },
    {
      label: 'POST /items as a reference',
      send: (user: TestUser, itemId: string) =>
        as(user).post(homePath('/items'), {
          itemId,
          mode: 'cross_design_ref',
        }),
    },
    {
      label: 'POST /items as a usage copy',
      send: (user: TestUser, itemId: string) =>
        as(user).post(homePath('/items'), { itemId, mode: 'usage_copy' }),
    },
    {
      label: 'POST /cross-references pulling in a chain',
      send: (user: TestUser, itemId: string) =>
        as(user).post(homePath('/cross-references'), { itemIds: [itemId] }),
    },
  ]

  for (const route of bringIn) {
    describe(route.label, () => {
      it('refuses an item in a program the caller cannot read, and writes nothing', async () => {
        const before = await homeFootprint()

        const res = await route.send(engineer, foreignPart.id)
        expect(res.status).toBe(403)

        const text = await res.text()
        expect(text).not.toContain(foreignPart.itemNumber)
        expect(text).not.toContain(foreignPart.name)
        expect(text).not.toContain(foreignDesignCode)
        expect(await homeFootprint()).toEqual(before)
      })

      it('answers an id that names nothing exactly as it answers that item', async () => {
        const unreadable = await route.send(engineer, foreignPart.id)
        const missing = await route.send(engineer, randomUUID())

        expect(missing.status).toBe(unreadable.status)
        expect(await errorCode(missing)).toBe(await errorCode(unreadable))
      })

      it('admits cross-program authority, which is told an unknown id is missing', async () => {
        expect((await route.send(sysAdmin, foreignPart.id)).status).toBe(200)
        expect((await route.send(sysAdmin, randomUUID())).status).toBe(404)
      })

      // The over-refusal guard. A gate that refused every other design's item
      // would satisfy each leg above and break the feature, so what a member
      // may bring in is pinned as hard as what they may not.
      it('still brings in an item from the caller’s own program, and one from a design with no program', async () => {
        expect((await route.send(engineer, siblingPart.id)).status).toBe(200)
        expect((await route.send(engineer, libraryPart.id)).status).toBe(200)
      })
    })
  }

  // The read the refusal exists for. Before the gate, the reference was
  // accepted and these two reads handed the other program's part back.
  it('leaves a refused item out of the references list and the structure', async () => {
    await as(engineer).put(homePath('/cross-references'), {
      referencedItemId: foreignPart.id,
    })

    for (const path of ['/cross-references', '/structure']) {
      const res = await as(engineer).get(homePath(path))
      expect(res.status, path).toBe(200)
      const text = await res.text()
      expect(text, path).not.toContain(foreignPart.itemNumber)
      expect(text, path).not.toContain(foreignChild.itemNumber)
      expect(text, path).not.toContain(foreignDesignCode)
    }
  })

  // ==========================================================================
  // What a usage copy copies
  //
  // The body names one item, and the copy takes its whole BOM subtree: every
  // item under it becomes a usage in this design, carrying its definition's
  // fields. So each of them is read, and each is charged.
  // ==========================================================================

  describe('a usage copy of an assembly', () => {
    it('refuses one whose BOM holds an item the caller cannot read, and writes nothing', async () => {
      const before = await homeFootprint()

      // The assembly itself is in the caller's own program, so the refusal
      // can only be for what is under it.
      const res = await as(engineer).post(homePath('/items'), {
        itemId: mixedAssembly.id,
        mode: 'usage_copy',
      })
      expect(res.status).toBe(403)

      const text = await res.text()
      expect(text).not.toContain(foreignPart.itemNumber)
      expect(text).not.toContain(foreignChild.itemNumber)
      expect(await homeFootprint()).toEqual(before)
    })

    it('copies the same assembly for a member of both programs', async () => {
      const res = await as(progAdmin).post(homePath('/items'), {
        itemId: mixedAssembly.id,
        mode: 'usage_copy',
      })
      expect(res.status).toBe(200)
    })
  })

  // ==========================================================================
  // A reference already in the design
  //
  // How it came to be there does not matter — made before references were
  // charged, or by someone who reaches both programs. Pulling it in copies the
  // item it names, which is a read of that item.
  // ==========================================================================

  describe('pulling in a reference the design already holds', () => {
    it('refuses one naming an item the caller cannot read, and leaves it in place', async () => {
      const held = await CrossDesignReferenceService.createReference(
        { referencingDesignId: homeDesignId, referencedItemId: foreignPart.id },
        progAdmin.id,
      )
      const before = await homeFootprint()

      const res = await as(engineer).post(homePath('/cross-references'), {
        refId: held.id,
      })
      expect(res.status).toBe(403)
      expect(await homeFootprint()).toEqual(before)
    })
  })

  // ==========================================================================
  // Ids naming another design's rows
  //
  // A reference, a BOM line and a branch each belong to one design, and these
  // requests act on the design in their path. Taking such an id on trust let a
  // member of any design remove another program's reference, re-point a line
  // of its BOM, or write into one of its branches.
  // ==========================================================================

  describe('ids naming another design’s rows', () => {
    let foreignReferenceId: string
    let homeReferenceId: string
    let foreignBranchId: string
    let homeBranchId: string

    beforeEach(async () => {
      foreignReferenceId = (
        await CrossDesignReferenceService.createReference(
          {
            referencingDesignId: foreignDesignId,
            referencedItemId: libraryPart.id,
          },
          progAdmin.id,
        )
      ).id
      homeReferenceId = (
        await CrossDesignReferenceService.createReference(
          {
            referencingDesignId: homeDesignId,
            referencedItemId: libraryPart.id,
          },
          progAdmin.id,
        )
      ).id
      foreignBranchId = (
        await BranchService.createWorkspaceBranch(
          foreignDesignId,
          progAdmin.id,
          `foreign-${randomUUID()}`,
        )
      ).id
      homeBranchId = (
        await BranchService.createWorkspaceBranch(
          homeDesignId,
          engineer.id,
          `home-${randomUUID()}`,
        )
      ).id
    })

    async function referenceExists(id: string) {
      const rows = await testDb.db
        .select({ id: designCrossReferences.id })
        .from(designCrossReferences)
        .where(eq(designCrossReferences.id, id))
      return rows.length === 1
    }

    /** Rows of either kind a write on a branch leaves on it. */
    async function rowsOnBranch(branchId: string) {
      const references = await testDb.db
        .select({ id: designCrossReferences.id })
        .from(designCrossReferences)
        .where(eq(designCrossReferences.branchId, branchId))
      const tracked = await testDb.db
        .select({ id: branchItems.id })
        .from(branchItems)
        .where(eq(branchItems.branchId, branchId))
      return references.length + tracked.length
    }

    it('DELETE /cross-references answers another design’s reference as one that does not exist, and leaves it', async () => {
      const res = await as(engineer).del(
        homePath(`/cross-references?refId=${foreignReferenceId}`),
      )
      expect(res.status).toBe(404)
      expect(await referenceExists(foreignReferenceId)).toBe(true)

      const missing = await as(engineer).del(
        homePath(`/cross-references?refId=${randomUUID()}`),
      )
      expect(missing.status).toBe(res.status)
    })

    it('DELETE /cross-references still removes the design’s own reference', async () => {
      const res = await as(engineer).del(
        homePath(`/cross-references?refId=${homeReferenceId}`),
      )
      expect(res.status).toBe(200)
      expect(await referenceExists(homeReferenceId)).toBe(false)
    })

    it('a pull-in leaves another design’s reference alone, answering as it does for one that does not exist', async () => {
      const foreign = await as(engineer).post(homePath('/cross-references'), {
        refId: foreignReferenceId,
        itemIds: [libraryPart.id],
      })
      expect(await referenceExists(foreignReferenceId)).toBe(true)

      const missing = await as(engineer).post(homePath('/cross-references'), {
        refId: randomUUID(),
        itemIds: [libraryPart.id],
      })
      expect(foreign.status).toBe(missing.status)
    })

    it('a pull-in still removes the design’s own reference', async () => {
      const res = await as(engineer).post(homePath('/cross-references'), {
        refId: homeReferenceId,
      })
      expect(res.status).toBe(200)
      expect(await referenceExists(homeReferenceId)).toBe(false)
    })

    it('a pull-in refuses to re-point another design’s BOM line, and writes nothing', async () => {
      const before = await homeFootprint()

      const res = await as(engineer).post(homePath('/cross-references'), {
        itemIds: [libraryPart.id],
        parentBomRelationshipId: foreignLineId,
      })
      expect(res.status).toBe(404)

      const line = await testDb.db
        .select({ targetId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(eq(itemRelationships.id, foreignLineId))
        .then((r) => r.at(0))
      expect(line?.targetId).toBe(foreignChild.id)
      expect(await homeFootprint()).toEqual(before)

      const missing = await as(engineer).post(homePath('/cross-references'), {
        itemIds: [libraryPart.id],
        parentBomRelationshipId: randomUUID(),
      })
      expect(missing.status).toBe(res.status)
    })

    it('a pull-in still re-points a line of the design’s own BOM', async () => {
      const homeAssembly = (await ItemService.create(
        'Part',
        {
          designId: homeDesignId,
          revision: 'A',
          name: 'Home Assembly',
          itemNumber: `HOMEASSY-${randomUUID()}`,
          partType: 'Manufacture',
        } as never,
        progAdmin.id,
      )) as { id: string }
      const homeLine = await bomLine(homeAssembly.id, libraryPart.id)

      const res = await as(engineer).post(homePath('/cross-references'), {
        itemIds: [libraryPart.id],
        parentBomRelationshipId: homeLine.id,
      })
      expect(res.status).toBe(200)

      const line = await testDb.db
        .select({ targetId: itemRelationships.targetId })
        .from(itemRelationships)
        .where(eq(itemRelationships.id, homeLine.id))
        .then((r) => r.at(0))
      expect(line?.targetId).not.toBe(libraryPart.id)
    })

    const onBranch = [
      {
        label: 'PUT /cross-references',
        send: (branchId: string) =>
          as(engineer).put(homePath('/cross-references'), {
            referencedItemId: siblingPart.id,
            branchId,
          }),
      },
      {
        label: 'POST /items as a reference',
        send: (branchId: string) =>
          as(engineer).post(homePath('/items'), {
            itemId: siblingPart.id,
            mode: 'cross_design_ref',
            branchId,
          }),
      },
      {
        label: 'POST /items as a usage copy',
        send: (branchId: string) =>
          as(engineer).post(homePath('/items'), {
            itemId: siblingPart.id,
            mode: 'usage_copy',
            branchId,
          }),
      },
      {
        label: 'POST /cross-references',
        send: (branchId: string) =>
          as(engineer).post(homePath('/cross-references'), {
            refId: homeReferenceId,
            branchId,
          }),
      },
      {
        label: 'DELETE /cross-references',
        send: (branchId: string) =>
          as(engineer).del(
            homePath(
              `/cross-references?refId=${homeReferenceId}&branch=${branchId}`,
            ),
          ),
      },
    ]

    for (const route of onBranch) {
      it(`${route.label} refuses a branch of another design as one that does not exist, and writes nothing to it`, async () => {
        const before = await rowsOnBranch(foreignBranchId)

        const res = await route.send(foreignBranchId)
        expect(res.status).toBe(404)
        expect(await rowsOnBranch(foreignBranchId)).toBe(before)
        expect(await referenceExists(homeReferenceId)).toBe(true)

        expect((await route.send(randomUUID())).status).toBe(res.status)
      })

      it(`${route.label} still accepts a branch of this design`, async () => {
        expect((await route.send(homeBranchId)).status).toBe(200)
      })
    }

    // Guards the fixture rather than the routes: a foreign branch that did
    // not belong to the foreign design would make every refusal above prove
    // nothing about ownership.
    it('uses branches that belong to the designs they are named for', async () => {
      expect((await BranchService.getById(foreignBranchId))?.designId).toBe(
        foreignDesignId,
      )
      expect((await BranchService.getById(homeBranchId))?.designId).toBe(
        homeDesignId,
      )
    })
  })
})
