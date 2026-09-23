// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Program isolation on a change order's view of one of its designs
 *
 * `GET /api/v1/change-orders/:id/designs/:designId/structure` answers with a
 * design's BOM tree as a change order sees it: which items the change order
 * affects, and the change order's other designs resolved at its branches.
 * Both ids come off the URL, and the route charged only the design. These
 * tests pin the boundary on each input the tree is built from:
 *
 *  - the change order: one the caller cannot open is refused, as its summary
 *    is, however readable the design named beside it
 *  - its affected items: the tree is built from the caller's share of them, so
 *    a change order spanning two programs neither lists nor marks the other
 *    program's items for a member of one — the rule its affected-items list
 *    already follows, `hasRestricted` included
 *  - its branches: a BOM line or cross-design reference into a design the
 *    caller cannot read never shows the change order's drafts there — nor,
 *    since the tree withholds whatever the caller cannot read, what that
 *    design has released (`design-structure-isolation.permissions.test.ts`)
 *  - the design: one that is not on the change order is not found, and that
 *    is asked only after both reach checks, so the answer cannot say which
 *    designs of an unreadable program the change order touches
 *
 * Each has its over-refusal guard beside it: a member's own change order, and
 * everything a caller who reaches the other program is entitled to see.
 *
 * Run: npx vitest run cascadia-api/src/server/routes/change-orders.design-structure.permissions.test.ts
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
import changeOrdersRoutes from './change-orders'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BOMTreeNode } from '@cascadia/commons/types/bom'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemService } from '@/items/services/ItemService'
import { ItemRelationshipService } from '@/items/services/ItemRelationshipService'
import { ChangeOrderService } from '@/items/services/ChangeOrderService'
import { CrossDesignReferenceService } from '@/services/CrossDesignReferenceService'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { ItemTypeRegistry } from '@/items/registry'
import { SessionManager } from '@/auth/session'
import { permissionService } from '@/auth/permission-service'
import { branchItems, items } from '@/db/schema'

// Import to register item types
import '@/items/registerItemTypes.server'

type Part = { id: string; masterId: string; itemNumber: string }

interface StructureBody {
  roots: Array<BOMTreeNode>
  affectedItemIds: Array<string>
  hasRestricted: boolean
  ecoBranch: { id: string | null } | null
}

