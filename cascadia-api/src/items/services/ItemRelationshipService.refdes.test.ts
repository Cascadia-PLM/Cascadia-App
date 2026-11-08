// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Reference designators on BOM lines: they are part of a BOM edge's identity,
 * so one child can sit on a parent at R1 and at R2 as two lines, while the
 * same position twice is still one line twice. Compared as stored, trimmed
 * and with a blank meaning none — and only on BOM lines.
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
import { DesignService } from '@/services/DesignService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'
import { itemRelationships, programs } from '@/db/schema'
import { ItemTypeRegistry } from '@/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/db/take-first'
import { AlreadyExistsError, ValidationError } from '@/errors'

// Import to register item types
import '@/items/registerItemTypes.server'

const guard = { bypassEditGuard: true }

describe('ItemRelationshipService reference designators', () => {
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
          name: 'Reference designators',
          code: `PROG-${suffix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Controller board',
        code: `CB-${suffix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function parentAndChild() {
    const parent = await insertTestPart(testDb.db, designId, user.id)
    const child = await insertTestPart(testDb.db, designId, user.id)
    return { parentId: parent.item.id, childId: child.item.id }
  }

  async function linesOf(sourceId: string) {
    return testDb.db
      .select()
      .from(itemRelationships)
      .where(eq(itemRelationships.sourceId, sourceId))
  }

  it('places one child at two designators, but not at one designator twice', async () => {
    const { parentId, childId } = await parentAndChild()

    const r1 = await ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      { quantity: '1', referenceDesignator: 'R1' },
      guard,
    )
    const r2 = await ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      { quantity: '1', referenceDesignator: 'R2' },
      guard,
    )
    expect(r1.id).not.toBe(r2.id)

    // Padding is not a different position.
    await expect(
      ItemRelationshipService.addRelationship(
        parentId,
        childId,
        'BOM',
        user.id,
        { quantity: '1', referenceDesignator: ' R1 ' },
        guard,
      ),
    ).rejects.toBeInstanceOf(AlreadyExistsError)

    expect(await linesOf(parentId)).toHaveLength(2)
  })

  it('treats a blank designator as none', async () => {
    const { parentId, childId } = await parentAndChild()

    const line = await ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      { quantity: '4', referenceDesignator: '   ' },
      guard,
    )
    expect(line.referenceDesignator).toBeNull()

    await expect(
      ItemRelationshipService.addRelationship(
        parentId,
        childId,
        'BOM',
        user.id,
        { quantity: '4' },
        guard,
      ),
    ).rejects.toBeInstanceOf(AlreadyExistsError)

    // A labelled line beside the unlabelled one is a different line.
    await ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      { quantity: '1', referenceDesignator: 'C9' },
      guard,
    )
    expect(await linesOf(parentId)).toHaveLength(2)
  })

  it('does not tell two non-BOM links apart by designator', async () => {
    const { parentId, childId } = await parentAndChild()

    await ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'Reference',
      user.id,
      { referenceDesignator: 'X1' },
      guard,
    )
    await expect(
      ItemRelationshipService.addRelationship(
        parentId,
        childId,
        'Reference',
        user.id,
        { referenceDesignator: 'X2' },
        guard,
      ),
    ).rejects.toBeInstanceOf(AlreadyExistsError)
  })

  it('accepts a batch placing one child at several designators, and refuses one repeating a designator', async () => {
    const { parentId, childId } = await parentAndChild()
    const line = (referenceDesignator: string) => ({
      sourceId: parentId,
      targetId: childId,
      relationshipType: 'BOM',
      userId: user.id,
      data: { quantity: '1', referenceDesignator },
    })

    await expect(
      ItemRelationshipService.addRelationshipBatch(
        [line('C1'), line('C2'), line('C1 ')],
        { ...guard, skipHistory: true },
      ),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(await linesOf(parentId)).toHaveLength(0)

    const inserted = await ItemRelationshipService.addRelationshipBatch(
      [line('C1'), line(' C2'), line('C3')],
      { ...guard, skipHistory: true },
    )
    expect(inserted.map((row) => row.referenceDesignator).sort()).toEqual([
      'C1',
      'C2',
      'C3',
    ])
  })

  it("refuses to move a line onto a sibling's designator, and stores a new one trimmed", async () => {
    const { parentId, childId } = await parentAndChild()
    await ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      { quantity: '1', referenceDesignator: 'U1' },
      guard,
    )
    const second = await ItemRelationshipService.addRelationship(
      parentId,
      childId,
      'BOM',
      user.id,
      { quantity: '1', referenceDesignator: 'U2' },
      guard,
    )

    await expect(
      ItemRelationshipService.updateRelationship(
        second.id,
        user.id,
        { referenceDesignator: 'U1 ' },
        guard,
      ),
    ).rejects.toBeInstanceOf(AlreadyExistsError)

    const moved = await ItemRelationshipService.updateRelationship(
      second.id,
      user.id,
      { referenceDesignator: '  U3' },
      guard,
    )
    expect(moved.referenceDesignator).toBe('U3')
  })

  it('carries every line of a repeated child onto a copy of the structure', async () => {
    const { parentId, childId } = await parentAndChild()
    const copy = await insertTestPart(testDb.db, designId, user.id)
    for (const referenceDesignator of ['R1', 'R2']) {
      await ItemRelationshipService.addRelationship(
        parentId,
        childId,
        'BOM',
        user.id,
        { quantity: '1', referenceDesignator },
        guard,
      )
    }

    await ItemRelationshipService.copyRelationshipsToItem({
      sourceItemId: parentId,
      targetItemId: copy.item.id,
      userId: user.id,
    })

    const copied = await linesOf(copy.item.id)
    expect(copied.map((row) => row.referenceDesignator).sort()).toEqual([
      'R1',
      'R2',
    ])
  })
})
