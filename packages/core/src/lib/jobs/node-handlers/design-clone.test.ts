// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design Clone Handler Tests
 *
 * Cloning a design copies every item on its main branch into a new design,
 * which makes it gate 1: a field that silently fails to carry over ships a
 * design whose parts disagree with the ones they were cloned from, and
 * nothing reports it. The handler used to copy a Part's extension row from a
 * hand-written column list that had drifted from the schema — `trackingMode`
 * was missing, so every serial- or lot-tracked part came out of a clone
 * reset to `none`.
 *
 * Run: npm run test -- src/lib/jobs/node-handlers/design-clone.test.ts
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
import { cloneDesignHandler } from './design-clone'
import type { JobContext } from '../types'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { itemVersions, items, parts, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { DesignService } from '@/lib/services/DesignService'
import { LifecycleService } from '@/lib/services/LifecycleService'

import '@/lib/items/registerItemTypes.server'

/** A context that records nothing — progress and log calls are not under test. */
function jobContext(): JobContext {
  return {
    jobId: randomUUID(),
    attempt: 1,
    updateProgress: () => Promise.resolve(),
    log: {
      debug: () => Promise.resolve(),
      info: () => Promise.resolve(),
      warn: () => Promise.resolve(),
      error: () => Promise.resolve(),
    },
    signal: new AbortController().signal,
  }
}

describe('cloneDesignHandler', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    // The handler starts every clone at its type's initial lifecycle state,
    // read through the registry — which must hold the links global-setup seeded.
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `DC${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Clone Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('clones a part with its whole extension row, trackingMode included', async () => {
    const source = await DesignService.create(
      {
        programId,
        name: 'Source Design',
        code: `${uniquePrefix}-SRC`,
        designType: 'Engineering',
      },
      user.id,
    )
    const initialCommit = source.initialCommit
    if (!initialCommit) {
      throw new Error('An Engineering design is created with an initial commit')
    }

    // A part on the source's main branch, resolvable through the commit
    // graph — the shape a real design's contents take.
    const sourceItem = takeFirst(
      await testDb.db
        .insert(items)
        .values({
          masterId: randomUUID(),
          designId: source.id,
          itemNumber: `${uniquePrefix}-PART-001`,
          revision: 'A',
          itemType: 'Part',
          name: 'Serialized bracket',
          state: await LifecycleService.getInitialStateId('Part'),
          isCurrent: true,
          commitId: initialCommit.id,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning(),
    )
    await testDb.db.insert(itemVersions).values({
      itemId: sourceItem.id,
      commitId: initialCommit.id,
      changeType: 'added',
    })
    // Deliberately spans every parts column, with `trackingMode` — the one
    // the hand-written copy forgot — set away from its default.
    await testDb.db.insert(parts).values({
      itemId: sourceItem.id,
      description: 'Bracket, machined',
      partType: 'Manufacture',
      trackingMode: 'serial',
      material: '6061-T6',
      weight: '1.250',
      weightUnit: 'kg',
      cost: '42.50',
      costCurrency: 'USD',
      leadTimeDays: 14,
    })

    const result = await cloneDesignHandler.execute(
      {
        sourceDesignId: source.id,
        targetCode: `${uniquePrefix}-TGT`,
        targetName: 'Cloned Design',
        userId: user.id,
      },
      jobContext(),
    )

    expect(result.itemsCloned).toBe(1)

    const clonedItem = takeFirst(
      await testDb.db
        .select()
        .from(items)
        .where(
          and(eq(items.designId, result.designId), eq(items.itemType, 'Part')),
        ),
    )
    expect(clonedItem.usageOf).toBe(sourceItem.id)

    const sourcePart = takeFirst(
      await testDb.db
        .select()
        .from(parts)
        .where(eq(parts.itemId, sourceItem.id)),
    )
    const clonedPart = takeFirst(
      await testDb.db
        .select()
        .from(parts)
        .where(eq(parts.itemId, clonedItem.id)),
    )

    // The named regression: a serial-tracked part used to come out of a
    // clone as `none`.
    expect(clonedPart.trackingMode).toBe('serial')

    // The invariant behind it: the clone's row is the source's row, keyed to
    // the new item. Any parts column that fails to copy — including ones
    // added after this was written — fails here.
    expect({ ...clonedPart, itemId: sourceItem.id }).toEqual(sourcePart)
  })
})
