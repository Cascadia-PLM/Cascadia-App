// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Reading another program's items back through a design's structure —
 * security-gate tests
 *
 * A design holds two kinds of pointer into other designs: a cross-design
 * reference, and a BOM line whose child lives elsewhere. Three reads follow
 * them, and each one charged the caller against the design in the path and
 * nothing else:
 *
 *  - `GET /designs/:id/cross-references` joins in every referenced item's
 *    number, name, revision, state and type, and its design's code and name
 *  - `GET /designs/:id/structure` expands every reference root and every
 *    external BOM child, with the whole subtree under each
 *  - `GET /change-orders/:id/designs/:designId/structure` builds the same tree
 *    from a change order's branch
 *
 * So a reference or a BOM line into a program the viewer cannot open showed
 * that program's item to everyone who could open the design holding it.
 *
 * The invariants:
 *
 *  - no read names an item the caller cannot read, or the design that holds
 *    it — its id, number, name, or its design's id, code and name
 *  - nor anything reached only through such an item: its BOM is its own, even
 *    where a child sits in a design the caller could read on its own
 *  - what is withheld is not dropped silently: one `hasRestricted` flag says
 *    something was, and nothing says how much — the rule a change order
 *    spanning two programs follows in `program-isolation.permissions.test.ts`
 *  - the flag stays down where nothing was withheld
 *  - what the caller can read is still shown, from their own program's other
 *    designs and from designs with no program at all
 *  - a caller who reaches both programs, and cross-program authority, still
 *    see the whole structure, unflagged — which is also what proves the
 *    fixture renders the items every refusal above is about
 *  - on a change order's view the flag also carries what the change order
 *    withholds elsewhere, as its summary does
 *
 * The change-order route's own gates — the change order, its affected items,
 * the branches it resolves at, the design being one of its own — are pinned
 * in `change-orders.design-structure.permissions.test.ts`. This file pins
 * what the trees show.
 *
 * Run: npx vitest run cascadia-api/src/server/routes/design-structure-isolation.permissions.test.ts
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
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import designsRoutes from './designs'
import changeOrdersRoutes from './change-orders'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BOMTreeNode } from '@cascadia/commons/types/bom'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/items/services/ItemService'
import { ChangeOrderService } from '@/items/services/ChangeOrderService'
import { ItemTypeRegistry } from '@/items/registry'
import { CrossDesignReferenceService } from '@/services/CrossDesignReferenceService'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { designCrossReferences, itemRelationships, items } from '@/db/schema'

// Import to register item types
import '@/items/registerItemTypes.server'

interface Part {
  id: string
  itemNumber: string
  name: string
}

interface ReferenceList {
  data: {
    references: Array<{ referencedItemId: string }>
    hasRestricted: boolean
  }
}

interface Structure {
  data: {
    roots: Array<BOMTreeNode>
    hasRestricted: boolean
  }
}