describe('change-order design structure — program isolation', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/v1/change-orders', changeOrdersRoutes)

  let sysAdmin: TestUser
  let progAdmin: TestUser // created both programs, so reaches both
  let engineer: TestUser // a member of the home program only

  let homeProgramId: string
  let foreignProgramId: string
  let homeDesignId: string
  let foreignDesignId: string
  let uniquePrefix: string

  const cookies = new Map<string, string>()

  beforeAll(async () => {
    await testDb.setup()
    // The branch tests plant their draft in the working copy a revise mints,
    // and it is the Part lifecycle that lets a released part be revised.
    await seedStandardPartLifecycle(testDb.db)
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    uniquePrefix = `COS${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    sysAdmin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    progAdmin = (await insertTestUserWithRole(testDb.db, 'User')).user
    engineer = (await insertTestUserWithRole(testDb.db, 'User')).user

    homeProgramId = (
      await ProgramService.create(
        { name: 'Home Program', code: `HOME-${uniquePrefix}` },
        progAdmin.id,
      )
    ).id
    foreignProgramId = (
      await ProgramService.create(
        { name: 'Foreign Program', code: `FGN-${uniquePrefix}` },
        progAdmin.id,
      )
    ).id
    await ProgramService.addMember(
      homeProgramId,
      engineer.id,
      'engineer',
      progAdmin.id,
    )

    homeDesignId = await mkDesign(homeProgramId, 'HOMED')
    foreignDesignId = await mkDesign(foreignProgramId, 'FGND')

    cookies.clear()
    for (const u of [sysAdmin, progAdmin, engineer]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function get(user: TestUser, path: string) {
    return app.request(path, { headers: { Cookie: cookies.get(user.id)! } })
  }

  function structurePath(changeOrderId: string, designId: string) {
    return `/api/v1/change-orders/${changeOrderId}/designs/${designId}/structure`
  }

  /** A 200, parsed — and the raw text, to assert what appears nowhere in it. */
  async function readStructure(
    user: TestUser,
    changeOrderId: string,
    designId: string,
  ) {
    const res = await get(user, structurePath(changeOrderId, designId))
    expect(res.status).toBe(200)
    const raw = await res.text()
    return { raw, data: (JSON.parse(raw) as { data: StructureBody }).data }
  }

  async function mkDesign(
    programId: string,
    label: string,
    designType: 'Engineering' | 'Library' = 'Engineering',
  ) {
    return (
      await DesignService.create(
        {
          programId,
          name: `${label} Design`,
          code: `${label}-${uniquePrefix}`,
          designType,
        },
        progAdmin.id,
      )
    ).id
  }

  async function mkPart(designId: string, label: string): Promise<Part> {
    return ItemService.create(
      'Part',
      {
        designId,
        revision: 'A',
        name: `${label} Part`,
        itemNumber: `${label}-${uniquePrefix}`,
        partType: 'Manufacture',
      } as never,
      progAdmin.id,
    )
  }

  async function nest(parentId: string, childId: string) {
    await ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      progAdmin.id,
      { quantity: '1' },
      { bypassEditGuard: true },
    )
  }

  /**
   * An ECO shaped the way the application shapes one: no `items.designId`,
   * designs attached through `change_order_designs`, each with its branch.
   */
  async function mkChangeOrder(designIds: Array<string>, name: string) {
    const changeOrder = (await ItemService.create(
      'ChangeOrder',
      { revision: 'A', changeType: 'ECO', name } as never,
      progAdmin.id,
    )) as { id: string }
    for (const designId of designIds) {
      await ChangeOrderService.addDesign(changeOrder.id, designId, progAdmin.id)
    }
    return changeOrder.id
  }

  async function affect(
    changeOrderId: string,
    itemId: string,
    changeAction: 'release' | 'revise',
  ) {
    await ChangeOrderService.addAffectedItem(
      changeOrderId,
      { affectedItemId: itemId, changeAction },
      progAdmin.id,
    )
  }

  /**
   * Revise a part on a change order and rename the working copy that mints on
   * its design's branch. The name exists nowhere but that branch, so finding
   * it in a response is finding the branch. Returns the copy's id.
   */
  async function draftOnBranch(
    changeOrderId: string,
    part: Part,
    partDesignId: string,
    draftName: string,
  ) {
    await testDb.db
      .update(items)
      .set({ state: 'Released' })
      .where(eq(items.id, part.id))
    await affect(changeOrderId, part.id, 'revise')

    const link = (
      await ChangeOrderService.getChangeOrderDesigns(changeOrderId)
    ).find((d) => d.designId === partDesignId)
    expect(link?.branchId).toBeTruthy()
    const tracked = await testDb.db
      .select({ currentItemId: branchItems.currentItemId })
      .from(branchItems)
      .where(
        and(
          eq(branchItems.branchId, link!.branchId!),
          eq(branchItems.itemMasterId, part.masterId),
        ),
      )
      .then((rows) => rows.at(0))
    const workingCopyId = tracked?.currentItemId
    // The revise really did mint a copy, or there is no draft to withhold
    expect(workingCopyId).toBeTruthy()
    expect(workingCopyId).not.toBe(part.id)

    await testDb.db
      .update(items)
      .set({ name: draftName })
      .where(eq(items.id, workingCopyId!))
    return workingCopyId!
  }

  /** Nodes are matched by master: a draft and its released row share one. */
  function findNode(
    nodes: Array<BOMTreeNode>,
    masterId: string,
  ): BOMTreeNode | undefined {
    for (const node of nodes) {
      if (node.masterId === masterId) return node
      const hit = findNode(node.children ?? [], masterId)
      if (hit) return hit
    }
    return undefined
  }

  // ==========================================================================
  // The change order in the path
  //
  // The design gate alone let any change-order id through, so naming a design
  // of your own was enough to read a change order that reaches none of your
  // designs: what it affects, and its drafts on its branches.
  // ==========================================================================

  describe('a change order the caller cannot open', () => {
    let foreignOnlyChangeOrderId: string
    let foreignPart: Part

    beforeEach(async () => {
      foreignPart = await mkPart(foreignDesignId, 'FOREIGN')
      foreignOnlyChangeOrderId = await mkChangeOrder(
        [foreignDesignId],
        'Foreign-only ECO',
      )
      await affect(foreignOnlyChangeOrderId, foreignPart.id, 'release')
    })

    it('is refused beside a design of their own, as its summary is', async () => {
      // The boundary, as a read that already honours it draws it
      expect(
        (
          await get(
            engineer,
            `/api/v1/change-orders/${foreignOnlyChangeOrderId}/summary`,
          )
        ).status,
      ).toBe(403)

      const res = await get(
        engineer,
        structurePath(foreignOnlyChangeOrderId, homeDesignId),
      )
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain(foreignPart.id)
    })

    it('still renders for a caller who reaches it', async () => {
      const { data } = await readStructure(
        progAdmin,
        foreignOnlyChangeOrderId,
        foreignDesignId,
      )
      expect(data.affectedItemIds).toEqual([foreignPart.id])
    })

    it('an id naming no change order is 404 to cross-program authority and 403 to anyone else', async () => {
      // The rule the summary follows: only cross-program authority is past
      // the gate for a row with no designs, so only it learns there is none.
      const unknown = randomUUID()
      expect(
        (await get(sysAdmin, structurePath(unknown, homeDesignId))).status,
      ).toBe(404)
      expect(
        (await get(engineer, structurePath(unknown, homeDesignId))).status,
      ).toBe(403)
    })
  })

  // ==========================================================================
  // The affected items the tree is built from
  // ==========================================================================

  describe('a change order spanning two programs', () => {
    let sharedChangeOrderId: string
    let homePart: Part
    let foreignPart: Part

    beforeEach(async () => {
      homePart = await mkPart(homeDesignId, 'HOME')
      foreignPart = await mkPart(foreignDesignId, 'FOREIGN')
      sharedChangeOrderId = await mkChangeOrder(
        [homeDesignId, foreignDesignId],
        'Cross-program ECO',
      )
      for (const part of [homePart, foreignPart]) {
        await affect(sharedChangeOrderId, part.id, 'release')
      }
    })

    it('names none of the other program’s affected items, or its design, anywhere in the body', async () => {
      // The change order's affected-items list withholds them from this
      // caller…
      const listed = await get(
        engineer,
        `/api/v1/change-orders/${sharedChangeOrderId}/affected-items`,
      )
      expect(listed.status).toBe(200)
      expect(await listed.text()).not.toContain(foreignPart.id)

      // …so the tree beside it must not hand them back.
      const { raw } = await readStructure(
        engineer,
        sharedChangeOrderId,
        homeDesignId,
      )
      expect(raw).not.toContain(foreignPart.id)
      expect(raw).not.toContain(foreignDesignId)
    })

    it('still lists and marks the caller’s own share', async () => {
      const { data } = await readStructure(
        engineer,
        sharedChangeOrderId,
        homeDesignId,
      )
      expect(data.affectedItemIds).toContain(homePart.id)
      const node = findNode(data.roots, homePart.masterId)
      expect(node?.isInEco).toBe(true)
      expect(node?.changeAction).toBe('release')
    })

    it('withholds nothing from a caller who reaches both programs', async () => {
      for (const user of [progAdmin, sysAdmin]) {
        const { data } = await readStructure(
          user,
          sharedChangeOrderId,
          homeDesignId,
        )
        expect(data.affectedItemIds).toEqual(
          expect.arrayContaining([homePart.id, foreignPart.id]),
        )
      }
    })

    it('says that something was withheld, and only when it was', async () => {
      // One flag, as on the affected-items list: not a count, and not whose.
      const partial = await readStructure(
        engineer,
        sharedChangeOrderId,
        homeDesignId,
      )
      expect(partial.data.hasRestricted).toBe(true)

      // Nothing of the other program's need be affected for it to be
      // withheld: that the change order reaches it at all is part of it.
      const linkedOnlyChangeOrderId = await mkChangeOrder(
        [homeDesignId, foreignDesignId],
        'Linked-only ECO',
      )
      const linkedOnly = await readStructure(
        engineer,
        linkedOnlyChangeOrderId,
        homeDesignId,
      )
      expect(linkedOnly.data.hasRestricted).toBe(true)

      for (const user of [progAdmin, sysAdmin]) {
        const whole = await readStructure(
          user,
          sharedChangeOrderId,
          homeDesignId,
        )
        expect(whole.data.hasRestricted).toBe(false)
      }

      const ownChangeOrderId = await mkChangeOrder([homeDesignId], 'Own ECO')
      const own = await readStructure(engineer, ownChangeOrderId, homeDesignId)
      expect(own.data.hasRestricted).toBe(false)
    })
  })

  // ==========================================================================
  // The branches the tree resolves other designs at
  //
  // A change order that also changes the design a BOM line or reference points
  // into resolves that target at the change order's branch there. For a caller
  // who cannot read that design, that is another program's unreleased draft —
  // which neither the design's own structure read nor the change order's
  // affected-items list would show them.
  // ==========================================================================

  describe('a BOM line into a Library the caller cannot read', () => {
    let changeOrderId: string
    let assembly: Part
    let libraryPart: Part
    let workingCopyId: string
    let draftName: string

    beforeEach(async () => {
      // A program's Library follows that program's membership, and a Library
      // part is the one cross-design target a BOM line may name.
      const libraryId = await mkDesign(foreignProgramId, 'FGNLIB', 'Library')
      assembly = await mkPart(homeDesignId, 'ASSY')
      libraryPart = await mkPart(libraryId, 'LIBPART')
      await nest(assembly.id, libraryPart.id)

      changeOrderId = await mkChangeOrder(
        [homeDesignId, libraryId],
        'Library ECO',
      )
      draftName = `Library draft ${uniquePrefix}`
      workingCopyId = await draftOnBranch(
        changeOrderId,
        libraryPart,
        libraryId,
        draftName,
      )
    })

    it('shows the line neither at the change order’s draft nor at what the Library has released', async () => {
      const { raw, data } = await readStructure(
        engineer,
        changeOrderId,
        homeDesignId,
      )
      expect(raw).not.toContain(workingCopyId)
      expect(raw).not.toContain(draftName)
      // Resolving at released keeps the draft out; the Library's part is
      // still another program's, and is withheld with the line, flagged.
      expect(raw).not.toContain(libraryPart.id)
      expect(raw).not.toContain(libraryPart.itemNumber)

      const assemblyNode = findNode(data.roots, assembly.masterId)
      expect(assemblyNode).toBeDefined()
      expect(assemblyNode?.children ?? []).toEqual([])
      expect(data.hasRestricted).toBe(true)
    })

    it('shows the draft to a caller who reaches the Library', async () => {
      const { data } = await readStructure(
        progAdmin,
        changeOrderId,
        homeDesignId,
      )
      const child = findNode(data.roots, assembly.masterId)?.children?.find(
        (c) => c.masterId === libraryPart.masterId,
      )
      expect(child?.itemId).toBe(workingCopyId)
      expect(child?.name).toBe(draftName)
      expect(child?.isInEco).toBe(true)
    })
  })

  describe('a cross-design reference into a design the caller cannot read', () => {
    let changeOrderId: string
    let referencedPart: Part
    let workingCopyId: string
    let draftName: string

    beforeEach(async () => {
      referencedPart = await mkPart(foreignDesignId, 'REFERENCED')
      await CrossDesignReferenceService.createReference(
        {
          referencingDesignId: homeDesignId,
          referencedItemId: referencedPart.id,
        },
        progAdmin.id,
      )

      changeOrderId = await mkChangeOrder(
        [homeDesignId, foreignDesignId],
        'Reference ECO',
      )
      draftName = `Referenced draft ${uniquePrefix}`
      workingCopyId = await draftOnBranch(
        changeOrderId,
        referencedPart,
        foreignDesignId,
        draftName,
      )
    })

    it('shows the reference neither at the change order’s draft nor at what that design has released', async () => {
      const { raw, data } = await readStructure(
        engineer,
        changeOrderId,
        homeDesignId,
      )
      expect(raw).not.toContain(workingCopyId)
      expect(raw).not.toContain(draftName)
      // As for a line: the released row is withheld too, and flagged.
      expect(raw).not.toContain(referencedPart.id)
      expect(raw).not.toContain(referencedPart.itemNumber)

      expect(findNode(data.roots, referencedPart.masterId)).toBeUndefined()
      expect(data.hasRestricted).toBe(true)
    })

    it('shows the draft to a caller who reaches that design', async () => {
      const { data } = await readStructure(
        progAdmin,
        changeOrderId,
        homeDesignId,
      )
      const reference = findNode(data.roots, referencedPart.masterId)
      expect(reference?.itemId).toBe(workingCopyId)
      expect(reference?.name).toBe(draftName)
    })
  })

  // ==========================================================================
  // The design in the path
  // ==========================================================================

  describe('a design that is not one of the change order’s', () => {
    it('is not found, by a caller who can read both', async () => {
      const secondHomeDesignId = await mkDesign(homeProgramId, 'HOMED2')
      const changeOrderId = await mkChangeOrder([homeDesignId], 'Home ECO')

      for (const user of [engineer, progAdmin, sysAdmin]) {
        expect(
          (await get(user, structurePath(changeOrderId, secondHomeDesignId)))
            .status,
        ).toBe(404)
      }
    })

    it('is refused exactly as a linked one is when the caller cannot read it', async () => {
      // A 404 here beside the linked design's 403 would tell a member of one
      // program which of another program's designs the change order touches.
      const secondForeignDesignId = await mkDesign(foreignProgramId, 'FGND2')
      const changeOrderId = await mkChangeOrder(
        [homeDesignId, foreignDesignId],
        'Cross-program ECO',
      )

      expect(
        (await get(engineer, structurePath(changeOrderId, foreignDesignId)))
          .status,
      ).toBe(403)
      expect(
        (
          await get(
            engineer,
            structurePath(changeOrderId, secondForeignDesignId),
          )
        ).status,
      ).toBe(403)
    })
  })

  // ==========================================================================
  // Over-refusal guard
  // ==========================================================================

  describe('a member’s own change order', () => {
    it('still renders its design’s structure, marked, on its branch', async () => {
      const assembly = await mkPart(homeDesignId, 'OWN-ASSY')
      const child = await mkPart(homeDesignId, 'OWN-CHILD')
      await nest(assembly.id, child.id)
      const changeOrderId = await mkChangeOrder([homeDesignId], 'Own ECO')
      await affect(changeOrderId, assembly.id, 'release')

      const { data } = await readStructure(
        engineer,
        changeOrderId,
        homeDesignId,
      )
      const root = findNode(data.roots, assembly.masterId)
      expect(root?.isInEco).toBe(true)
      expect(root?.changeAction).toBe('release')
      expect(root?.children?.map((c) => c.masterId)).toEqual([child.masterId])
      expect(data.affectedItemIds).toEqual([assembly.id])

      const link = (
        await ChangeOrderService.getChangeOrderDesigns(changeOrderId)
      ).find((d) => d.designId === homeDesignId)
      expect(data.ecoBranch?.id).toBe(link?.branchId)
    })
  })
})
