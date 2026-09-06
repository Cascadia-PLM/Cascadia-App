// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `bomStructureOf` is the one comparator the merge pre-flight and conflict
 * detection share. If it cannot tell two structures apart, a divergence
 * between them merges silently, so what it hashes is an invariant.
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
import { bomStructureOf } from './item-structure'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'
import { itemRelationships } from '@/lib/db/schema'

describe('bomStructureOf', () => {
  const testDb = new TestDatabase()
  let userId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    userId = (await insertTestUser(testDb.db)).id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('distinguishes two structures that differ only in a line option', async () => {
    const parentA = await insertTestPart(testDb.db, null, userId)
    const parentB = await insertTestPart(testDb.db, null, userId)
    const child = await insertTestPart(testDb.db, null, userId)

    await testDb.db.insert(itemRelationships).values([
      {
        sourceId: parentA.item.id,
        targetId: child.item.id,
        relationshipType: 'BOM',
        quantity: '1',
        createdBy: userId,
      },
      {
        sourceId: parentB.item.id,
        targetId: child.item.id,
        relationshipType: 'BOM',
        quantity: '1',
        option: { all: [{ family: 'color', values: ['black'] }] },
        createdBy: userId,
      },
    ])

    const [a, b] = await Promise.all([
      bomStructureOf(parentA.item.id, testDb.db),
      bomStructureOf(parentB.item.id, testDb.db),
    ])
    expect(a.lineCount).toBe(1)
    expect(b.lineCount).toBe(1)
    expect(a.signature).not.toBe(b.signature)
  })

  it('gives the same signature to one option written in two orders', async () => {
    const parentA = await insertTestPart(testDb.db, null, userId)
    const parentB = await insertTestPart(testDb.db, null, userId)
    const child = await insertTestPart(testDb.db, null, userId)

    await testDb.db.insert(itemRelationships).values([
      {
        sourceId: parentA.item.id,
        targetId: child.item.id,
        relationshipType: 'BOM',
        quantity: '1',
        option: {
          all: [
            { family: 'color', values: ['black', 'white'] },
            { family: 'display', values: ['yes'] },
          ],
        },
        createdBy: userId,
      },
      {
        sourceId: parentB.item.id,
        targetId: child.item.id,
        relationshipType: 'BOM',
        quantity: '1',
        option: {
          all: [
            { family: 'display', values: ['yes'] },
            { family: 'color', values: ['white', 'black'] },
          ],
        },
        createdBy: userId,
      },
    ])

    const [a, b] = await Promise.all([
      bomStructureOf(parentA.item.id, testDb.db),
      bomStructureOf(parentB.item.id, testDb.db),
    ])
    expect(a.signature).toBe(b.signature)
  })
})
