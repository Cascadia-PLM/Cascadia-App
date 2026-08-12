// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * EcoStructureService Tests
 *
 * The BOM tree a change order shows for one design is graph traversal over
 * version-resolved items — the third gate. It had no tests while it lived
 * inside a route handler, because there was no seam to call.
 *
 * Run: npm run test -- src/lib/services/EcoStructureService.test.ts
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
import { eq } from 'drizzle-orm'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import { EcoStructureService } from './EcoStructureService'
import type { BOMTreeNode } from './EcoStructureService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { items, programs } from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
import { NotFoundError } from '@/lib/errors'

import '@/lib/items/registerItemTypes.server'

describe('EcoStructureService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string
  let uniquePrefix: string

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

    uniquePrefix = `S${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Structure Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id

    const design = await DesignService.create(
      {
        programId,
        name: 'Structure Test Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(suffix: string, itemType: string = 'Part') {
    return ItemService.create(
      itemType,
      {
        itemNumber: `PN-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Part ${suffix}`,
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
  }

  async function addBom(
    parentId: string,
    childId: string,
    data?: { quantity?: string; findNumber?: number },
  ) {
    return ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      data,
      { bypassEditGuard: true },
    )
  }

  async function createChangeOrder() {
    return ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Structure Test ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )
  }

  /** Every itemNumber in the tree, depth-first. */
  function flatten(nodes: Array<BOMTreeNode>): Array<string> {
    return nodes.flatMap((n) => [n.itemNumber, ...flatten(n.children ?? [])])
  }

  function findNode(
    nodes: Array<BOMTreeNode>,
    itemNumber: string,
  ): BOMTreeNode | undefined {
    for (const n of nodes) {
      if (n.itemNumber === itemNumber) return n
      const hit = findNode(n.children ?? [], itemNumber)
      if (hit) return hit
    }
    return undefined
  }

  it('throws NotFoundError for a design that does not exist', async () => {
    const eco = await createChangeOrder()

    await expect(
      EcoStructureService.getDesignStructure(
        eco.id,
        '00000000-0000-4000-8000-0000000000ff',
      ),
    ).rejects.toThrow(NotFoundError)
  })

  it('nests children under their parent and carries quantity and find number', async () => {
    const eco = await createChangeOrder()
    const parent = await createPart('ASM')
    const childA = await createPart('CHILD-A')
    const childB = await createPart('CHILD-B')

    await addBom(parent.id, childA.id, { quantity: '3', findNumber: 10 })
    await addBom(parent.id, childB.id, { quantity: '1', findNumber: 20 })

    const result = await EcoStructureService.getDesignStructure(
      eco.id,
      designId,
    )

    // Only the assembly is a root — the children have a parent
    expect(result.roots.map((r) => r.itemNumber)).toEqual([parent.itemNumber])

    const root = result.roots[0]!
    expect(root.children?.map((c) => c.itemNumber).sort()).toEqual(
      [childA.itemNumber, childB.itemNumber].sort(),
    )

    const a = findNode(result.roots, childA.itemNumber)
    expect(a?.quantity).toBe(3)
    expect(a?.findNumber).toBe(10)
  })

  it('terminates on a cyclic BOM instead of recursing forever', async () => {
    const eco = await createChangeOrder()
    const root = await createPart('CYC-ROOT')
    const a = await createPart('CYC-A')
    const b = await createPart('CYC-B')

    // root -> a -> b -> a: a reachable root feeding a genuine loop, so the
    // traversal has to walk into the cycle rather than never entering it.
    await addBom(root.id, a.id)
    await addBom(a.id, b.id)
    await addBom(b.id, a.id)

    const result = await EcoStructureService.getDesignStructure(
      eco.id,
      designId,
    )

    expect(result.roots.map((r) => r.itemNumber)).toEqual([root.itemNumber])

    // Terminating is the point, but a vacuous tree would also terminate:
    // pin that the cycle was actually entered and then cut.
    const walked = flatten(result.roots)
    expect(walked).toContain(a.itemNumber)
    expect(walked).toContain(b.itemNumber)
    expect(walked.length).toBe(new Set(walked).size)
  })

  it('reports non-structural items as orphans rather than tree roots', async () => {
    const eco = await createChangeOrder()
    const structural = await createPart('IN-BOM')
    const excluded = await createPart('OUT-OF-BOM')

    await testDb.db
      .update(items)
      .set({ inDesignStructure: false })
      .where(eq(items.id, excluded.id))

    const result = await EcoStructureService.getDesignStructure(
      eco.id,
      designId,
    )

    expect(result.roots.map((r) => r.itemNumber)).toEqual([
      structural.itemNumber,
    ])
    expect(result.orphans.map((o) => o.itemNumber)).toEqual([
      excluded.itemNumber,
    ])
  })

  it('marks items the change order affects, matching on masterId alone', async () => {
    const eco = await createChangeOrder()
    const affected = await createPart('AFFECTED')
    const untouched = await createPart('UNTOUCHED')

    // Recorded by masterId only. A revised item's branch version has a
    // different id than whatever was recorded when it was added, so masterId
    // is the match that has to hold on its own.
    await ChangeOrderService.addAffectedItem(
      eco.id,
      {
        affectedItemMasterId: affected.masterId,
        changeAction: 'release',
      },
      user.id,
    )

    const result = await EcoStructureService.getDesignStructure(
      eco.id,
      designId,
    )

    const affectedNode = findNode(result.roots, affected.itemNumber)
    expect(affectedNode?.isInEco).toBe(true)
    expect(affectedNode?.changeAction).toBe('release')

    const untouchedNode = findNode(result.roots, untouched.itemNumber)
    expect(untouchedNode?.isInEco).toBe(false)
    expect(untouchedNode?.changeAction).toBeNull()
  })

  it('shows only touched subtrees for a Library design', async () => {
    const library = await DesignService.create(
      {
        programId,
        name: 'Shared Library',
        code: `LIB-${uniquePrefix}`,
        designType: 'Library',
      },
      user.id,
    )
    const libraryId = library.id

    const makeLibraryPart = async (suffix: string) =>
      ItemService.create(
        'Part',
        {
          itemNumber: `LP-${uniquePrefix}-${suffix}`,
          revision: 'A',
          name: `Library Part ${suffix}`,
          designId: libraryId,
          state: 'Draft',
        } as any,
        user.id,
      )

    const touchedRoot = await makeLibraryPart('TOUCHED-ROOT')
    const touchedChild = await makeLibraryPart('TOUCHED-CHILD')
    const untouchedRoot = await makeLibraryPart('UNTOUCHED-ROOT')

    await addBom(touchedRoot.id, touchedChild.id)

    const eco = await createChangeOrder()
    // The affected item is the *child*, so this also pins that a root
    // survives on account of a descendant, not only itself.
    await ChangeOrderService.addAffectedItem(
      eco.id,
      {
        affectedItemId: touchedChild.id,
        affectedItemMasterId: touchedChild.masterId,
        changeAction: 'release',
      },
      user.id,
    )

    const result = await EcoStructureService.getDesignStructure(
      eco.id,
      libraryId,
    )

    expect(result.roots.map((r) => r.itemNumber)).toEqual([
      touchedRoot.itemNumber,
    ])
    expect(result.roots.map((r) => r.itemNumber)).not.toContain(
      untouchedRoot.itemNumber,
    )
  })

  it('resolves against the ECO branch once one exists, and counts its own affected items', async () => {
    const eco = await createChangeOrder()
    const part = await createPart('BRANCHED')

    const { branch } = await BranchService.getOrCreateEcoBranch(
      designId,
      eco.id,
      user.id,
    )

    await ChangeOrderService.addAffectedItem(
      eco.id,
      {
        affectedItemId: part.id,
        affectedItemMasterId: part.masterId,
        changeAction: 'release',
      },
      user.id,
    )

    const result = await EcoStructureService.getDesignStructure(
      eco.id,
      designId,
    )

    expect(result.versionContext.type).toBe('branch')
    expect(result.versionContext.isHistorical).toBe(false)
    expect(result.ecoBranch?.id).toBe(branch.id)
    // Derived from the affected-item rows for this design, not a stored counter
    expect(result.ecoBranch?.itemsAffected).toBe(1)
  })

  it('falls back to the released view when the change order has no branch here', async () => {
    const eco = await createChangeOrder()
    await createPart('NO-BRANCH')

    const result = await EcoStructureService.getDesignStructure(
      eco.id,
      designId,
    )

    expect(result.versionContext.type).toBe('released')
    expect(result.versionContext.isHistorical).toBe(false)
    expect(result.ecoBranch).toBeNull()
  })
})
