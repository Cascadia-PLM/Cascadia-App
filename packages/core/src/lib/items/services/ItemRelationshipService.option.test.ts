// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Product variants on BOM lines: the option condition is part of an edge's
 * identity, it may only name families the parent part declares, and it
 * survives the copies that carry a structure between versions.
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
import { ItemRelationshipService } from './ItemRelationshipService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { OptionModel } from '@/lib/types/variants'
import { DesignService } from '@/lib/services/DesignService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'
import { itemRelationships, parts, programs } from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
import { AlreadyExistsError, ValidationError } from '@/lib/errors'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

const colourModel: OptionModel = {
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
}

const black = { all: [{ family: 'color', values: ['black'] }] }
const white = { all: [{ family: 'color', values: ['white'] }] }

describe('ItemRelationshipService option conditions', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

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
    const suffix =
      `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Variants',
          code: `PROG-${suffix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Touch switch',
        code: `TS-${suffix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function configurablePart() {
    const parent = await insertTestPart(testDb.db, designId, user.id)
    await testDb.db
      .update(parts)
      .set({ optionModel: colourModel })
      .where(eq(parts.itemId, parent.item.id))
    return parent.item
  }

  it('lets one child appear under two conditions but not twice under one', async () => {
    const parent = await configurablePart()
    const housing = await insertTestPart(testDb.db, designId, user.id)

    const first = await ItemRelationshipService.addRelationship(
      parent.id,
      housing.item.id,
      'BOM',
      user.id,
      { quantity: '1', option: black },
      { bypassEditGuard: true },
    )
    const second = await ItemRelationshipService.addRelationship(
      parent.id,
      housing.item.id,
      'BOM',
      user.id,
      { quantity: '2', option: white },
      { bypassEditGuard: true },
    )
    expect(first.id).not.toBe(second.id)

    await expect(
      ItemRelationshipService.addRelationship(
        parent.id,
        housing.item.id,
        'BOM',
        user.id,
        // Same condition, written in a different order: the same edge.
        {
          quantity: '3',
          option: { all: [{ family: 'COLOR', values: ['black'] }] },
        },
        { bypassEditGuard: true },
      ),
    ).rejects.toBeInstanceOf(AlreadyExistsError)
  })

  it('still refuses a duplicate fixed line', async () => {
    const parent = await configurablePart()
    const pcb = await insertTestPart(testDb.db, designId, user.id)
    await ItemRelationshipService.addRelationship(
      parent.id,
      pcb.item.id,
      'BOM',
      user.id,
      { quantity: '1' },
      { bypassEditGuard: true },
    )
    await expect(
      ItemRelationshipService.addRelationship(
        parent.id,
        pcb.item.id,
        'BOM',
        user.id,
        { quantity: '1' },
        { bypassEditGuard: true },
      ),
    ).rejects.toBeInstanceOf(AlreadyExistsError)
  })

  it('rejects a condition the parent does not declare', async () => {
    const parent = await configurablePart()
    const glass = await insertTestPart(testDb.db, designId, user.id)

    await expect(
      ItemRelationshipService.addRelationship(
        parent.id,
        glass.item.id,
        'BOM',
        user.id,
        { option: { all: [{ family: 'display', values: ['yes'] }] } },
        { bypassEditGuard: true },
      ),
    ).rejects.toBeInstanceOf(ValidationError)

    await expect(
      ItemRelationshipService.addRelationship(
        parent.id,
        glass.item.id,
        'BOM',
        user.id,
        { option: { all: [{ family: 'color', values: ['red'] }] } },
        { bypassEditGuard: true },
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a condition on a parent with no option model', async () => {
    const plain = await insertTestPart(testDb.db, designId, user.id)
    const child = await insertTestPart(testDb.db, designId, user.id)
    await expect(
      ItemRelationshipService.addRelationship(
        plain.item.id,
        child.item.id,
        'BOM',
        user.id,
        { option: black },
        { bypassEditGuard: true },
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('updates a condition, and refuses one that collides with a sibling line', async () => {
    const parent = await configurablePart()
    const housing = await insertTestPart(testDb.db, designId, user.id)
    const blackLine = await ItemRelationshipService.addRelationship(
      parent.id,
      housing.item.id,
      'BOM',
      user.id,
      { option: black },
      { bypassEditGuard: true },
    )
    const whiteLine = await ItemRelationshipService.addRelationship(
      parent.id,
      housing.item.id,
      'BOM',
      user.id,
      { option: white },
      { bypassEditGuard: true },
    )

    await expect(
      ItemRelationshipService.updateRelationship(
        whiteLine.id,
        user.id,
        { option: black },
        { bypassEditGuard: true },
      ),
    ).rejects.toBeInstanceOf(AlreadyExistsError)

    const fixed = await ItemRelationshipService.updateRelationship(
      blackLine.id,
      user.id,
      { option: null },
      { bypassEditGuard: true },
    )
    expect(fixed.option).toBeNull()
  })

  it('carries the condition onto a copy of the structure', async () => {
    const parent = await configurablePart()
    const copy = await insertTestPart(testDb.db, designId, user.id)
    const housing = await insertTestPart(testDb.db, designId, user.id)
    await ItemRelationshipService.addRelationship(
      parent.id,
      housing.item.id,
      'BOM',
      user.id,
      { quantity: '1', option: black },
      { bypassEditGuard: true },
    )

    await ItemRelationshipService.copyRelationshipsToItem({
      sourceItemId: parent.id,
      targetItemId: copy.item.id,
      userId: user.id,
    })

    const copied = await testDb.db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, copy.item.id))
    expect(copied).toHaveLength(1)
    expect(copied[0]?.option).toEqual(black)
  })
})
