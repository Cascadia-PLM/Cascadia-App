// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The structure stream's invariants.
 *
 * Gate 1 (data integrity): a BOM edit produced a commit and zero events before
 * this, so structure was the largest class of engineering change completely
 * invisible on the bus. Gate 3 for the batch-replace path, which has to record
 * both the lines it cleared and the lines it wrote.
 *
 * The case that earns its place above all the others is the **boundary**: the
 * version-carry path produces zero relationship events. That is what stops a
 * later refactor turning every working-copy mint into a BOM storm — and it is
 * the one property no amount of reading the emit sites would tell you.
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
import { and, eq, inArray } from 'drizzle-orm'
import type { TestUser } from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { BranchService } from '@/lib/services/BranchService'
import { DesignService } from '@/lib/services/DesignService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { domainEvents, parts, programs } from '@/lib/db/schema'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { ItemTypeRegistry } from '@/lib/items/registry'
import '@/lib/items/registerItemTypes.server'

describe('structure event emission', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let prefix: string

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
    user = await insertTestUser(testDb.db)
    prefix = `ST${Date.now().toString().slice(-8)}`

    const program = (
      await testDb.db
        .insert(programs)
        .values({
          name: `Structure ${prefix}`,
          code: `SP-${prefix}`,
          createdBy: user.id,
          updatedBy: user.id,
        })
        .returning()
    )[0]!
    const design = await DesignService.create(
      {
        programId: program.id,
        name: `Structure design ${prefix}`,
        code: `SD-${prefix}`,
        designType: 'Engineering',
      } as any,
      user.id,
    )
    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const structureEvents = async (sourceId: string) =>
    testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          inArray(domainEvents.type, [
            'relationship.added',
            'relationship.removed',
            'relationship.updated',
          ]),
          eq(domainEvents.subjectId, sourceId),
        ),
      )

  async function part(label: string) {
    return ItemService.create(
      'Part',
      {
        itemNumber: `PN-${prefix}-${label}`,
        revision: '-',
        name: `Part ${label}`,
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
  }

  it('an add carries both master ids and the line’s three scalars', async () => {
    const parent = await part('parent')
    const child = await part('child')

    await ItemRelationshipService.addRelationship(
      parent.id,
      child.id,
      'BOM',
      user.id,
      { quantity: '2.500', referenceDesignator: 'R1', findNumber: 7 },
    )

    const events = await structureEvents(parent.id)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('relationship.added')
    expect(events[0]!.actorId).toBe(user.id)
    // Both ends, version and master: a version id alone is useless to a
    // consumer across revisions.
    expect(events[0]!.payload).toMatchObject({
      sourceId: parent.id,
      sourceMasterId: parent.masterId,
      targetId: child.id,
      targetMasterId: child.masterId,
      relationshipType: 'BOM',
      quantity: '2.500',
      referenceDesignator: 'R1',
      findNumber: 7,
    })
  })

  it('a remove carries the values the edge had', async () => {
    const parent = await part('rparent')
    const child = await part('rchild')
    const edge = await ItemRelationshipService.addRelationship(
      parent.id,
      child.id,
      'BOM',
      user.id,
      { quantity: '4.000', referenceDesignator: 'R9', findNumber: 3 },
    )

    await ItemRelationshipService.removeRelationship(edge.id, user.id)

    const events = await structureEvents(parent.id)
    // Compared without an order: nothing on this harness commits, so no event
    // has a `seq` to sort by.
    expect(events.map((e) => e.type).sort()).toEqual([
      'relationship.added',
      'relationship.removed',
    ])
    // By the time a consumer reads the removal there is nothing left to look
    // up, so the payload has to carry what was removed.
    const removal = events.find((e) => e.type === 'relationship.removed')
    expect(removal?.payload).toMatchObject({
      relationshipId: edge.id,
      quantity: '4.000',
      referenceDesignator: 'R9',
      findNumber: 3,
    })
  })

  it('an update names the changed fields, and changing nothing emits nothing', async () => {
    const parent = await part('uparent')
    const child = await part('uchild')
    const edge = await ItemRelationshipService.addRelationship(
      parent.id,
      child.id,
      'BOM',
      user.id,
      { quantity: '1.000', referenceDesignator: 'R1', findNumber: 1 },
    )

    // Submitting the same values is not an edit.
    await ItemRelationshipService.updateRelationship(edge.id, user.id, {
      quantity: '1.000',
      referenceDesignator: 'R1',
    })
    expect(await structureEvents(parent.id)).toHaveLength(1)

    await ItemRelationshipService.updateRelationship(edge.id, user.id, {
      quantity: '3.000',
      findNumber: 5,
    })
    const events = await structureEvents(parent.id)
    expect(events).toHaveLength(2)
    const update = events.find((e) => e.type === 'relationship.updated')
    expect(update?.payload).toMatchObject({
      quantity: '3.000',
      findNumber: 5,
    })
    const changed = (update?.payload as { changedFields: Array<string> })
      .changedFields
    expect([...changed].sort()).toEqual(['findNumber', 'quantity'])
  })

  /**
   * The changed-field list knew the three scalars, so a condition-only edit
   * emitted nothing and the payload never said which product a line belonged
   * to. Both ends of the variant vocabulary ride every structure event now.
   */
  it('a condition-only edit is an update naming option, and the events carry it', async () => {
    const parent = await part('cparent')
    const child = await part('cchild')
    await testDb.db
      .update(parts)
      .set({
        optionModel: {
          families: [
            {
              code: 'color',
              name: 'Colour',
              required: true,
              values: [
                { code: 'black', label: 'Black' },
                { code: 'white', label: 'White' },
              ],
            },
          ],
          constraints: [],
        },
      })
      .where(eq(parts.itemId, parent.id))
    const edge = await ItemRelationshipService.addRelationship(
      parent.id,
      child.id,
      'BOM',
      user.id,
      { quantity: '1.000' },
    )
    const [added] = await structureEvents(parent.id)
    expect(added?.payload).toMatchObject({ option: null, targetMakeCode: null })

    await ItemRelationshipService.updateRelationship(edge.id, user.id, {
      option: { all: [{ family: 'color', values: ['black'] }] },
    })
    const events = await structureEvents(parent.id)
    expect(events).toHaveLength(2)
    const update = events.find((e) => e.type === 'relationship.updated')
    expect(update?.payload).toMatchObject({
      changedFields: ['option'],
      option: { all: [{ family: 'color', values: ['black'] }] },
      targetMakeCode: null,
    })
  })

  /**
   * The batch path recorded nothing at all. With `replaceExisting` it clears a
   * parent's lines and writes new ones in one transaction, and a consumer has
   * to hear both halves: the lines that went, and the lines that came.
   */
  it('a batch replacement records each line it cleared and each line it wrote', async () => {
    const parent = await part('bparent')
    const oldChild = await part('bold')
    const keptChild = await part('bkept')
    const newChild = await part('bnew')
    const oldEdge = await ItemRelationshipService.addRelationship(
      parent.id,
      oldChild.id,
      'BOM',
      user.id,
      { quantity: '1.000' },
    )
    await ItemRelationshipService.addRelationship(
      parent.id,
      keptChild.id,
      'BOM',
      user.id,
      { quantity: '1.000' },
    )

    await ItemRelationshipService.addRelationshipBatch(
      [
        {
          sourceId: parent.id,
          targetId: keptChild.id,
          relationshipType: 'BOM',
          userId: user.id,
          data: { quantity: '2.000' },
        },
        {
          sourceId: parent.id,
          targetId: newChild.id,
          relationshipType: 'BOM',
          userId: user.id,
          data: { quantity: '5.000' },
        },
      ],
      { replaceExisting: true, skipHistory: true },
    )

    const events = await structureEvents(parent.id)
    const removed = events.filter((e) => e.type === 'relationship.removed')
    const added = events.filter((e) => e.type === 'relationship.added')
    // Both old lines were cleared. The kept child's line is a new row, so it
    // is a removal and an addition both.
    expect(
      removed
        .map((e) => (e.payload as { targetMasterId: string }).targetMasterId)
        .sort(),
    ).toEqual([oldChild.masterId, keptChild.masterId].sort())
    expect(
      removed.some(
        (e) =>
          (e.payload as { relationshipId: string }).relationshipId ===
          oldEdge.id,
      ),
    ).toBe(true)
    // Two from the one-at-a-time adds above, two from the batch.
    expect(
      added
        .map((e) => (e.payload as { quantity: string | null }).quantity)
        .sort(),
    ).toEqual(['1.000', '1.000', '2.000', '5.000'])
    for (const event of [...removed, ...added]) {
      expect(event.actorId).toBe(user.id)
    }
  })

  /**
   * The one that stops a later refactor turning every checkout into a BOM
   * storm. Minting a working copy re-creates the same logical edges onto a new
   * version row — nobody edited anything, so nothing is emitted.
   */
  it('the version-carry path produces zero relationship events', async () => {
    const parent = await part('vparent')
    const child = await part('vchild')
    await ItemRelationshipService.addRelationship(
      parent.id,
      child.id,
      'BOM',
      user.id,
      { quantity: '1.000' },
    )
    const before = await structureEvents(parent.id)
    expect(before).toHaveLength(1)

    // Check the parent out onto a branch and save, which mints a working copy
    // and carries its edges across.
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: `Structure ECO ${prefix}`,
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Structure',
      } as any,
      user.id,
    )
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      eco.id,
      user.id,
    )
    await CheckoutService.checkout(
      { branchId: branch.id, itemMasterId: parent.masterId! },
      user.id,
    )
    await CheckoutService.saveChanges(
      {
        branchId: branch.id,
        itemId: parent.id,
        changes: { name: 'Renamed parent' },
        commitMessage: 'Mint the working copy',
      },
      user.id,
    )

    // Still exactly the one hand-edited add, on the original row — and nothing
    // at all on the working copy, whose edges were carried rather than created.
    expect(await structureEvents(parent.id)).toHaveLength(1)
    const all = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        inArray(domainEvents.type, [
          'relationship.added',
          'relationship.removed',
          'relationship.updated',
        ]),
      )
    expect(all).toHaveLength(1)
  })
})