describe('design structure reads across a program boundary', () => {
  const testDb = new TestDatabase()
  const app = new Hono()
    .route('/api/v1/designs', designsRoutes)
    .route('/api/v1/change-orders', changeOrdersRoutes)

  let sysAdmin: TestUser // cross-program authority
  let progAdmin: TestUser // created both programs, so a member of each
  let engineer: TestUser // a member of the home program only

  let unique: string
  let homeProgramId: string
  let homeDesignId: string
  let foreignDesignId: string
  let foreignDesignCode: string
  let foreignDesignName: string

  let homeAssembly: Part // a root of the home design, with the lines below
  let foreignLinePart: Part // a BOM child in the foreign program…
  let foreignLineChild: Part // …with a child of its own
  let libraryUnderForeign: Part // no program, but reached only through it
  let siblingLinePart: Part // a BOM child in the home program's other design
  let libraryLinePart: Part // a BOM child in a design with no program

  let foreignRefPart: Part // referenced by the home design…
  let foreignRefChild: Part // …with a child of its own
  let siblingRefPart: Part
  let libraryRefPart: Part

  let foreignAffected: Part // on the change order, in no tree at all
  let changeOrderId: string // links the home and the foreign design

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

    unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    homeProgramId = (
      await ProgramService.create(
        { name: 'Home Program', code: `XSH-${unique}` },
        progAdmin.id,
      )
    ).id
    const foreignProgram = await ProgramService.create(
      { name: 'Foreign Program', code: `XSF-${unique}` },
      progAdmin.id,
    )
    await ProgramService.addMember(
      homeProgramId,
      engineer.id,
      'engineer',
      progAdmin.id,
    )

    homeDesignId = (await mkDesign(homeProgramId, 'HOME')).id
    const siblingDesignId = (await mkDesign(homeProgramId, 'SIB')).id
    const foreignDesign = await mkDesign(foreignProgram.id, 'FGN')
    foreignDesignId = foreignDesign.id
    foreignDesignCode = foreignDesign.code
    foreignDesignName = foreignDesign.name
    const libraryDesignId = (await mkDesign(null, 'LIB', 'Library')).id

    homeAssembly = await mkPart(homeDesignId, 'HOMEASSY')
    foreignLinePart = await mkPart(foreignDesignId, 'FGNLINE')
    foreignLineChild = await mkPart(foreignDesignId, 'FGNLINECHILD')
    libraryUnderForeign = await mkPart(libraryDesignId, 'LIBUNDERFGN')
    siblingLinePart = await mkPart(siblingDesignId, 'SIBLINE')
    libraryLinePart = await mkPart(libraryDesignId, 'LIBLINE')
    foreignRefPart = await mkPart(foreignDesignId, 'FGNREF')
    foreignRefChild = await mkPart(foreignDesignId, 'FGNREFCHILD')
    siblingRefPart = await mkPart(siblingDesignId, 'SIBREF')
    libraryRefPart = await mkPart(libraryDesignId, 'LIBREF')
    foreignAffected = await mkPart(foreignDesignId, 'FGNAFFECTED')

    // Written directly, and the references through the service: what matters
    // is that such pointers exist, not who made them.
    await bomLine(homeAssembly.id, foreignLinePart.id)
    await bomLine(homeAssembly.id, siblingLinePart.id)
    await bomLine(homeAssembly.id, libraryLinePart.id)
    await bomLine(foreignLinePart.id, foreignLineChild.id)
    await bomLine(foreignLinePart.id, libraryUnderForeign.id)
    await bomLine(foreignRefPart.id, foreignRefChild.id)

    for (const part of [foreignRefPart, siblingRefPart, libraryRefPart]) {
      await reference(homeDesignId, part)
    }

    changeOrderId = await mkChangeOrder([homeDesignId, foreignDesignId])
    for (const part of [homeAssembly, foreignAffected]) {
      await ChangeOrderService.addAffectedItem(
        changeOrderId,
        { affectedItemId: part.id, changeAction: 'release' },
        progAdmin.id,
      )
    }

    cookies.clear()
    for (const u of [sysAdmin, progAdmin, engineer]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function mkDesign(
    programId: string | null,
    label: string,
    designType: 'Engineering' | 'Library' = 'Engineering',
  ) {
    return DesignService.create(
      {
        programId,
        name: `${label} Design ${unique}`,
        code: `XS${label}-${unique}`,
        designType,
      },
      progAdmin.id,
    )
  }

  async function mkPart(designId: string, label: string): Promise<Part> {
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

  async function bomLine(sourceId: string, targetId: string) {
    await testDb.db.insert(itemRelationships).values({
      sourceId,
      targetId,
      relationshipType: 'BOM',
      quantity: '1',
      createdBy: progAdmin.id,
      modifiedBy: progAdmin.id,
    })
  }

  async function reference(referencingDesignId: string, part: Part) {
    await CrossDesignReferenceService.createReference(
      { referencingDesignId, referencedItemId: part.id },
      progAdmin.id,
    )
  }

  async function mkChangeOrder(designIds: Array<string>) {
    const changeOrder = (await ItemService.create(
      'ChangeOrder',
      { revision: 'A', changeType: 'ECO', name: 'Structure ECO' } as never,
      progAdmin.id,
    )) as { id: string }
    for (const designId of designIds) {
      await ChangeOrderService.addDesign(changeOrder.id, designId, progAdmin.id)
    }
    return changeOrder.id
  }

  const get = (user: TestUser, path: string) =>
    app.request(path, { headers: { Cookie: cookies.get(user.id)! } })

  /** Everything in a response that would identify an item. */
  const identityOf = (part: Part) => [part.id, part.itemNumber, part.name]

  /**
   * What no read may hand the engineer: the foreign items, what sits under
   * them, and the foreign design itself.
   */
  function withheldFromEngineer() {
    return [
      foreignDesignId,
      foreignDesignCode,
      foreignDesignName,
      ...[
        foreignLinePart,
        foreignLineChild,
        libraryUnderForeign,
        foreignRefPart,
        foreignRefChild,
        foreignAffected,
      ].flatMap(identityOf),
    ]
  }

  function expectNoneOf(text: string, needles: Array<string>, label: string) {
    for (const needle of needles) {
      expect(text, `${label} discloses ${needle}`).not.toContain(needle)
    }
  }

  function flatten(nodes: Array<BOMTreeNode>): Array<BOMTreeNode> {
    return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])])
  }

  const homePath = (path: string) => `/api/v1/designs/${homeDesignId}${path}`
  const changeOrderStructurePath = (
    id = changeOrderId,
    designId = homeDesignId,
  ) => `/api/v1/change-orders/${id}/designs/${designId}/structure`

  const structureReads = [
    {
      label: 'GET /designs/:id/structure',
      path: () => homePath('/structure'),
      expandsBomLines: true,
      keys: ['hasRestricted', 'orphans', 'roots'],
    },
    {
      label: 'GET /designs/:id/structure?expandExternal=false',
      path: () => homePath('/structure?expandExternal=false'),
      // References still expand; lines into other designs are not followed.
      expandsBomLines: false,
      keys: ['hasRestricted', 'orphans', 'roots'],
    },
    {
      label: 'GET /change-orders/:id/designs/:designId/structure',
      path: () => changeOrderStructurePath(),
      expandsBomLines: true,
      keys: [
        'affectedItemIds',
        'design',
        'ecoBranch',
        'hasRestricted',
        'orphans',
        'roots',
        'versionContext',
      ],
    },
  ]

  // ==========================================================================
  // The references list
  // ==========================================================================

  describe('GET /designs/:id/cross-references', () => {
    it('names no item from a program the caller cannot read, nor its design', async () => {
      const res = await get(engineer, homePath('/cross-references'))
      expect(res.status).toBe(200)
      expectNoneOf(await res.text(), withheldFromEngineer(), 'references')
    })

    it('says that a reference was withheld, and nothing about how many', async () => {
      const res = await get(engineer, homePath('/cross-references'))
      const body = (await res.json()) as ReferenceList
      expect(body.data.hasRestricted).toBe(true)
      // One flag: no count beside it, and no blanked row standing in for the
      // withheld reference — either would size how far this design reaches
      // into the other program.
      expect(Object.keys(body.data).sort()).toEqual([
        'hasRestricted',
        'references',
      ])
      expect(body.data.references).toHaveLength(2)
    })

    it('still lists references into the caller’s own program and into a design with no program', async () => {
      const res = await get(engineer, homePath('/cross-references'))
      const body = (await res.json()) as ReferenceList
      expect(body.data.references.map((r) => r.referencedItemId)).toEqual(
        expect.arrayContaining([siblingRefPart.id, libraryRefPart.id]),
      )
    })

    for (const who of [
      'a member of both programs',
      'cross-program authority',
    ]) {
      it(`lists every reference, unflagged, for ${who}`, async () => {
        const user = who === 'cross-program authority' ? sysAdmin : progAdmin
        const res = await get(user, homePath('/cross-references'))
        const body = (await res.json()) as ReferenceList
        expect(body.data.references.map((r) => r.referencedItemId)).toEqual(
          expect.arrayContaining([
            foreignRefPart.id,
            siblingRefPart.id,
            libraryRefPart.id,
          ]),
        )
        expect(JSON.stringify(body)).toContain(foreignDesignCode)
        expect(body.data.hasRestricted).toBe(false)
      })
    }

    // An item can change design after it is referenced — a work instruction
    // follows its output part into that part's design — while the row keeps
    // the design it was referenced in. The row carries the item's fields, so
    // the item's design is charged as well, and the tree agrees with the list.
    it('withholds a reference whose item has since moved into a program the caller cannot read', async () => {
      await testDb.db
        .update(items)
        .set({ designId: foreignDesignId })
        .where(eq(items.id, siblingRefPart.id))

      const list = (await (
        await get(engineer, homePath('/cross-references'))
      ).json()) as ReferenceList
      expect(list.data.references.map((r) => r.referencedItemId)).not.toContain(
        siblingRefPart.id,
      )

      const tree = (await (
        await get(engineer, homePath('/structure'))
      ).json()) as Structure
      expect(flatten(tree.data.roots).map((n) => n.itemId)).not.toContain(
        siblingRefPart.id,
      )
    })

    // A reference outlives a hard delete of its item (the column has no
    // foreign key), and then the source design recorded on the row is all
    // there is to charge — and all the row still names.
    it('names no source design the caller cannot read once the item is gone', async () => {
      const repointed = await testDb.db
        .update(designCrossReferences)
        .set({ referencedItemId: randomUUID() })
        .where(
          and(
            eq(designCrossReferences.referencingDesignId, homeDesignId),
            eq(designCrossReferences.referencedItemId, foreignRefPart.id),
          ),
        )
        .returning()
      expect(repointed).toHaveLength(1)

      const res = await get(engineer, homePath('/cross-references'))
      expectNoneOf(
        await res.text(),
        [foreignDesignId, foreignDesignCode, foreignDesignName],
        'references',
      )
    })
  })

  // ==========================================================================
  // The structure trees
  // ==========================================================================

  for (const read of structureReads) {
    describe(read.label, () => {
      it('names no item from a program the caller cannot read, nor anything under one', async () => {
        const res = await get(engineer, read.path())
        expect(res.status).toBe(200)
        expectNoneOf(await res.text(), withheldFromEngineer(), read.label)
      })

      it('says that something was withheld, and nothing about how much', async () => {
        const res = await get(engineer, read.path())
        const body = (await res.json()) as Structure
        expect(body.data.hasRestricted).toBe(true)
        expect(Object.keys(body.data).sort()).toEqual(read.keys)
      })

      // The over-refusal guard: a redaction that dropped every other
      // design's item would pass the tests above and break the feature.
      it('still shows the design’s own parts and what the caller can read elsewhere', async () => {
        const res = await get(engineer, read.path())
        const body = (await res.json()) as Structure
        const shown = flatten(body.data.roots).map((n) => n.itemId)

        expect(shown).toContain(homeAssembly.id)
        expect(shown).toEqual(
          expect.arrayContaining([siblingRefPart.id, libraryRefPart.id]),
        )
        if (read.expandsBomLines) {
          expect(shown).toEqual(
            expect.arrayContaining([siblingLinePart.id, libraryLinePart.id]),
          )
        }
      })

      // Guards the fixture as much as the reads: a foreign item that never
      // rendered for anyone would make the refusals above prove nothing.
      it('shows the whole structure, unflagged, to a member of both programs and to cross-program authority', async () => {
        for (const user of [progAdmin, sysAdmin]) {
          const res = await get(user, read.path())
          expect(res.status).toBe(200)
          const body = (await res.json()) as Structure
          const shown = flatten(body.data.roots).map((n) => n.itemId)

          expect(shown).toEqual(
            expect.arrayContaining([foreignRefPart.id, foreignRefChild.id]),
          )
          if (read.expandsBomLines) {
            expect(shown).toEqual(
              expect.arrayContaining([
                foreignLinePart.id,
                foreignLineChild.id,
                libraryUnderForeign.id,
              ]),
            )
          }
          expect(body.data.hasRestricted).toBe(false)
        }
      })
    })
  }

  // A change order's flag has two arms: what the change order withholds
  // elsewhere, and what the tree itself withholds. Every read above goes
  // through a change order linking the foreign design, which raises the flag
  // by the first arm whatever the tree holds. This one links only a design the
  // caller can read, so the tree is all that can raise it.
  it('flags a change order’s tree for what the tree withheld, on a change order reaching only designs the caller can read', async () => {
    const ownChangeOrderId = await mkChangeOrder([homeDesignId])

    const res = await get(engineer, changeOrderStructurePath(ownChangeOrderId))
    expect(res.status).toBe(200)
    const text = await res.text()
    expectNoneOf(text, withheldFromEngineer(), 'own change order structure')
    expect((JSON.parse(text) as Structure).data.hasRestricted).toBe(true)

    // The flag comes from the withholding, not from the change order: a
    // caller who reaches both programs is shown the same tree unflagged.
    const whole = await get(
      progAdmin,
      changeOrderStructurePath(ownChangeOrderId),
    )
    expect(((await whole.json()) as Structure).data.hasRestricted).toBe(false)
  })

  // The flag puts a notice on screen, and a notice raised where nothing was
  // withheld teaches its reader to ignore the one that matters.
  it('raises no flag on a design whose references and lines are all readable, save for what a change order withholds elsewhere', async () => {
    const quietDesignId = (await mkDesign(homeProgramId, 'QUIET')).id
    const quietAssembly = await mkPart(quietDesignId, 'QUIETASSY')
    await bomLine(quietAssembly.id, libraryLinePart.id)
    await reference(quietDesignId, siblingRefPart)

    const reads = [
      `/api/v1/designs/${quietDesignId}/cross-references`,
      `/api/v1/designs/${quietDesignId}/structure`,
      changeOrderStructurePath(
        await mkChangeOrder([quietDesignId]),
        quietDesignId,
      ),
    ]
    for (const path of reads) {
      const res = await get(engineer, path)
      expect(res.status, path).toBe(200)
      const body = (await res.json()) as { data: { hasRestricted: boolean } }
      expect(body.data.hasRestricted, path).toBe(false)
    }

    // On a change order that also reaches the foreign program, the same tree
    // is flagged with nothing taken from it: a change order’s view carries
    // what the change order withholds elsewhere, as its summary does.
    await ChangeOrderService.addDesign(
      changeOrderId,
      quietDesignId,
      progAdmin.id,
    )
    const spanning = await get(
      engineer,
      changeOrderStructurePath(changeOrderId, quietDesignId),
    )
    expect(spanning.status).toBe(200)
    const spanningBody = (await spanning.json()) as {
      data: { hasRestricted: boolean }
    }
    expect(spanningBody.data.hasRestricted).toBe(true)

    // The tree did reach outside its design, so a flag that stayed down
    // stayed down for a reason.
    const res = await get(
      engineer,
      `/api/v1/designs/${quietDesignId}/structure`,
    )
    const body = (await res.json()) as Structure
    expect(flatten(body.data.roots).map((n) => n.itemId)).toEqual(
      expect.arrayContaining([libraryLinePart.id, siblingRefPart.id]),
    )
  })
})
