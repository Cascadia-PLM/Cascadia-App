// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * NumberingService Tests
 *
 * Item numbers are an identity guarantee: two items must never be handed the
 * same one. That holds only because allocation runs on its own connection and
 * commits immediately, independent of whether the caller's transaction
 * survives — which is what these tests pin.
 *
 * Run: npm run test -- src/lib/items/numbering/NumberingService.test.ts
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
import { NumberingService } from './NumberingService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { numberSequences } from '@/lib/db/schema/numbering'

describe('NumberingService', () => {
  const testDb = new TestDatabase()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    // Leave no sequence rows behind: allocation deliberately outlives the test
    // transaction, so nothing else cleans these up.
    await testDb.db
      .delete(numberSequences)
      .where(eq(numberSequences.itemType, 'NumberingTest'))
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** Allocate against a scheme-free type, straight through the sequence. */
  async function reserve(): Promise<number> {
    return (
      NumberingService as unknown as {
        getNextSequence: (
          itemType: string,
          scopeKey: string,
          startAt: number,
        ) => Promise<number>
      }
    ).getNextSequence('NumberingTest', 'NumberingTest', 1)
  }

  it('never hands the same number out twice', async () => {
    const first = await reserve()
    const second = await reserve()
    const third = await reserve()

    expect(new Set([first, second, third]).size).toBe(3)
    expect(second).toBe(first + 1)
    expect(third).toBe(second + 1)
  })

  it('does not give a reserved number back when the caller rolls back', async () => {
    const reservedThenAbandoned = await reserve()

    // The surrounding test transaction is discarded here, exactly as a failed
    // item creation would be.
    await testDb.rollback()
    await testDb.beginTransaction()

    const afterRollback = await reserve()

    // A gap is fine; a repeat is not. If allocation rode the caller's
    // transaction this would come back equal, and two items created either
    // side of a failure would collide on item_number.
    expect(afterRollback).toBeGreaterThan(reservedThenAbandoned)
  })

  it('generates a distinct number per call for a real item type', async () => {
    const first = await NumberingService.generate('Part')
    const second = await NumberingService.generate('Part')

    expect(first).not.toBe(second)
    expect(first).toMatch(/^PN-\d+$/)
  })
})
